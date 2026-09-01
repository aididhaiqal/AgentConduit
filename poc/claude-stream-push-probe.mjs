#!/usr/bin/env node

/*
 * Disposable, provider-specific capability probe.
 *
 * This file has three modes:
 *
 *   node poc/claude-stream-push-probe.mjs
 *
 *     Starts a Claude Code --print/stream-json process, sends one user message,
 *     waits until Claude emits a call to the probe MCP tool, then writes one
 *     more (valid JSONL) user message while that tool is running.
 *
 *   node poc/claude-stream-push-probe.mjs --idle
 *
 *     Starts the same isolated stream process, waits for the first turn to
 *     finish, then writes a second user message during an idle gap. This tests
 *     whether a bridge-owned stream can start another turn without a tool call.
 *
 *   node poc/claude-stream-push-probe.mjs --probe-server
 *
 *     Internal stdio MCP server used by the first mode.  It is intentionally
 *     kept in this file so the server is resolved from this checkout's
 *     dependencies and does not need a generated source file.
 *
 * The live mode is deliberately opt-in.  It never reads, copies, or symlinks
 * credentials.  Claude inherits whatever authentication the caller has
 * already configured; all probe state is written to a fresh temporary folder.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let McpServer;
let StdioServerTransport;
try {
  ({ McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js"));
  ({ StdioServerTransport } =
    await import("@modelcontextprotocol/sdk/server/stdio.js"));
} catch {
  // The root workspace intentionally has no runtime dependency on the MCP SDK;
  // resolve the server package's workspace dependency when this POC is run
  // directly from the checkout.
  ({ McpServer } = await import(
    new URL(
      "../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js",
      import.meta.url,
    )
  ));
  ({ StdioServerTransport } = await import(
    new URL(
      "../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js",
      import.meta.url,
    )
  ));
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SERVER_NAME = "agentconduit_push_probe";
const PROBE_TOOL_NAME = "claude_push_wait";
const ALLOWED_TOOL_NAME = `mcp__${SERVER_NAME}__${PROBE_TOOL_NAME}`;
const ACK_TEXT = "ACTIVE_PUSH_ACK";
const IDLE_ACK_TEXT = "IDLE_PUSH_ACK";
const FIRST_TURN_TEXT = "FIRST_TURN_DONE";
const ACTIVE_MODE = "active";
const IDLE_MODE = "idle";
const LIVE_FLAG = "AGENTCONDUIT_RUN_CLAUDE_POC";
const PROBE_FLAG = "AGENTCONDUIT_CLAUDE_POC_PROBE";

const HELP = `
Claude Code stream-json push POC

This is a real API call and is disabled unless ${LIVE_FLAG}=1 is set.

The default active mode steers a tool call in progress. Pass --idle (or set
AGENTCONDUIT_CLAUDE_POC_MODE=idle) to test whether a bridge-owned process
accepts a second line after the first turn has completed.

Run (from the AgentConduit checkout):

  ${LIVE_FLAG}=1 node poc/claude-stream-push-probe.mjs
  ${LIVE_FLAG}=1 node poc/claude-stream-push-probe.mjs --idle

Useful environment variables:

  AGENTCONDUIT_CLAUDE_COMMAND              Claude executable (default: claude)
  AGENTCONDUIT_CLAUDE_ARGS_JSON            JSON array of safe --key=value args
  AGENTCONDUIT_CLAUDE_MODEL                Optional model/alias
  AGENTCONDUIT_CLAUDE_BUDGET_USD           Optional --max-budget-usd cap (default: 0.25)
  AGENTCONDUIT_CLAUDE_POC_EVIDENCE_PARENT  Parent directory for retained evidence
  AGENTCONDUIT_CLAUDE_POC_TIMEOUT_MS       Overall timeout (default: 120000)
  AGENTCONDUIT_CLAUDE_POC_STARTUP_MS       Init timeout (default: 45000)
  AGENTCONDUIT_CLAUDE_POC_TOOL_DELAY_MS    MCP wait duration (default: 8000)
  AGENTCONDUIT_CLAUDE_POC_IDLE_DELAY_MS    Idle gap before the second line (default: 2000)
  AGENTCONDUIT_CLAUDE_POC_SHUTDOWN_MS     Shutdown grace period (default: 5000)
  AGENTCONDUIT_CLAUDE_POC_MCP_COMMAND      Override the MCP probe launcher
  AGENTCONDUIT_CLAUDE_POC_MCP_ARGS_JSON    JSON array of launcher args

The harness writes only redacted event metadata (not prompts, credentials,
session IDs, or raw model output). Use --dry-run to inspect the launch shape
without making an API call. The --probe-server mode is internal and requires
${PROBE_FLAG}=1.
`;

function timestamp() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function appendJsonLine(filePath, value) {
  appendFileSync(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function writePrivateJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  // chmod is useful on POSIX and harmless on platforms that ignore mode bits.
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort only; the containing temporary directory is private.
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function environmentValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function parseBoundedInteger(name, fallback, minimum, maximum) {
  const raw = environmentValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function parseOptionalBudget() {
  const raw = environmentValue(
    "AGENTCONDUIT_CLAUDE_BUDGET_USD",
    "CLAUDE_PUSH_POC_BUDGET_USD",
  );
  if (raw === undefined) return 0.25;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error(
      "AGENTCONDUIT_CLAUDE_BUDGET_USD must be a number greater than 0 and at most 100",
    );
  }
  return value;
}

function parseJsonStringArray(name) {
  const raw = environmentValue(name);
  if (raw === undefined) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must contain a JSON array of strings`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string" || item.includes("\u0000"))
  ) {
    throw new Error(`${name} must contain a JSON array of strings`);
  }
  return parsed;
}

function parseClaudeExtraArgs() {
  const values = parseJsonStringArray("AGENTCONDUIT_CLAUDE_ARGS_JSON");
  const forbidden = new Set([
    "-c",
    "--continue",
    "-r",
    "--resume",
    "--cloud",
    "--environment",
    "--remote-control",
    "--worktree",
    "--from-pr",
    "--teleport",
    "--session-id",
    "--mcp-config",
    "--settings",
    "--input-format",
    "--output-format",
    "--no-session-persistence",
    "--print",
    "--tools",
    "--allowed-tools",
    "--permission-mode",
  ]);
  for (const value of values) {
    if (!value.startsWith("-") || forbidden.has(value.split("=", 1)[0])) {
      throw new Error(
        "AGENTCONDUIT_CLAUDE_ARGS_JSON may contain only safe option/value pairs; session, prompt, transport, and tool options are controlled by the harness",
      );
    }
  }
  return values;
}

function recordEvent(filePath, event, fields = {}) {
  appendJsonLine(filePath, { at: timestamp(), event, ...fields });
}

function requireOptIn() {
  if (process.env[LIVE_FLAG] !== "1") {
    throw new Error(
      `Refusing to start Claude or make an API call. Set ${LIVE_FLAG}=1 explicitly (or use --dry-run).`,
    );
  }
}

function parseProbeDelay(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 120_000) {
    throw new Error(`${name} must be an integer between 0 and 120000`);
  }
  return value;
}

function parseMode(args = []) {
  const envMode = environmentValue("AGENTCONDUIT_CLAUDE_POC_MODE");
  const idleFlag = args.includes("--idle");
  if (args.includes("--active") && idleFlag) {
    throw new Error("--active and --idle cannot be used together");
  }
  if (
    envMode !== undefined &&
    envMode !== ACTIVE_MODE &&
    envMode !== IDLE_MODE
  ) {
    throw new Error(
      `AGENTCONDUIT_CLAUDE_POC_MODE must be ${ACTIVE_MODE} or ${IDLE_MODE}`,
    );
  }
  if (idleFlag) return IDLE_MODE;
  if (args.includes("--active")) return ACTIVE_MODE;
  return envMode ?? ACTIVE_MODE;
}

function sanitizeMcpServers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "unknown",
      status: typeof entry.status === "string" ? entry.status : "unknown",
    }));
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item) => item && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function isProbeToolName(value) {
  return (
    value === ALLOWED_TOOL_NAME ||
    (typeof value === "string" && value.endsWith(`__${PROBE_TOOL_NAME}`))
  );
}

function isProbeToolUse(value) {
  if (!value || typeof value !== "object") return false;
  if (value.type === "assistant") {
    const content = value.message?.content ?? value.content;
    return (
      Array.isArray(content) &&
      content.some(
        (item) => item?.type === "tool_use" && isProbeToolName(item.name),
      )
    );
  }
  if (value.type === "stream_event" && value.event === "content_block_start") {
    const block = value.content_block;
    return block?.type === "tool_use" && isProbeToolName(block.name);
  }
  return false;
}

function commandPath(command) {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }
  try {
    return execFileSync("which", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")[0];
  } catch {
    return command;
  }
}

function looksLikeWindowsCommand(command) {
  const lower = command.toLowerCase();
  if (/\.(?:exe|cmd|bat)$/.test(lower) || lower.includes("\\")) return true;
  const resolved = commandPath(command);
  if (!resolved || !existsSync(resolved)) return false;
  try {
    // A Windows npm shim is a shell script that execs *.exe. Reading only the
    // first few KiB avoids treating arbitrary command output as configuration.
    return readFileSync(resolved, "utf8").slice(0, 4096).includes(".exe");
  } catch {
    return false;
  }
}

function hasCommand(command) {
  try {
    execFileSync("which", [command], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function chooseMcpLauncher(claudeCommand, customCommand, customArgs) {
  if (customCommand) {
    const windowsClient = looksLikeWindowsCommand(claudeCommand);
    return {
      command: customCommand,
      args:
        customArgs.length > 0 ? customArgs : [SCRIPT_PATH, "--probe-server"],
      pathStyle: "as-configured",
      windowsClient,
    };
  }

  const claudeIsWindows = looksLikeWindowsCommand(claudeCommand);
  // When this script runs under WSL but Claude is a Windows executable, wsl.exe
  // keeps the probe server on the same Linux filesystem and avoids copying or
  // translating the repository (and its node_modules) into a Windows directory.
  if (
    claudeIsWindows &&
    process.platform !== "win32" &&
    hasCommand("wsl.exe")
  ) {
    return {
      command: "wsl.exe",
      args: ["node", SCRIPT_PATH, "--probe-server"],
      pathStyle: "wsl",
      windowsClient: true,
    };
  }

  return {
    command: process.execPath,
    args: [SCRIPT_PATH, "--probe-server"],
    pathStyle: "native",
    windowsClient: claudeIsWindows,
  };
}

function createEvidenceRoot(mode) {
  const parent = resolve(
    environmentValue("AGENTCONDUIT_CLAUDE_POC_EVIDENCE_PARENT") ?? tmpdir(),
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const evidenceRoot = mkdtempSync(
    join(
      parent,
      `agentconduit-claude-${mode === IDLE_MODE ? "idle-push" : "stream-push"}-`,
    ),
  );
  try {
    chmodSync(evidenceRoot, 0o700);
  } catch {
    // Best effort on Windows.
  }
  const cwd = join(evidenceRoot, "cwd");
  const config = join(evidenceRoot, "config");
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(config, { mode: 0o700 });
  return { evidenceRoot, cwd, config };
}

function buildConfiguration(paths, mode) {
  const claudeCommand =
    environmentValue(
      "AGENTCONDUIT_CLAUDE_COMMAND",
      "CLAUDE_PUSH_POC_COMMAND",
    ) ?? "claude";
  const claudeArgs = parseClaudeExtraArgs();
  const model = environmentValue(
    "AGENTCONDUIT_CLAUDE_MODEL",
    "CLAUDE_PUSH_POC_MODEL",
  );
  const budgetUsd = parseOptionalBudget();
  const timeoutMs = parseBoundedInteger(
    "AGENTCONDUIT_CLAUDE_POC_TIMEOUT_MS",
    120_000,
    5_000,
    600_000,
  );
  const startupMs = parseBoundedInteger(
    "AGENTCONDUIT_CLAUDE_POC_STARTUP_MS",
    45_000,
    5_000,
    300_000,
  );
  const shutdownMs = parseBoundedInteger(
    "AGENTCONDUIT_CLAUDE_POC_SHUTDOWN_MS",
    5_000,
    500,
    30_000,
  );
  const toolDelayMs = parseProbeDelay(
    "AGENTCONDUIT_CLAUDE_POC_TOOL_DELAY_MS",
    8_000,
  );
  const notificationDelayMs = parseProbeDelay(
    "AGENTCONDUIT_CLAUDE_POC_NOTIFICATION_DELAY_MS",
    1_000,
  );
  const idleDelayMs = parseProbeDelay(
    "AGENTCONDUIT_CLAUDE_POC_IDLE_DELAY_MS",
    2_000,
  );

  const customMcpCommand = environmentValue(
    "AGENTCONDUIT_CLAUDE_POC_MCP_COMMAND",
  );
  const customMcpArgs = parseJsonStringArray(
    "AGENTCONDUIT_CLAUDE_POC_MCP_ARGS_JSON",
  );
  const launcher = chooseMcpLauncher(
    claudeCommand,
    customMcpCommand,
    customMcpArgs,
  );
  if (launcher.pathStyle === "wsl") {
    // WSL does not import arbitrary Windows environment variables unless they
    // are listed in WSLENV. Use /usr/bin/env arguments instead, so the probe
    // receives its guard and log path without changing the user's WSLENV.
    launcher.args = [
      "env",
      `${PROBE_FLAG}=1`,
      `AGENTCONDUIT_CLAUDE_POC_PROBE_LOG=${paths.probeEvents}`,
      `AGENTCONDUIT_CLAUDE_POC_PROBE_TOOL_DELAY_MS=${toolDelayMs}`,
      `AGENTCONDUIT_CLAUDE_POC_PROBE_NOTIFICATION_DELAY_MS=${notificationDelayMs}`,
      "node",
      SCRIPT_PATH,
      "--probe-server",
    ];
  }
  const probeEnv = {
    [PROBE_FLAG]: "1",
    AGENTCONDUIT_CLAUDE_POC_PROBE_LOG: paths.probeEvents,
    AGENTCONDUIT_CLAUDE_POC_PROBE_TOOL_DELAY_MS: String(toolDelayMs),
    AGENTCONDUIT_CLAUDE_POC_PROBE_NOTIFICATION_DELAY_MS:
      String(notificationDelayMs),
  };
  const mcpConfig =
    mode === IDLE_MODE
      ? { mcpServers: {} }
      : {
          mcpServers: {
            [SERVER_NAME]: {
              command: launcher.command,
              args: launcher.args,
              env: probeEnv,
            },
          },
        };

  const claudeArgsFinal = [
    ...claudeArgs,
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config",
    // Inline JSON works for both a native Windows Claude process and a
    // non-Windows process. Passing a WSL path as a Windows file argument makes
    // Claude attempt a stat() through the wrong filesystem boundary.
    JSON.stringify(mcpConfig),
    "--settings",
    JSON.stringify({}),
    "--no-session-persistence",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
  ];
  if (mode === ACTIVE_MODE) {
    claudeArgsFinal.push("--allowed-tools", ALLOWED_TOOL_NAME);
  }
  if (model) claudeArgsFinal.push("--model", model);
  if (budgetUsd !== undefined) {
    claudeArgsFinal.push("--max-budget-usd", String(budgetUsd));
  }

  return {
    claudeCommand,
    claudeArgs: claudeArgsFinal,
    mode,
    model: model ?? null,
    budgetUsd,
    timeoutMs,
    startupMs,
    shutdownMs,
    toolDelayMs,
    notificationDelayMs,
    idleDelayMs,
    mcpConfig,
    launcher,
  };
}

function writeUserLine(child, inputEventsPath, label, content) {
  const wire = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content,
    },
  });
  // Round-trip parse before touching stdin. This guards against accidental
  // logging text or shell timestamps being mixed into Claude's JSONL protocol.
  const parsed = JSON.parse(wire);
  if (
    parsed.type !== "user" ||
    parsed.message?.role !== "user" ||
    typeof parsed.message.content !== "string" ||
    wire.includes("\n")
  ) {
    throw new Error("internal JSONL validation failed");
  }
  if (!child.stdin.writable || child.stdin.destroyed) {
    throw new Error("Claude stdin is not writable");
  }
  child.stdin.write(`${wire}\n`);
  appendJsonLine(inputEventsPath, {
    at: timestamp(),
    event: "jsonl_sent",
    label,
    valid: true,
    bytes: Buffer.byteLength(wire) + 1,
    sha256: sha256(wire),
  });
}

function firstPrompt(mode) {
  if (mode === IDLE_MODE) {
    return [
      "This is a controlled transport experiment in an empty temporary directory.",
      "Do not call any tools.",
      `Reply ${FIRST_TURN_TEXT} only, then keep the stream open for a possible follow-up user message.`,
    ].join(" ");
  }
  return [
    "This is a controlled transport experiment in an empty temporary directory.",
    `Call the MCP tool ${ALLOWED_TOOL_NAME} exactly once now.`,
    "It will wait briefly and return TOOL_RETURNED.",
    `When that tool returns, reply ${FIRST_TURN_TEXT} only.`,
    "A second user message may arrive while the tool is running.",
    "If it arrives, process it as the newest instruction and follow its acknowledgement requirement.",
  ].join(" ");
}

function secondPrompt(mode, marker) {
  if (mode === IDLE_MODE) {
    return [
      `EXTERNAL_IDLE_PUSH_MARKER ${marker}.`,
      "This message was delivered by the coordinator after your first turn completed, while the stream remained open.",
      `Process this message and reply ${IDLE_ACK_TEXT} only.`,
    ].join(" ");
  }
  return [
    `EXTERNAL_ACTIVE_PUSH_MARKER ${marker}.`,
    "This message was delivered by the coordinator while your MCP tool call is still running.",
    `Process this message when possible and reply ${ACK_TEXT} only.`,
  ].join(" ");
}

function runClaude(config, paths, eventsPath, inputEventsPath) {
  return new Promise((resolvePromise) => {
    const idleMode = config.mode === IDLE_MODE;
    const expectedAck = idleMode ? IDLE_ACK_TEXT : ACK_TEXT;
    const state = {
      mode: config.mode,
      sawInit: false,
      sawToolUse: false,
      sentSecond: false,
      pushAttempted: false,
      firstResultBeforePush: false,
      firstResultSeen: false,
      firstResultCorrect: false,
      secondResultSeen: false,
      resultCount: 0,
      ackResult: false,
      ackAssistant: false,
      malformedOutput: 0,
      stderrBytes: 0,
      stderrHash: createHash("sha256"),
      stderrDigest: null,
      childExit: null,
      childSignal: null,
      closed: false,
      terminationRequested: false,
      failure: null,
      initVersion: null,
      initModel: null,
      probeServers: [],
    };

    const childEnv = {
      ...process.env,
      // Keep the stream machine-readable and avoid adding telemetry from this
      // disposable probe when the client honors the setting.
      NO_COLOR: "1",
      CLAUDE_CODE_DISABLE_TELEMETRY:
        process.env.CLAUDE_CODE_DISABLE_TELEMETRY ?? "1",
    };
    const child = spawn(config.claudeCommand, config.claudeArgs, {
      cwd: paths.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let outputRemainder = "";
    let shutdownTimer;
    let startupTimer;
    let overallTimer;
    let idlePushTimer;

    const finish = () => {
      if (state.closed) return;
      state.closed = true;
      clearTimeout(shutdownTimer);
      clearTimeout(startupTimer);
      clearTimeout(overallTimer);
      clearTimeout(idlePushTimer);
      const protocolSuccess = idleMode
        ? state.firstResultSeen &&
          state.firstResultCorrect &&
          state.sentSecond &&
          state.secondResultSeen &&
          state.resultCount === 2 &&
          state.ackResult
        : state.sawToolUse &&
          state.sentSecond &&
          state.resultCount === 1 &&
          !state.firstResultBeforePush &&
          state.ackResult;
      const success =
        state.childExit === 0 &&
        state.sawInit &&
        protocolSuccess &&
        state.malformedOutput === 0 &&
        !state.failure;
      resolvePromise({ ...state, success });
    };

    const closeInputGracefully = (reason) => {
      if (state.terminationRequested || state.closed) return;
      state.terminationRequested = true;
      clearTimeout(idlePushTimer);
      recordEvent(eventsPath, "stdin_end_requested", { reason });
      try {
        if (child.stdin.writable) child.stdin.end();
      } catch {
        // The child may already have closed its pipe.
      }
      shutdownTimer = setTimeout(() => {
        if (state.closed) return;
        recordEvent(eventsPath, "shutdown_forced", { reason });
        try {
          child.kill("SIGTERM");
        } catch {
          // A concurrently exiting process needs no further action.
        }
      }, config.shutdownMs);
    };

    const requestShutdown = (reason) => {
      if (state.terminationRequested || state.closed) return;
      state.terminationRequested = true;
      clearTimeout(idlePushTimer);
      recordEvent(eventsPath, "shutdown_requested", { reason });
      try {
        if (child.stdin.writable) child.stdin.end();
      } catch {
        // The child may already have closed its pipe.
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // The close event below remains authoritative.
      }
      shutdownTimer = setTimeout(() => {
        if (state.closed) return;
        recordEvent(eventsPath, "shutdown_forced", { reason });
        try {
          child.kill("SIGKILL");
        } catch {
          // A concurrently exiting process needs no further action.
        }
      }, config.shutdownMs);
    };

    const fail = (reason, fields = {}) => {
      if (!state.failure) {
        state.failure = reason;
        recordEvent(eventsPath, "failure", { reason, ...fields });
      }
      requestShutdown(reason);
    };

    const sendSecond = () => {
      if (state.pushAttempted) return;
      state.pushAttempted = true;
      const label = idleMode ? "idle_push" : "active_push";
      try {
        writeUserLine(
          child,
          inputEventsPath,
          label,
          secondPrompt(config.mode, paths.marker),
        );
        state.sentSecond = true;
        recordEvent(eventsPath, `${label}_sent`, {
          markerSha256: sha256(paths.marker),
        });
      } catch (error) {
        state.sentSecond = false;
        fail(`${label}_write_failed`, {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    };

    const scheduleIdlePush = () => {
      clearTimeout(idlePushTimer);
      idlePushTimer = setTimeout(() => {
        idlePushTimer = undefined;
        if (state.closed || state.terminationRequested) return;
        recordEvent(eventsPath, "idle_gap_elapsed", {
          delayMs: config.idleDelayMs,
        });
        sendSecond();
      }, config.idleDelayMs);
      recordEvent(eventsPath, "idle_gap_started", {
        delayMs: config.idleDelayMs,
      });
    };

    const handleObject = (value) => {
      if (!value || typeof value !== "object") return;
      if (value.type === "system" && value.subtype === "init") {
        state.sawInit = true;
        state.initVersion =
          typeof value.claude_code_version === "string"
            ? value.claude_code_version
            : null;
        state.initModel = typeof value.model === "string" ? value.model : null;
        state.probeServers = sanitizeMcpServers(value.mcp_servers);
        clearTimeout(startupTimer);
        recordEvent(eventsPath, "init", {
          claudeCodeVersion: state.initVersion,
          model: state.initModel,
          mcpServers: state.probeServers,
          permissionMode:
            typeof value.permissionMode === "string"
              ? value.permissionMode
              : null,
          toolCount: Array.isArray(value.tools) ? value.tools.length : null,
        });
      }

      if (isProbeToolUse(value)) {
        if (!state.sawToolUse) state.sawToolUse = true;
        recordEvent(eventsPath, "tool_use_detected", {
          tool: ALLOWED_TOOL_NAME,
          resultSeen: state.resultCount > 0,
          unexpected: idleMode,
        });
        if (idleMode) fail("unexpected_tool_use");
        else if (state.resultCount === 0) sendSecond();
        else fail("tool_use_after_result");
      }

      if (value.type === "assistant") {
        const text = extractText(value.message?.content ?? value.content);
        if (text.includes(expectedAck)) {
          state.ackAssistant = true;
          recordEvent(eventsPath, "assistant_ack_text", {
            observed: true,
            mode: config.mode,
          });
        }
      }

      if (value.type === "result") {
        state.resultCount += 1;
        const resultNumber = state.resultCount;
        const resultText =
          typeof value.result === "string" ? value.result.trim() : "";
        const ack = resultText === expectedAck;
        if (idleMode) {
          if (resultNumber === 1) {
            state.firstResultSeen = true;
            state.firstResultCorrect = resultText === FIRST_TURN_TEXT;
            recordEvent(eventsPath, "first_turn_result", {
              expected: FIRST_TURN_TEXT,
              matched: state.firstResultCorrect,
            });
            if (state.firstResultCorrect) scheduleIdlePush();
            else fail("unexpected_first_turn_result");
          } else if (resultNumber === 2) {
            state.secondResultSeen = true;
            state.ackResult = ack;
            if (!ack) fail("idle_push_ack_not_observed");
          } else {
            fail("unexpected_extra_result", { resultNumber });
          }
        } else {
          if (resultNumber === 1) {
            if (!state.sentSecond) state.firstResultBeforePush = true;
            state.ackResult = ack;
          } else {
            fail("unexpected_extra_result", { resultNumber });
          }
        }
        recordEvent(eventsPath, "result", {
          subtype: typeof value.subtype === "string" ? value.subtype : null,
          resultNumber,
          ack,
          mode: config.mode,
          afterPush: state.sentSecond,
        });
        if (ack) {
          recordEvent(eventsPath, "ack_observed", {
            source: "result",
            mode: config.mode,
            activeToolPush: !idleMode && state.sawToolUse && state.sentSecond,
            idlePush: idleMode && state.sentSecond,
          });
          // Ending stdin gives Claude a clean protocol shutdown. The process
          // close event, including its exit code, remains part of the result.
          closeInputGracefully("ack_observed");
        }
      }

      if (value.type === "error") {
        recordEvent(eventsPath, "client_error", {
          subtype: typeof value.subtype === "string" ? value.subtype : null,
          code: typeof value.code === "string" ? value.code : null,
        });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      outputRemainder += chunk;
      let newline;
      while ((newline = outputRemainder.indexOf("\n")) >= 0) {
        const line = outputRemainder.slice(0, newline).replace(/\r$/, "");
        outputRemainder = outputRemainder.slice(newline + 1);
        if (!line) continue;
        try {
          handleObject(JSON.parse(line));
        } catch {
          state.malformedOutput += 1;
          recordEvent(eventsPath, "malformed_output", {
            bytes: Buffer.byteLength(line),
          });
        }
      }
    });
    child.stdout.on("end", () => {
      if (!outputRemainder) return;
      try {
        handleObject(JSON.parse(outputRemainder));
      } catch {
        state.malformedOutput += 1;
        recordEvent(eventsPath, "malformed_output", {
          bytes: Buffer.byteLength(outputRemainder),
        });
      }
      outputRemainder = "";
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      state.stderrBytes += Buffer.byteLength(chunk);
      state.stderrHash.update(chunk);
    });
    child.stdin.on("error", (error) => {
      if (!state.terminationRequested) {
        fail("stdin_error", { error: error.name });
      }
    });
    child.on("error", (error) => {
      fail("child_spawn_error", {
        error: error.name,
        code: error.code ?? null,
      });
    });
    child.on("exit", (code, signal) => {
      state.childExit = code;
      state.childSignal = signal;
      recordEvent(eventsPath, "child_exit", { code, signal });
    });
    child.on("close", (code, signal) => {
      // Prefer the close callback's values if exit was not emitted first.
      if (state.childExit === null) state.childExit = code;
      if (state.childSignal === null) state.childSignal = signal;
      clearTimeout(idlePushTimer);
      recordEvent(eventsPath, "child_close", {
        code: state.childExit,
        signal: state.childSignal,
        mode: config.mode,
        sawToolUse: state.sawToolUse,
        sentSecond: state.sentSecond,
        resultCount: state.resultCount,
      });
      if (state.stderrBytes > 0) {
        state.stderrDigest ??= state.stderrHash.digest("hex");
        recordEvent(eventsPath, "stderr_summary", {
          bytes: state.stderrBytes,
          sha256: state.stderrDigest,
        });
      }
      if (state.failure === null) {
        const complete = idleMode
          ? state.firstResultSeen && state.sentSecond && state.ackResult
          : state.sawToolUse && state.sentSecond && state.ackResult;
        if (!complete) {
          state.failure = idleMode
            ? !state.firstResultSeen
              ? "first_turn_not_observed"
              : !state.sentSecond
                ? "idle_process_closed_before_push"
                : "idle_push_ack_not_observed"
            : state.sawToolUse
              ? "active_push_ack_not_observed"
              : "probe_tool_use_not_observed";
          recordEvent(eventsPath, "failure", { reason: state.failure });
        }
      }
      finish();
    });

    // Install timers before writing the first line. A very fast fake/client
    // must not race init and leave a stale startup timer behind.
    startupTimer = setTimeout(() => {
      if (!state.sawInit) fail("startup_timeout");
    }, config.startupMs);
    overallTimer = setTimeout(() => {
      if (!state.closed) fail("overall_timeout");
    }, config.timeoutMs);

    recordEvent(eventsPath, "child_spawn", {
      command: config.claudeCommand,
      argumentCount: config.claudeArgs.length,
      cwd: paths.cwd,
      mode: config.mode,
    });
    try {
      writeUserLine(child, inputEventsPath, "first", firstPrompt(config.mode));
    } catch (error) {
      fail("first_input_write_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
      return;
    }
    recordEvent(eventsPath, "first_prompt_sent", { mode: config.mode });
  });
}

async function runHarness(mode) {
  requireOptIn();
  const paths = createEvidenceRoot(mode);
  paths.events = join(paths.evidenceRoot, "events.jsonl");
  paths.inputEvents = join(paths.evidenceRoot, "inputs.jsonl");
  paths.probeEvents = join(paths.evidenceRoot, "probe-events.jsonl");
  paths.settings = join(paths.config, "settings.json");
  paths.mcpConfig = join(paths.config, "mcp.json");
  paths.summary = join(paths.evidenceRoot, "summary.json");
  paths.marker = `CLAUDE_${mode.toUpperCase()}_PUSH_${randomBytes(8).toString("hex").toUpperCase()}`;

  // Empty settings are explicit and isolated; authentication is intentionally
  // inherited from the caller rather than copied into this directory.
  writePrivateJson(paths.settings, {});
  const config = buildConfiguration(paths, mode);
  writePrivateJson(paths.mcpConfig, config.mcpConfig);
  recordEvent(paths.events, "harness_start", {
    evidenceDir: paths.evidenceRoot,
    cwd: paths.cwd,
    configDir: paths.config,
    markerSha256: sha256(paths.marker),
    mode,
    claudeCommand: config.claudeCommand,
    model: config.model,
    budgetUsd: config.budgetUsd,
    timeoutMs: config.timeoutMs,
    startupMs: config.startupMs,
    toolDelayMs: config.toolDelayMs,
    idleDelayMs: config.idleDelayMs,
  });
  if (mode === ACTIVE_MODE) {
    recordEvent(paths.events, "mcp_probe_configured", {
      command: config.launcher.command,
      argumentCount: config.launcher.args.length,
      pathStyle: config.launcher.pathStyle,
    });
  } else {
    recordEvent(paths.events, "mcp_probe_disabled", {
      reason: "idle_mode_isolates_stream_turn_lifecycle",
    });
  }

  const result = await runClaude(
    config,
    paths,
    paths.events,
    paths.inputEvents,
  );
  const summary = {
    generatedAt: timestamp(),
    success: result.success,
    evidenceDir: paths.evidenceRoot,
    files: {
      events: paths.events,
      inputs: paths.inputEvents,
      probeEvents: paths.probeEvents,
      mcpConfig: paths.mcpConfig,
      settings: paths.settings,
      summary: paths.summary,
    },
    claude: {
      command: config.claudeCommand,
      model: result.initModel ?? config.model,
      version: result.initVersion,
      exitCode: result.childExit,
      signal: result.childSignal,
    },
    observed: {
      mode,
      toolUse: result.sawToolUse,
      activePushSent: mode === ACTIVE_MODE && result.sentSecond,
      idlePushSent: mode === IDLE_MODE && result.sentSecond,
      resultCount: result.resultCount,
      acknowledgement: result.ackResult,
      assistantAckText: result.ackAssistant,
      firstResultBeforePush: result.firstResultBeforePush,
      firstResultSeen: result.firstResultSeen,
      firstResultCorrect: result.firstResultCorrect,
      secondResultSeen: result.secondResultSeen,
      malformedOutputLines: result.malformedOutput,
    },
    stderr: {
      bytes: result.stderrBytes,
      sha256: result.stderrDigest ?? result.stderrHash.digest("hex"),
    },
    failure: result.failure,
    note: "Evidence is redacted event metadata. Authentication was inherited, never copied or persisted.",
  };
  writePrivateJson(paths.summary, summary);
  recordEvent(paths.events, "harness_summary", {
    success: summary.success,
    mode,
    toolUse: summary.observed.toolUse,
    activePushSent: summary.observed.activePushSent,
    idlePushSent: summary.observed.idlePushSent,
    acknowledgement: summary.observed.acknowledgement,
    exitCode: summary.claude.exitCode,
    failure: summary.failure,
  });

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.success) {
    console.error(
      `Claude ${mode} push POC did not meet the success criteria. Inspect ${paths.evidenceRoot}.`,
    );
    process.exitCode = 1;
  }
}

async function runProbeServer() {
  if (process.env[PROBE_FLAG] !== "1") {
    throw new Error(
      `--probe-server is internal; set ${PROBE_FLAG}=1 only via the harness`,
    );
  }
  const logPath = process.env.AGENTCONDUIT_CLAUDE_POC_PROBE_LOG;
  if (!logPath) throw new Error("probe log path is missing");
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const toolDelayMs = parseProbeDelay(
    "AGENTCONDUIT_CLAUDE_POC_PROBE_TOOL_DELAY_MS",
    8_000,
  );
  const notificationDelayMs = parseProbeDelay(
    "AGENTCONDUIT_CLAUDE_POC_PROBE_NOTIFICATION_DELAY_MS",
    1_000,
  );
  const record = (event, fields = {}) => recordEvent(logPath, event, fields);

  const server = new McpServer(
    { name: "agentconduit-claude-push-probe", version: "0.0.1" },
    {
      capabilities: { logging: {} },
      instructions: `Controlled transport probe. Call ${PROBE_TOOL_NAME} exactly once; it waits and returns TOOL_RETURNED.`,
    },
  );
  server.registerTool(
    PROBE_TOOL_NAME,
    {
      description:
        "Wait for a bounded interval, then return a harmless control value.",
    },
    async () => {
      record("tool_started");
      await sleep(toolDelayMs);
      record("tool_finished");
      return {
        content: [{ type: "text", text: "TOOL_RETURNED" }],
      };
    },
  );

  server.server.oninitialized = () => {
    record("initialized");
    setTimeout(async () => {
      try {
        await server.sendLoggingMessage({
          level: "info",
          logger: "agentconduit-claude-push-probe",
          data: { notification: "UNSOLICITED_PUSH" },
        });
        record("notification_sent");
      } catch (error) {
        record("notification_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }, notificationDelayMs);
  };

  record("probe_start", { toolDelayMs, notificationDelayMs });
  await server.connect(new StdioServerTransport());
}

function printDryRun(mode) {
  const parent = resolve(
    environmentValue("AGENTCONDUIT_CLAUDE_POC_EVIDENCE_PARENT") ?? tmpdir(),
  );
  const command =
    environmentValue(
      "AGENTCONDUIT_CLAUDE_COMMAND",
      "CLAUDE_PUSH_POC_COMMAND",
    ) ?? "claude";
  const model =
    environmentValue("AGENTCONDUIT_CLAUDE_MODEL", "CLAUDE_PUSH_POC_MODEL") ??
    null;
  const budgetUsd = parseOptionalBudget();
  console.log(
    JSON.stringify(
      {
        live: false,
        mode,
        requires: `${LIVE_FLAG}=1`,
        claudeCommand: command,
        model,
        budgetUsd,
        evidenceParent: parent,
        mcpTool: ALLOWED_TOOL_NAME,
        expectedAcknowledgement: mode === IDLE_MODE ? IDLE_ACK_TEXT : ACK_TEXT,
        note: "No child process, MCP server, credentials, or API call was started.",
      },
      null,
      2,
    ),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP.trim());
    return;
  }
  if (args.includes("--dry-run")) {
    printDryRun(parseMode(args));
    return;
  }
  if (args.includes("--probe-server")) {
    if (args.length !== 1) {
      throw new Error(
        "--probe-server cannot be combined with another argument",
      );
    }
    await runProbeServer();
    return;
  }
  const mode = parseMode(args);
  const unknown = args.filter(
    (argument) => argument !== "--idle" && argument !== "--active",
  );
  if (unknown.length > 0) {
    throw new Error(`unknown argument ${unknown[0]}; use --help`);
  }
  await runHarness(mode);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
