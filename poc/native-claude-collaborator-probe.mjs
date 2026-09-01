#!/usr/bin/env node

/*
 * Disposable native Codex -> local AgentConduit MCP -> Claude Code probe.
 *
 * Default mode owns a temporary Git repository, Codex home, app-server, stdio
 * MCP runtime, and Claude child. The internal --runtime-server mode is loaded
 * only by the temporary claude_collaborator custom-agent file. Prompts and raw
 * provider streams stay in memory and disposable runtime state; retained
 * evidence contains only hashes, booleans, versions, counts, and lifecycle
 * metadata.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const LIVE_FLAG = "AGENTCONDUIT_RUN_NATIVE_CLAUDE_COLLABORATOR_POC";
const RUNTIME_FLAG = "AGENTCONDUIT_NATIVE_CLAUDE_RUNTIME_INTERNAL";
const AGENT_NAME = "claude_collaborator";
const RUNTIME_SERVER_NAME = "agentconduitClaudeRuntime";
const RUNTIME_TOOLS = [
  "claude_start",
  "claude_wait",
  "claude_events",
  "claude_cancel",
];
const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_EVENT_PAGE_SIZE = 100;

const HELP = `
Native Codex claude_collaborator POC

This is a live provider-backed experiment and is disabled unless
${LIVE_FLAG}=1 is set. It creates a disposable Git repository and proves:

  native Codex claude_collaborator subagent
    -> local asynchronous AgentConduit stdio MCP runtime
    -> local Claude Code process in the same worktree

Run:

  ${LIVE_FLAG}=1 node poc/native-claude-collaborator-probe.mjs

Inspect configuration without starting Codex, Claude, MCP, or provider calls:

  node poc/native-claude-collaborator-probe.mjs --dry-run

Useful controls:

  AGENTCONDUIT_NATIVE_CLAUDE_EVIDENCE_PARENT  Redacted evidence parent
  AGENTCONDUIT_NATIVE_CLAUDE_TIMEOUT_MS        Overall timeout (300000)
  AGENTCONDUIT_NATIVE_CLAUDE_STEP_TIMEOUT_MS   Codex step timeout (90000)
  AGENTCONDUIT_NATIVE_CLAUDE_JOB_TIMEOUT_MS    Claude job timeout (120000)
  AGENTCONDUIT_NATIVE_CLAUDE_BUDGET_USD        Claude budget cap (0.10)
  AGENTCONDUIT_NATIVE_CLAUDE_MODEL             Claude model/alias
  AGENTCONDUIT_NATIVE_CODEX_MODEL              Codex model/alias
  AGENTCONDUIT_CLAUDE_COMMAND                  Claude executable (claude)
  AGENTCONDUIT_CODEX_COMMAND                   Codex executable (codex)

The --runtime-server mode is internal and refuses to start without a private
flag installed by the harness. No personal Codex agent or configuration file
is created or changed.
`;

function timestamp() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function versionFromUserAgent(value) {
  if (typeof value !== "string") return null;
  return value.match(/\b(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/)?.[1] ?? null;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

export async function withTimeout(
  promise,
  timeoutMs,
  message,
  clock = globalThis,
) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = clock.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clock.clearTimeout(timeout);
  }
}

function envValue(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function boundedBudget(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be greater than 0 and at most 1`);
  }
  return value;
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
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX mode bits.
  }
}

function recordEvent(filePath, event, fields = {}) {
  appendJsonLine(filePath, { at: timestamp(), event, ...fields });
}

function redactDiagnostic(value, secrets = []) {
  let text = value instanceof Error ? value.message : String(value ?? "");
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("<redacted>");
  }
  return text.slice(0, 300);
}

function errorShape(error, secrets = []) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: redactDiagnostic(error, secrets),
    ...(error && typeof error === "object" && "code" in error
      ? { code: String(error.code) }
      : {}),
  };
}

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

function processLooksLikeOwnedRuntime(pid) {
  if (process.platform !== "linux") return false;
  try {
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return (
      commandLine.includes(SCRIPT_PATH) &&
      commandLine.includes("--runtime-server")
    );
  } catch {
    return false;
  }
}

function readLinuxProcessIdentity(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0 || !commandLine) return null;
    const fieldsAfterCommand = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const startTimeTicks = fieldsAfterCommand[19];
    if (!/^\d+$/.test(startTimeTicks ?? "")) return null;
    return {
      startTimeTicks,
      commandLineHash: sha256(commandLine),
    };
  } catch {
    return null;
  }
}

function validProcessIdentity(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.startTimeTicks === "string" &&
    /^\d+$/.test(value.startTimeTicks) &&
    typeof value.commandLineHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.commandLineHash),
  );
}

function processMatchesIdentity(pid, identity) {
  if (!validProcessIdentity(identity)) return false;
  const current = readLinuxProcessIdentity(pid);
  return Boolean(
    current &&
    current.startTimeTicks === identity.startTimeTicks &&
    current.commandLineHash === identity.commandLineHash,
  );
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(50);
  }
  return !isProcessAlive(pid);
}

async function stopOwnedRuntimePid(pid) {
  if (!isProcessAlive(pid)) return true;
  if (!processLooksLikeOwnedRuntime(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isProcessAlive(pid);
  }
  if (await waitForProcessExit(pid, 3_000)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !isProcessAlive(pid);
  }
  return waitForProcessExit(pid, 2_000);
}

async function stopOwnedClaudePid(pid, identity) {
  if (!isProcessAlive(pid)) return true;
  if (!processMatchesIdentity(pid, identity)) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isProcessAlive(pid);
  }
  if (await waitForProcessExit(pid, 3_000)) return true;
  if (!processMatchesIdentity(pid, identity)) return !isProcessAlive(pid);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !isProcessAlive(pid);
  }
  return waitForProcessExit(pid, 2_000);
}

async function waitForChildClose(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return Promise.race([
    new Promise((resolvePromise) =>
      child.once("close", () => resolvePromise(true)),
    ),
    delay(timeoutMs).then(() => false),
  ]);
}

export async function stopChild(child, label, eventsPath) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  recordEvent(eventsPath, "child_stop_requested", { label });
  try {
    child.kill("SIGTERM");
  } catch {
    return false;
  }
  if (await waitForChildClose(child, 4_000)) return true;
  try {
    child.kill("SIGKILL");
  } catch {
    return child.exitCode !== null || child.signalCode !== null;
  }
  return waitForChildClose(child, 2_000);
}

function runtimeStateFromPath(runtimeStatePath) {
  if (!runtimeStatePath || !existsSync(runtimeStatePath)) {
    return {
      present: false,
      readable: true,
      runtimePid: null,
      activeClaudePid: null,
      lastClaudePid: null,
      lastClaudeClosed: null,
      activeClaudeIdentity: null,
      lastClaudeIdentity: null,
    };
  }
  try {
    const state = JSON.parse(readFileSync(runtimeStatePath, "utf8"));
    return {
      present: true,
      readable: true,
      runtimePid:
        Number.isInteger(state.runtimePid) && state.runtimePid > 0
          ? state.runtimePid
          : null,
      activeClaudePid:
        Number.isInteger(state.activeClaudePid) && state.activeClaudePid > 0
          ? state.activeClaudePid
          : null,
      lastClaudePid:
        Number.isInteger(state.lastClaudePid) && state.lastClaudePid > 0
          ? state.lastClaudePid
          : null,
      lastClaudeClosed:
        typeof state.lastClaudeClosed === "boolean"
          ? state.lastClaudeClosed
          : null,
      activeClaudeIdentity: validProcessIdentity(state.activeClaudeIdentity)
        ? state.activeClaudeIdentity
        : null,
      lastClaudeIdentity: validProcessIdentity(state.lastClaudeIdentity)
        ? state.lastClaudeIdentity
        : null,
    };
  } catch {
    return {
      present: true,
      readable: false,
      runtimePid: null,
      activeClaudePid: null,
      lastClaudePid: null,
      lastClaudeClosed: null,
      activeClaudeIdentity: null,
      lastClaudeIdentity: null,
    };
  }
}

export async function cleanupOwnedProcesses({
  codex,
  runtimePid,
  runtimeStatePath,
  operations = {},
}) {
  const failures = [];
  const processIsAlive = operations.isProcessAlive ?? isProcessAlive;
  const stopRuntime = operations.stopOwnedRuntimePid ?? stopOwnedRuntimePid;
  const matchesIdentity =
    operations.processMatchesIdentity ?? processMatchesIdentity;
  const stopClaude = operations.stopOwnedClaudePid ?? stopOwnedClaudePid;

  let codexClosed = true;
  if (codex) {
    try {
      codexClosed = (await codex.close()) === true;
    } catch {
      codexClosed = false;
    }
  }
  if (!codexClosed) failures.push("codex_app_server_not_closed");

  const initialState = runtimeStateFromPath(runtimeStatePath);
  if (!initialState.readable) failures.push("runtime_state_unreadable");
  const explicitPid =
    Number.isInteger(runtimePid) && runtimePid > 0 ? runtimePid : null;
  if (
    explicitPid &&
    initialState.runtimePid &&
    explicitPid !== initialState.runtimePid
  ) {
    failures.push("runtime_pid_mismatch");
  }
  const runtimePids = [
    ...new Set([explicitPid, initialState.runtimePid].filter(Boolean)),
  ];
  let runtimeClosed = true;
  for (const pid of runtimePids) {
    if (!processIsAlive(pid)) continue;
    let stopped = false;
    try {
      stopped = (await stopRuntime(pid)) === true;
    } catch {
      stopped = false;
    }
    if (!stopped || processIsAlive(pid)) runtimeClosed = false;
  }
  if (!runtimeClosed) failures.push("runtime_server_not_closed");

  const finalState = runtimeStateFromPath(runtimeStatePath);
  if (!finalState.readable && !failures.includes("runtime_state_unreadable")) {
    failures.push("runtime_state_unreadable");
  }
  const latestState = finalState.readable ? finalState : initialState;
  const claudeCandidates = new Map();
  for (const state of [initialState, finalState]) {
    if (!state.readable) continue;
    if (state.activeClaudePid) {
      claudeCandidates.set(
        state.activeClaudePid,
        state.activeClaudeIdentity ??
          claudeCandidates.get(state.activeClaudePid) ??
          null,
      );
    }
    if (state.lastClaudePid) {
      claudeCandidates.set(
        state.lastClaudePid,
        state.lastClaudeIdentity ??
          claudeCandidates.get(state.lastClaudePid) ??
          null,
      );
    }
  }
  let directClaudeClosed = true;
  for (const [pid, identity] of claudeCandidates) {
    if (!processIsAlive(pid)) continue;
    let identityMatched = false;
    try {
      identityMatched = matchesIdentity(pid, identity) === true;
    } catch {
      identityMatched = false;
    }
    if (!identityMatched) {
      if (latestState.lastClaudeClosed !== true) directClaudeClosed = false;
      continue;
    }
    try {
      await stopClaude(pid, identity);
    } catch {
      // The process liveness check below is authoritative.
    }
    if (processIsAlive(pid)) directClaudeClosed = false;
  }
  if (
    claudeCandidates.size === 0 &&
    latestState.present &&
    latestState.lastClaudeClosed === false
  ) {
    directClaudeClosed = false;
  }
  if (!directClaudeClosed) {
    failures.push("direct_claude_child_not_closed");
  }

  return {
    success: failures.length === 0,
    failures,
    codexClosed,
    runtimeClosed,
    directClaudeClosed,
    runtimePid: latestState.runtimePid ?? explicitPid,
  };
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function loadMcpRuntimeDependencies() {
  try {
    const [{ McpServer }, { StdioServerTransport }, z] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("zod/v4"),
    ]);
    return { McpServer, StdioServerTransport, z };
  } catch {
    const [{ McpServer }, { StdioServerTransport }, z] = await Promise.all([
      import(
        new URL(
          "../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js",
          import.meta.url,
        )
      ),
      import(
        new URL(
          "../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js",
          import.meta.url,
        )
      ),
      import(
        new URL("../apps/server/node_modules/zod/index.js", import.meta.url)
      ),
    ]);
    return { McpServer, StdioServerTransport, z };
  }
}

function runtimeConfiguration() {
  if (process.env[RUNTIME_FLAG] !== "1") {
    throw new Error(
      `--runtime-server is internal; ${RUNTIME_FLAG}=1 is required`,
    );
  }
  const logPath = envValue("AGENTCONDUIT_NATIVE_CLAUDE_RUNTIME_LOG");
  const statePath = envValue("AGENTCONDUIT_NATIVE_CLAUDE_RUNTIME_STATE");
  const expectedCwdHash = envValue(
    "AGENTCONDUIT_NATIVE_CLAUDE_EXPECTED_CWD_HASH",
  );
  const expectedResultHash = envValue(
    "AGENTCONDUIT_NATIVE_CLAUDE_EXPECTED_RESULT_HASH",
  );
  if (!logPath || !statePath) {
    throw new Error("runtime log and state paths are required");
  }
  if (!/^[0-9a-f]{64}$/.test(expectedCwdHash)) {
    throw new Error("expected cwd hash is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(expectedResultHash)) {
    throw new Error("expected result hash is invalid");
  }
  return {
    logPath: resolve(logPath),
    statePath: resolve(statePath),
    expectedCwdHash,
    expectedResultHash,
    claudeCommand: envValue("AGENTCONDUIT_CLAUDE_COMMAND", "claude"),
    claudeModel: envValue(
      "AGENTCONDUIT_NATIVE_CLAUDE_MODEL",
      DEFAULT_CLAUDE_MODEL,
    ),
    budgetUsd: boundedBudget("AGENTCONDUIT_NATIVE_CLAUDE_BUDGET_USD", 0.1),
    jobTimeoutMs: boundedInteger(
      "AGENTCONDUIT_NATIVE_CLAUDE_JOB_TIMEOUT_MS",
      120_000,
      5_000,
      300_000,
    ),
    waitMaximumMs: boundedInteger(
      "AGENTCONDUIT_NATIVE_CLAUDE_WAIT_MAXIMUM_MS",
      15_000,
      100,
      30_000,
    ),
    shutdownMs: boundedInteger(
      "AGENTCONDUIT_NATIVE_CLAUDE_SHUTDOWN_MS",
      3_000,
      500,
      10_000,
    ),
  };
}

class ClaudeRuntime {
  constructor(config) {
    this.config = config;
    this.jobs = new Map();
    this.activeJobId = null;
    this.eventCursor = 0;
    this.lastClaudePid = null;
    this.lastClaudeIdentity = null;
    this.lastClaudeClosed = true;
    mkdirSync(dirname(config.logPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(config.statePath), { recursive: true, mode: 0o700 });
    this.writeState();
    this.record("runtime_started", {
      runtimePidHash: sha256(String(process.pid)),
      cwdHash: sha256(process.cwd()),
      cwdMatchesExpected: sha256(process.cwd()) === config.expectedCwdHash,
      commandHash: sha256(config.claudeCommand),
      model: config.claudeModel,
      budgetUsd: config.budgetUsd,
      jobTimeoutMs: config.jobTimeoutMs,
      waitMaximumMs: config.waitMaximumMs,
    });
  }

  record(event, fields = {}) {
    recordEvent(this.config.logPath, event, fields);
  }

  writeState() {
    const active = this.activeJobId
      ? (this.jobs.get(this.activeJobId) ?? null)
      : null;
    writePrivateJson(this.config.statePath, {
      runtimePid: process.pid,
      activeClaudePid: active?.child?.pid ?? null,
      activeClaudeIdentity: active?.childIdentity ?? null,
      lastClaudePid: this.lastClaudePid,
      lastClaudeIdentity: this.lastClaudeIdentity,
      lastClaudeClosed: this.lastClaudeClosed,
      activeJobStatus: active?.status ?? null,
    });
  }

  activeJob() {
    if (!this.activeJobId) return null;
    const job = this.jobs.get(this.activeJobId) ?? null;
    if (!job || job.finalized) {
      this.activeJobId = null;
      return null;
    }
    return job;
  }

  snapshot(job, includeResult = true) {
    const terminal = ["completed", "failed", "cancelled"].includes(job.status);
    return {
      jobId: job.id,
      status: job.status,
      cwdHash: job.cwdHash,
      startedAt: job.startedAt,
      startLatencyMs: job.startLatencyMs,
      lastEventCursor: job.lastEventCursor,
      lastEventSequence: job.lastEventSequence,
      terminal,
      directChildClosed: job.childClosed,
      ...(terminal
        ? {
            exitCode: job.exitCode,
            signal: job.signal,
            resultHash: job.resultHash,
            markerMatched: job.markerMatched,
            resultBytes: job.resultBytes,
            toolUseCount: job.toolUseCount,
            initObserved: job.initObserved,
            advertisedToolCount: job.advertisedToolCount,
            mcpServerCount: job.mcpServerCount,
            claudeCodeVersion: job.version,
            model: job.model,
            errorCode: job.errorCode,
          }
        : {}),
      ...(terminal && includeResult && job.status === "completed"
        ? { result: job.result }
        : {}),
    };
  }

  claudeArguments() {
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--disable-slash-commands",
      "--no-chrome",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
      "--settings",
      JSON.stringify({}),
      "--no-session-persistence",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--max-budget-usd",
      String(this.config.budgetUsd),
    ];
    if (this.config.claudeModel) {
      args.push("--model", this.config.claudeModel);
    }
    return args;
  }

  createJob(prompt) {
    let resolveDone;
    const done = new Promise((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    return {
      id: `clj_${randomBytes(16).toString("hex")}`,
      promptHash: sha256(prompt),
      promptBytes: Buffer.byteLength(prompt),
      cwdHash: sha256(process.cwd()),
      startedAt: timestamp(),
      launchStartedMs: Date.now(),
      startLatencyMs: null,
      status: "starting",
      child: null,
      childIdentity: null,
      childClosed: false,
      exitCode: null,
      signal: null,
      errorCode: null,
      cancelReason: null,
      result: null,
      resultHash: null,
      resultBytes: null,
      markerMatched: false,
      resultCount: 0,
      toolUseCount: 0,
      initObserved: false,
      workingObserved: false,
      checkpointObserved: false,
      advertisedToolCount: null,
      mcpServerCount: null,
      version: null,
      model: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutRemainder: "",
      stderrHash: createHash("sha256"),
      done,
      resolveDone,
      finalized: false,
      timeout: null,
      events: [],
      lastEventCursor: 0,
      lastEventSequence: 0,
    };
  }

  appendJobEvent(job, type, { phase, summary, operation } = {}) {
    const status =
      job.status === "starting"
        ? "queued"
        : job.status === "completed"
          ? "succeeded"
          : job.status;
    const event = {
      eventId: `cle_${randomBytes(16).toString("hex")}`,
      jobId: job.id,
      cursor: ++this.eventCursor,
      sequence: job.lastEventSequence + 1,
      type,
      status,
      ...(phase ? { phase } : {}),
      ...(summary ? { summary } : {}),
      ...(operation ? { operation } : {}),
      createdAt: timestamp(),
    };
    job.events.push(event);
    job.lastEventCursor = event.cursor;
    job.lastEventSequence = event.sequence;
    return event;
  }

  handleStreamObject(job, value) {
    if (!value || typeof value !== "object") return;
    if (value.type === "system" && value.subtype === "init") {
      const priorInitObserved = job.initObserved;
      job.version =
        typeof value.claude_code_version === "string"
          ? value.claude_code_version.slice(0, 80)
          : null;
      job.model =
        typeof value.model === "string" ? value.model.slice(0, 120) : null;
      const advertisedToolCount = Array.isArray(value.tools)
        ? value.tools.length
        : null;
      const mcpServerCount = Array.isArray(value.mcp_servers)
        ? value.mcp_servers.length
        : null;
      job.initObserved = true;
      job.advertisedToolCount = priorInitObserved
        ? Number.isInteger(job.advertisedToolCount) &&
          Number.isInteger(advertisedToolCount)
          ? job.advertisedToolCount + advertisedToolCount
          : null
        : advertisedToolCount;
      job.mcpServerCount = priorInitObserved
        ? Number.isInteger(job.mcpServerCount) &&
          Number.isInteger(mcpServerCount)
          ? job.mcpServerCount + mcpServerCount
          : null
        : mcpServerCount;
      this.record("claude_initialized", {
        jobIdHash: sha256(job.id),
        version: job.version,
        model: job.model,
        advertisedToolCount: job.advertisedToolCount,
        mcpServerCount: job.mcpServerCount,
      });
      if (!priorInitObserved) {
        this.appendJobEvent(job, "provider_ready", {
          phase: "provider",
          summary: "Claude provider initialized.",
          operation: "claude_collaboration",
        });
      }
    }
    if (value.type === "assistant") {
      if (!job.workingObserved) {
        job.workingObserved = true;
        this.appendJobEvent(job, "working", {
          phase: "execution",
          summary: "Claude is processing the request.",
          operation: "claude_collaboration",
        });
      }
      const content = value.message?.content ?? value.content;
      if (Array.isArray(content)) {
        job.toolUseCount += content.filter(
          (item) => item && item.type === "tool_use",
        ).length;
      }
    }
    if (value.type === "result") {
      job.resultCount += 1;
      const result = typeof value.result === "string" ? value.result : "";
      const bytes = Buffer.byteLength(result);
      if (bytes > MAX_RESULT_BYTES) {
        job.errorCode = "result_too_large";
        void this.requestStop(job, "result_too_large");
        return;
      }
      job.result = result;
      job.resultBytes = bytes;
      job.resultHash = sha256(result);
      job.markerMatched = job.resultHash === this.config.expectedResultHash;
      if (!job.checkpointObserved) {
        job.checkpointObserved = true;
        this.appendJobEvent(job, "checkpoint", {
          phase: "result",
          summary: "Claude produced a bounded result.",
          operation: "claude_collaboration",
        });
      }
      this.record("claude_result_observed", {
        jobIdHash: sha256(job.id),
        resultBytes: bytes,
        resultHash: job.resultHash,
        markerMatched: job.markerMatched,
        subtype:
          typeof value.subtype === "string" ? value.subtype.slice(0, 80) : null,
      });
    }
    if (value.type === "error" && !job.errorCode) {
      job.errorCode = "provider_stream_error";
    }
  }

  handleStdout(job, chunk) {
    job.stdoutBytes += Buffer.byteLength(chunk);
    if (job.stdoutBytes > MAX_STREAM_BYTES) {
      job.errorCode = "stdout_limit_exceeded";
      void this.requestStop(job, "stdout_limit_exceeded");
      return;
    }
    job.stdoutRemainder += chunk;
    if (Buffer.byteLength(job.stdoutRemainder) > MAX_LINE_BYTES) {
      job.errorCode = "stdout_line_limit_exceeded";
      void this.requestStop(job, "stdout_line_limit_exceeded");
      return;
    }
    let newline;
    while ((newline = job.stdoutRemainder.indexOf("\n")) >= 0) {
      const line = job.stdoutRemainder.slice(0, newline).replace(/\r$/, "");
      job.stdoutRemainder = job.stdoutRemainder.slice(newline + 1);
      if (!line) continue;
      try {
        this.handleStreamObject(job, JSON.parse(line));
      } catch {
        if (!job.errorCode) job.errorCode = "malformed_stream_json";
      }
    }
  }

  handleStderr(job, chunk) {
    job.stderrBytes += Buffer.byteLength(chunk);
    job.stderrHash.update(chunk);
    if (job.stderrBytes > MAX_STREAM_BYTES && !job.errorCode) {
      job.errorCode = "stderr_limit_exceeded";
      void this.requestStop(job, "stderr_limit_exceeded");
    }
  }

  finalizeJob(job, code, signal) {
    if (job.finalized) return;
    job.finalized = true;
    clearTimeout(job.timeout);
    if (job.stdoutRemainder.trim()) {
      try {
        this.handleStreamObject(job, JSON.parse(job.stdoutRemainder));
      } catch {
        if (!job.errorCode) job.errorCode = "malformed_stream_json";
      }
    }
    job.exitCode = typeof code === "number" ? code : null;
    job.signal = typeof signal === "string" ? signal : null;
    job.childClosed = true;
    this.lastClaudeClosed = true;
    if (job.cancelReason === "cancelled") {
      job.status = "cancelled";
      job.errorCode = null;
    } else if (job.cancelReason === "job_timeout") {
      job.status = "failed";
      job.errorCode = "job_timeout";
    } else if (job.errorCode) {
      job.status = "failed";
    } else if (job.exitCode !== 0) {
      job.status = "failed";
      job.errorCode = "claude_nonzero_exit";
    } else if (
      !job.initObserved ||
      job.advertisedToolCount !== 0 ||
      job.mcpServerCount !== 0
    ) {
      job.status = "failed";
      job.errorCode = "unexpected_runtime_capabilities";
    } else if (
      job.resultCount !== 1 ||
      typeof job.result !== "string" ||
      job.result.length === 0
    ) {
      job.status = "failed";
      job.errorCode = "missing_unique_result";
    } else if (job.toolUseCount !== 0) {
      job.status = "failed";
      job.errorCode = "unexpected_tool_use";
    } else if (!job.markerMatched) {
      job.status = "failed";
      job.errorCode = "unexpected_result";
    } else {
      job.status = "completed";
    }
    this.appendJobEvent(job, job.status, {
      phase: "terminal",
      summary:
        job.status === "completed"
          ? "Claude job completed."
          : job.status === "cancelled"
            ? "Claude job was cancelled."
            : "Claude job failed.",
      operation: "claude_collaboration",
    });
    if (this.activeJobId === job.id) this.activeJobId = null;
    this.writeState();
    this.record("claude_job_terminal", {
      jobIdHash: sha256(job.id),
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      childClosed: job.childClosed,
      resultCount: job.resultCount,
      markerMatched: job.markerMatched,
      toolUseCount: job.toolUseCount,
      initObserved: job.initObserved,
      advertisedToolCount: job.advertisedToolCount,
      mcpServerCount: job.mcpServerCount,
      stdoutBytes: job.stdoutBytes,
      stderrBytes: job.stderrBytes,
      stderrHash: job.stderrHash.copy().digest("hex"),
      errorCode: job.errorCode,
    });
    job.resolveDone();
  }

  async requestStop(job, reason) {
    if (!job || job.finalized) return;
    if (!job.cancelReason) job.cancelReason = reason;
    try {
      if (
        job.child &&
        job.child.exitCode === null &&
        job.child.signalCode === null
      ) {
        job.child.kill("SIGTERM");
      }
    } catch {
      // Continue to bounded close verification.
    }
    if (await waitForChildClose(job.child, this.config.shutdownMs)) return;
    try {
      if (
        job.child &&
        job.child.exitCode === null &&
        job.child.signalCode === null
      ) {
        job.child.kill("SIGKILL");
      }
    } catch {
      // The close check below determines the result.
    }
    if (!(await waitForChildClose(job.child, this.config.shutdownMs))) {
      job.errorCode = "lingering_claude_child";
      job.status = "failed";
      this.writeState();
      this.record("claude_child_lingering", {
        jobIdHash: sha256(job.id),
      });
    }
  }

  async start(prompt) {
    const promptBytes = Buffer.byteLength(prompt);
    if (promptBytes === 0 || promptBytes > MAX_PROMPT_BYTES) {
      throw new Error(`prompt must be between 1 and ${MAX_PROMPT_BYTES} bytes`);
    }
    if (this.activeJob()) {
      throw new Error("one Claude job is already active");
    }
    const job = this.createJob(prompt);
    this.jobs.set(job.id, job);
    this.activeJobId = job.id;
    this.appendJobEvent(job, "created", {
      phase: "created",
      summary: "Claude job created.",
      operation: "claude_collaboration",
    });
    const childEnv = {
      ...process.env,
      NO_COLOR: "1",
      CLAUDE_CODE_DISABLE_TELEMETRY:
        process.env.CLAUDE_CODE_DISABLE_TELEMETRY ?? "1",
    };
    const args = this.claudeArguments();
    const child = spawn(this.config.claudeCommand, args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    job.child = child;
    this.lastClaudePid = child.pid ?? null;
    job.childIdentity = readLinuxProcessIdentity(child.pid);
    this.lastClaudeIdentity = job.childIdentity;
    this.lastClaudeClosed = false;
    this.writeState();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(job, chunk));
    child.stderr.on("data", (chunk) => this.handleStderr(job, chunk));
    child.stdin.on("error", () => {
      if (!job.errorCode) job.errorCode = "claude_stdin_error";
    });
    child.on("error", (error) => {
      if (!job.errorCode) job.errorCode = "claude_spawn_error";
      this.record("claude_process_error", {
        jobIdHash: sha256(job.id),
        name: error instanceof Error ? error.name : "Error",
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : null,
      });
    });
    child.on("close", (code, signal) => this.finalizeJob(job, code, signal));

    const launched = await Promise.race([
      new Promise((resolvePromise) => {
        child.once("spawn", () => resolvePromise(true));
        child.once("error", () => resolvePromise(false));
      }),
      delay(3_000).then(() => false),
    ]);
    if (!launched) {
      if (!job.errorCode) job.errorCode = "claude_launch_timeout";
      await this.requestStop(job, "launch_failed");
      await Promise.race([job.done, delay(this.config.shutdownMs)]);
      return this.snapshot(job);
    }

    if (!job.childIdentity) {
      job.childIdentity = readLinuxProcessIdentity(child.pid);
      this.lastClaudeIdentity = job.childIdentity;
    }

    job.status = "running";
    job.startLatencyMs = Date.now() - job.launchStartedMs;
    this.appendJobEvent(job, "started", {
      phase: "startup",
      summary: "Claude process started.",
      operation: "claude_collaboration",
    });
    job.timeout = setTimeout(() => {
      void this.requestStop(job, "job_timeout");
    }, this.config.jobTimeoutMs);
    const wire = JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
    });
    try {
      child.stdin.end(`${wire}\n`);
    } catch {
      job.errorCode = "claude_stdin_error";
      await this.requestStop(job, "stdin_failed");
    }
    this.record("claude_job_started", {
      jobIdHash: sha256(job.id),
      promptHash: job.promptHash,
      promptBytes: job.promptBytes,
      wireHash: sha256(wire),
      wireBytes: Buffer.byteLength(wire) + 1,
      cwdHash: job.cwdHash,
      cwdMatchesExpected: job.cwdHash === this.config.expectedCwdHash,
      startLatencyMs: job.startLatencyMs,
      processIdentityCaptured: Boolean(job.childIdentity),
      argumentCount: args.length,
      safeguards: {
        streamJson: true,
        noSessionPersistence: true,
        noTools: true,
        strictEmptyMcp: true,
        restricted: true,
        dontAsk: true,
        cappedBudget: true,
      },
    });
    this.writeState();
    return this.snapshot(job, false);
  }

  async wait(jobId, waitMs) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Claude job was not found");
    const boundedWait = Math.min(
      Math.max(Number.isInteger(waitMs) ? waitMs : 10_000, 0),
      this.config.waitMaximumMs,
    );
    this.record("runtime_tool_called", {
      tool: "claude_wait",
      jobIdHash: sha256(job.id),
      waitMs: boundedWait,
    });
    if (!["completed", "failed", "cancelled"].includes(job.status)) {
      await Promise.race([job.done, delay(boundedWait)]);
    }
    return this.snapshot(job);
  }

  events(jobId, afterCursor = 0, limit = MAX_EVENT_PAGE_SIZE) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Claude job was not found");
    const boundedAfterCursor = Number.isInteger(afterCursor) ? afterCursor : 0;
    const boundedLimit = Number.isInteger(limit)
      ? Math.min(Math.max(limit, 1), MAX_EVENT_PAGE_SIZE)
      : MAX_EVENT_PAGE_SIZE;
    this.record("runtime_tool_called", {
      tool: "claude_events",
      jobIdHash: sha256(job.id),
      afterCursor: boundedAfterCursor,
      limit: boundedLimit,
    });
    const events = job.events
      .filter((event) => event.cursor > boundedAfterCursor)
      .slice(0, boundedLimit)
      .map((event) => ({ ...event }));
    const nextCursor = events.at(-1)?.cursor ?? boundedAfterCursor;
    return {
      jobId: job.id,
      events,
      latestCursor: job.lastEventCursor,
      latestSequence: job.lastEventSequence,
      nextCursor,
      hasMore: nextCursor < job.lastEventCursor,
    };
  }

  async cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Claude job was not found");
    this.record("runtime_tool_called", {
      tool: "claude_cancel",
      jobIdHash: sha256(job.id),
    });
    if (!["completed", "failed", "cancelled"].includes(job.status)) {
      await this.requestStop(job, "cancelled");
      await Promise.race([job.done, delay(this.config.shutdownMs * 2)]);
    }
    return this.snapshot(job);
  }

  async shutdown() {
    const active = this.activeJob();
    if (active) {
      await this.requestStop(active, "cancelled");
      await Promise.race([active.done, delay(this.config.shutdownMs * 2)]);
    }
    this.record("runtime_stopped", {
      activeJobRemaining: Boolean(this.activeJob()),
      lastClaudeClosed: this.lastClaudeClosed,
    });
    this.writeState();
  }
}

function toolResult(value, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

async function runRuntimeServer() {
  const config = runtimeConfiguration();
  const { McpServer, StdioServerTransport, z } =
    await loadMcpRuntimeDependencies();
  const runtime = new ClaudeRuntime(config);
  const server = new McpServer(
    { name: "agentconduit-native-claude-runtime", version: "0.1.0" },
    {
      instructions:
        "Start one local Claude job, replay its normalized progress from the last cursor, wait in bounded intervals, and cancel only for cleanup or failure.",
    },
  );
  const guarded = (handler) => async (input) => {
    try {
      return toolResult(await handler(input ?? {}));
    } catch (error) {
      runtime.record("runtime_tool_error", {
        name: error instanceof Error ? error.name : "Error",
        messageHash: sha256(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return toolResult(
        {
          error: "runtime_error",
          message: "The local Claude runtime rejected the request.",
        },
        true,
      );
    }
  };

  server.registerTool(
    "claude_start",
    {
      title: "Start local Claude collaborator",
      description:
        "Start one local, tool-free, budget-capped Claude job and return promptly with a job id.",
      inputSchema: { prompt: z.string().min(1).max(MAX_PROMPT_BYTES) },
      outputSchema: { result: z.unknown() },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guarded(async ({ prompt }) => {
      runtime.record("runtime_tool_called", {
        tool: "claude_start",
        promptHash: sha256(prompt),
        promptBytes: Buffer.byteLength(prompt),
      });
      return runtime.start(prompt);
    }),
  );
  server.registerTool(
    "claude_wait",
    {
      title: "Wait for local Claude collaborator",
      description:
        "Wait for a bounded interval and return the current job state; repeat while running.",
      inputSchema: {
        jobId: z.string().regex(/^clj_[0-9a-f]{32}$/),
        waitMs: z.number().int().min(0).max(config.waitMaximumMs).optional(),
      },
      outputSchema: { result: z.unknown() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(({ jobId, waitMs }) => runtime.wait(jobId, waitMs)),
  );
  server.registerTool(
    "claude_events",
    {
      title: "Read local Claude collaborator progress",
      description:
        "Read one bounded ordered page of normalized safe progress after a cursor; empty pages never imply completion or abandonment.",
      inputSchema: {
        jobId: z.string().regex(/^clj_[0-9a-f]{32}$/),
        afterCursor: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(MAX_EVENT_PAGE_SIZE).optional(),
      },
      outputSchema: { result: z.unknown() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(({ jobId, afterCursor, limit }) =>
      runtime.events(jobId, afterCursor, limit),
    ),
  );
  server.registerTool(
    "claude_cancel",
    {
      title: "Cancel local Claude collaborator",
      description:
        "Stop the named job with bounded termination; terminal jobs are returned unchanged.",
      inputSchema: { jobId: z.string().regex(/^clj_[0-9a-f]{32}$/) },
      outputSchema: { result: z.unknown() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(({ jobId }) => runtime.cancel(jobId)),
  );

  const transport = new StdioServerTransport();
  const stopped = new Promise((resolvePromise) => {
    let resolved = false;
    const stop = () => {
      if (resolved) return;
      resolved = true;
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stdin.once("end", stop);
    process.stdin.once("close", stop);
  });
  await server.connect(transport);
  runtime.record("runtime_mcp_connected");
  await stopped;
  await runtime.shutdown();
  await transport.close().catch(() => undefined);
  await server.close().catch(() => undefined);
}

function harnessConfiguration() {
  return {
    timeoutMs: boundedInteger(
      "AGENTCONDUIT_NATIVE_CLAUDE_TIMEOUT_MS",
      300_000,
      30_000,
      600_000,
    ),
    stepTimeoutMs: boundedInteger(
      "AGENTCONDUIT_NATIVE_CLAUDE_STEP_TIMEOUT_MS",
      90_000,
      10_000,
      240_000,
    ),
    jobTimeoutMs: boundedInteger(
      "AGENTCONDUIT_NATIVE_CLAUDE_JOB_TIMEOUT_MS",
      120_000,
      5_000,
      300_000,
    ),
    budgetUsd: boundedBudget("AGENTCONDUIT_NATIVE_CLAUDE_BUDGET_USD", 0.1),
    claudeModel: envValue(
      "AGENTCONDUIT_NATIVE_CLAUDE_MODEL",
      DEFAULT_CLAUDE_MODEL,
    ),
    codexModel: envValue(
      "AGENTCONDUIT_NATIVE_CODEX_MODEL",
      DEFAULT_CODEX_MODEL,
    ),
    claudeCommand: envValue("AGENTCONDUIT_CLAUDE_COMMAND", "claude"),
    codexCommand: envValue("AGENTCONDUIT_CODEX_COMMAND", "codex"),
    evidenceParent: resolve(
      envValue("AGENTCONDUIT_NATIVE_CLAUDE_EVIDENCE_PARENT", tmpdir()),
    ),
  };
}

function createHarnessPaths(config) {
  mkdirSync(config.evidenceParent, { recursive: true, mode: 0o700 });
  const evidenceRoot = mkdtempSync(
    join(config.evidenceParent, "agentconduit-native-claude-evidence-"),
  );
  const runtimeRoot = mkdtempSync(
    join(tmpdir(), "agentconduit-native-claude-state-"),
  );
  try {
    chmodSync(evidenceRoot, 0o700);
    chmodSync(runtimeRoot, 0o700);
  } catch {
    // Best effort only.
  }
  return {
    evidenceRoot,
    runtimeRoot,
    eventsPath: join(evidenceRoot, "events.jsonl"),
    runtimeLogPath: join(evidenceRoot, "runtime-events.jsonl"),
    summaryPath: join(evidenceRoot, "summary.json"),
    runtimeStatePath: join(runtimeRoot, "runtime-state.json"),
    repository: join(runtimeRoot, "repository"),
    codexHome: join(runtimeRoot, "codex-home"),
  };
}

function makeGitFixture(paths) {
  mkdirSync(paths.repository, { recursive: true, mode: 0o700 });
  runGit(paths.repository, ["init", "-q", "-b", "main"]);
  runGit(paths.repository, ["config", "user.name", "AgentConduit POC"]);
  runGit(paths.repository, [
    "config",
    "user.email",
    "agentconduit-poc@example.invalid",
  ]);
  writeFileSync(
    join(paths.repository, "README.md"),
    "Disposable native Claude collaborator fixture\n",
    { encoding: "utf8", mode: 0o600 },
  );
  runGit(paths.repository, ["add", "README.md"]);
  runGit(paths.repository, ["commit", "-qm", "initial fixture"]);
  return gitSnapshot(paths.repository);
}

function gitSnapshot(repository) {
  return {
    head: runGit(repository, ["rev-parse", "HEAD"]),
    status: runGit(repository, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
  };
}

function findCodexAuthSource() {
  const configuredHome = envValue("CODEX_HOME");
  const candidates = [
    configuredHome ? join(configuredHome, "auth.json") : "",
    envValue("HOME") ? join(envValue("HOME"), ".codex", "auth.json") : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function writeCodexConfiguration(paths, config, expectedResultHash) {
  mkdirSync(join(paths.codexHome, "agents"), {
    recursive: true,
    mode: 0o700,
  });
  const authSource = findCodexAuthSource();
  let authMode = "inherited_environment";
  if (authSource) {
    try {
      symlinkSync(authSource, join(paths.codexHome, "auth.json"));
      authMode = "temporary_symlink";
    } catch {
      // Inherited API credentials may still authenticate the child.
    }
  }
  const configToml = [
    "[agents]",
    "enabled = true",
    "max_concurrent_threads_per_session = 1",
    "",
    `[projects.${tomlString(paths.repository)}]`,
    'trust_level = "trusted"',
    "",
  ].join("\n");
  writeFileSync(join(paths.codexHome, "config.toml"), configToml, {
    encoding: "utf8",
    mode: 0o600,
  });

  const runtimeEnvironment = {
    [RUNTIME_FLAG]: "1",
    AGENTCONDUIT_NATIVE_CLAUDE_RUNTIME_LOG: paths.runtimeLogPath,
    AGENTCONDUIT_NATIVE_CLAUDE_RUNTIME_STATE: paths.runtimeStatePath,
    AGENTCONDUIT_NATIVE_CLAUDE_EXPECTED_CWD_HASH: sha256(paths.repository),
    AGENTCONDUIT_NATIVE_CLAUDE_EXPECTED_RESULT_HASH: expectedResultHash,
    AGENTCONDUIT_NATIVE_CLAUDE_JOB_TIMEOUT_MS: String(config.jobTimeoutMs),
    AGENTCONDUIT_NATIVE_CLAUDE_BUDGET_USD: String(config.budgetUsd),
    AGENTCONDUIT_NATIVE_CLAUDE_MODEL: config.claudeModel,
    AGENTCONDUIT_CLAUDE_COMMAND: config.claudeCommand,
  };
  const agentToml = [
    `name = ${tomlString(AGENT_NAME)}`,
    `description = ${tomlString("Native Codex shell backed by a locally executed Claude runtime for one bounded outside-model judgement.")}`,
    `model = ${tomlString(config.codexModel)}`,
    'model_reasoning_effort = "low"',
    'sandbox_mode = "read-only"',
    'developer_instructions = """',
    "Act only as a thin native shell around the local Claude runtime.",
    "Call claude_start exactly once with the task as a concise prompt.",
    "Set an event cursor to zero, then call claude_events with the returned jobId, afterCursor=0, and limit=100.",
    "While the job is not terminal, alternate claude_wait with waitMs=10000 and claude_events from the last nextCursor.",
    "Relay concise commentary only for meaningful new phase, checkpoint, or terminal events; do not narrate empty reads, every wait, or heartbeat-like liveness.",
    "Never quote or infer the prompt, result, raw provider stream, credentials, or hidden reasoning from progress events.",
    "If completed, return the result verbatim and nothing else.",
    "If failed or cancelled, return a concise failure and its errorCode.",
    "Never call claude_cancel after completion. Never use another tool, spawn another agent, edit files, or run commands.",
    '"""',
    "",
    `[mcp_servers.${RUNTIME_SERVER_NAME}]`,
    `command = ${tomlString(process.execPath)}`,
    `args = ${tomlArray([SCRIPT_PATH, "--runtime-server"])}`,
    `cwd = ${tomlString(paths.repository)}`,
    `enabled_tools = ${tomlArray(RUNTIME_TOOLS)}`,
    "required = true",
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 25",
    'default_tools_approval_mode = "approve"',
    "",
    `[mcp_servers.${RUNTIME_SERVER_NAME}.env]`,
    ...Object.entries(runtimeEnvironment).map(
      ([name, value]) => `${name} = ${tomlString(value)}`,
    ),
    "",
  ].join("\n");
  writeFileSync(
    join(paths.codexHome, "agents", "claude-collaborator.toml"),
    agentToml,
    { encoding: "utf8", mode: 0o600 },
  );
  return { authMode };
}

class CodexProcess {
  constructor({ paths, config, eventsPath }) {
    this.paths = paths;
    this.config = config;
    this.eventsPath = eventsPath;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
    this.outputRemainder = "";
    this.completedSpawnCalls = new Map();
    this.completedRuntimeToolCalls = new Map();
    this.runtimeToolCallsByThread = new Map();
    this.spawnedAgentThreadId = null;
    this.spawnedAgentRole = null;
    this.spawnedAgentCwdMatched = false;
    this.userAgent = null;
    const childEnv = {
      ...process.env,
      CODEX_HOME: paths.codexHome,
      RUST_LOG: "warn",
    };
    for (const variable of [
      "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
      "CODEX_SESSION_ID",
      "CODEX_THREAD_ID",
      "CODEX_SQLITE_HOME",
      "CODEX_APP_TOOLS_PIPE_PATH",
      "CODEX_MCP_NODE_PATH",
    ]) {
      delete childEnv[variable];
    }
    this.child = spawn(
      config.codexCommand,
      [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        "analytics.enabled=false",
        "-c",
        "features.apps=false",
        "-c",
        "features.plugins=false",
        "-c",
        "features.remote_plugin=false",
        "-c",
        "agents.enabled=true",
        "-c",
        "agents.max_concurrent_threads_per_session=1",
      ],
      {
        cwd: paths.repository,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.stderrBytes = 0;
    this.stderrHash = createHash("sha256");
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onOutput(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += Buffer.byteLength(chunk);
      this.stderrHash.update(chunk);
    });
    this.child.on("error", (error) => {
      this.record("codex_process_error", {
        name: error instanceof Error ? error.name : "Error",
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : null,
      });
    });
    this.child.on("exit", (code, signal) => {
      this.record("codex_exit", { code, signal });
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Codex app-server exited"));
      }
      this.pending.clear();
      this.rejectWaiters(new Error("Codex app-server exited"));
    });
    this.child.on("close", (code, signal) => {
      this.record("codex_close", {
        code,
        signal,
        stderrBytes: this.stderrBytes,
        stderrHash: this.stderrHash.copy().digest("hex"),
      });
    });
    this.record("codex_spawned", {
      commandHash: sha256(config.codexCommand),
      model: config.codexModel,
    });
  }

  record(event, fields = {}) {
    recordEvent(this.eventsPath, event, fields);
  }

  send(message) {
    if (!this.child.stdin.writable || this.child.stdin.destroyed) {
      throw new Error("Codex app-server stdin is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    this.record("codex_request_sent", {
      id: message.id ?? null,
      method: message.method,
      parameterBytes: message.params
        ? Buffer.byteLength(JSON.stringify(message.params))
        : 0,
    });
  }

  request(method, params = {}, timeoutMs = this.config.stepTimeoutMs) {
    const id = this.nextId++;
    this.send({ method, id, params });
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  onOutput(chunk) {
    this.outputRemainder += chunk;
    let newline;
    while ((newline = this.outputRemainder.indexOf("\n")) >= 0) {
      const line = this.outputRemainder.slice(0, newline).replace(/\r$/, "");
      this.outputRemainder = this.outputRemainder.slice(newline + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line));
      } catch {
        this.record("codex_malformed_output", {
          bytes: Buffer.byteLength(line),
        });
      }
    }
  }

  onMessage(message) {
    if (!message || typeof message !== "object") return;
    if (Object.hasOwn(message, "id") && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(
          `${pending.method}: ${message.error.message ?? "RPC error"}`,
        );
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      this.record("codex_response", {
        id: message.id,
        method: pending.method,
        errorCode: message.error?.code ?? null,
      });
      return;
    }

    if (message.method === "mcpServer/startupStatus/updated") {
      const params = message.params ?? {};
      const statusValue = params.status;
      const status =
        typeof statusValue === "string"
          ? statusValue
          : statusValue && typeof statusValue === "object"
            ? (statusValue.status ??
              statusValue.state ??
              statusValue.phase ??
              null)
            : (params.state ?? params.phase ?? null);
      const serverName =
        params.serverName ?? params.name ?? params.mcpServerName ?? "unknown";
      this.record("codex_mcp_startup_status", {
        serverName:
          typeof serverName === "string" ? serverName.slice(0, 120) : "unknown",
        status: typeof status === "string" ? status.slice(0, 80) : null,
      });
    }

    if (
      message.method === "item/started" ||
      message.method === "item/completed"
    ) {
      const item =
        message.params?.item && typeof message.params.item === "object"
          ? message.params.item
          : {};
      const phase = message.method === "item/started" ? "started" : "completed";
      const itemType = typeof item.type === "string" ? item.type : null;
      const itemIdHash = typeof item.id === "string" ? sha256(item.id) : null;
      const eventThreadId =
        typeof message.params?.threadId === "string"
          ? message.params.threadId
          : null;
      if (
        phase === "completed" &&
        itemType === "collabAgentToolCall" &&
        item.tool === "spawnAgent" &&
        typeof item.id === "string"
      ) {
        this.completedSpawnCalls.set(item.id, {
          eventThreadId,
          senderThreadId:
            typeof item.senderThreadId === "string"
              ? item.senderThreadId
              : null,
          receiverThreadIds: Array.isArray(item.receiverThreadIds)
            ? item.receiverThreadIds.filter(
                (threadId) => typeof threadId === "string",
              )
            : [],
          status: typeof item.status === "string" ? item.status : "completed",
        });
      }
      if (
        phase === "completed" &&
        itemType === "mcpToolCall" &&
        item.server === RUNTIME_SERVER_NAME &&
        RUNTIME_TOOLS.includes(item.tool) &&
        typeof item.id === "string"
      ) {
        this.completedRuntimeToolCalls.set(item.id, {
          eventThreadId,
          tool: item.tool,
          status: typeof item.status === "string" ? item.status : null,
        });
        if (eventThreadId && item.status === "completed") {
          const calls =
            this.runtimeToolCallsByThread.get(eventThreadId) ?? new Set();
          calls.add(item.tool);
          this.runtimeToolCallsByThread.set(eventThreadId, calls);
        }
      }
      this.record("codex_item", {
        phase,
        itemType,
        itemIdHash,
        tool: typeof item.tool === "string" ? item.tool.slice(0, 120) : null,
        server:
          typeof item.server === "string" ? item.server.slice(0, 120) : null,
        status:
          typeof item.status === "string" ? item.status.slice(0, 80) : null,
        receiverCount: Array.isArray(item.receiverThreadIds)
          ? item.receiverThreadIds.length
          : null,
        eventThreadMatchesSender:
          eventThreadId !== null && typeof item.senderThreadId === "string"
            ? eventThreadId === item.senderThreadId
            : null,
        agentPath:
          typeof item.agentPath === "string"
            ? item.agentPath.slice(0, 120)
            : null,
      });
    }

    if (Object.hasOwn(message, "id") && message.method) {
      let result = { decision: "decline" };
      if (message.method === "mcpServer/elicitation/request") {
        const params = message.params ?? {};
        const schema = params.requestedSchema;
        const emptyForm =
          params.serverName === RUNTIME_SERVER_NAME &&
          params.mode === "form" &&
          schema &&
          typeof schema === "object" &&
          schema.type === "object" &&
          (!schema.properties || Object.keys(schema.properties).length === 0) &&
          (!Array.isArray(schema.required) || schema.required.length === 0);
        result = emptyForm
          ? { action: "accept", content: {} }
          : { action: "decline" };
        this.record("codex_mcp_elicitation", {
          accepted: emptyForm,
          serverName:
            typeof params.serverName === "string"
              ? params.serverName.slice(0, 120)
              : null,
        });
      } else if (message.method === "item/tool/requestUserInput") {
        result = { answers: {} };
      }
      this.send({ id: message.id, result });
      return;
    }

    if (message.method) {
      const notification = { ...message, at: timestamp() };
      this.notifications.push(notification);
      this.record("codex_notification", { method: message.method });
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(notification)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(notification);
        }
      }
    }
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  waitForNotification(predicate, timeoutMs) {
    for (const notification of this.notifications) {
      if (predicate(notification)) return Promise.resolve(notification);
    }
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: resolvePromise,
        reject,
        timeout: null,
      };
      waiter.timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Codex notification wait timed out"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "agentconduit-native-claude-poc",
        title: "AgentConduit native Claude collaborator POC",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.userAgent =
      typeof result?.userAgent === "string"
        ? result.userAgent.slice(0, 160)
        : null;
    this.record("codex_initialized", {
      userAgent: this.userAgent,
    });
    this.notify("initialized");
  }

  async startThread() {
    const result = await this.request("thread/start", {
      model: this.config.codexModel,
      cwd: this.paths.repository,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      runtimeWorkspaceRoots: [this.paths.repository],
      serviceName: "agentconduit-native-claude-poc",
    });
    this.threadId = result?.thread?.id;
    if (!this.threadId) throw new Error("Codex did not return a thread id");
    this.record("codex_thread_ready", {
      model: result?.model ?? this.config.codexModel,
      ephemeral: result?.thread?.ephemeral === true,
    });
  }

  async runTurn(prompt) {
    const result = await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt }],
      effort: "low",
    });
    const turnId = result?.turn?.id;
    if (!turnId) throw new Error("Codex did not return a turn id");
    this.record("codex_turn_started", {
      turnIdHash: sha256(turnId),
      promptHash: sha256(prompt),
      promptBytes: Buffer.byteLength(prompt),
    });
    const completed = await this.waitForNotification(
      (notification) =>
        notification.method === "turn/completed" &&
        notification.params?.threadId === this.threadId &&
        notification.params?.turn?.id === turnId,
      this.config.stepTimeoutMs * 2,
    );
    const turn = completedTurnResult(completed.params?.turn);
    this.record("codex_turn_completed", {
      turnIdHash: sha256(turnId),
      status: turn.status,
      resultHash: sha256(turn.text),
      resultBytes: Buffer.byteLength(turn.text),
      agentMessageCount: turn.agentMessageCount,
      selectedPhase: turn.selectedPhase,
    });
    return turn;
  }

  async inspectSpawnedAgent() {
    if (this.completedSpawnCalls.size !== 1) return;
    const [spawn] = this.completedSpawnCalls.values();
    if (spawn.receiverThreadIds.length !== 1) return;
    const receiverThreadId = spawn.receiverThreadIds[0];
    this.spawnedAgentThreadId = receiverThreadId;
    const result = await this.request("thread/read", {
      threadId: receiverThreadId,
      includeTurns: false,
    });
    const thread =
      result?.thread && typeof result.thread === "object" ? result.thread : {};
    this.spawnedAgentRole =
      typeof thread.agentRole === "string" ? thread.agentRole : null;
    this.spawnedAgentCwdMatched = thread.cwd === this.paths.repository;
    this.record("codex_spawned_agent_inspected", {
      receiverThreadIdHash: sha256(receiverThreadId),
      role: this.spawnedAgentRole,
      cwdMatched: this.spawnedAgentCwdMatched,
    });
  }

  async close() {
    try {
      if (this.child.stdin.writable) this.child.stdin.end();
    } catch {
      // Continue with direct termination.
    }
    return stopChild(this.child, "codex", this.eventsPath);
  }
}

export function completedTurnResult(turn) {
  const agentMessages = Array.isArray(turn?.items)
    ? turn.items.filter(
        (item) =>
          item?.type === "agentMessage" && typeof item.text === "string",
      )
    : [];
  const finalAnswers = agentMessages.filter(
    (item) => item.phase === "final_answer",
  );
  const selected = finalAnswers.at(-1) ?? agentMessages.at(-1) ?? null;
  return {
    status: typeof turn?.status === "string" ? turn.status : null,
    text: selected?.text ?? "",
    agentMessageCount: agentMessages.length,
    selectedPhase: typeof selected?.phase === "string" ? selected.phase : null,
  };
}

function requireLiveOptIn() {
  if (process.env[LIVE_FLAG] !== "1") {
    throw new Error(
      `Refusing to start providers. Set ${LIVE_FLAG}=1 explicitly or use --dry-run.`,
    );
  }
}

export function requireSupportedLivePlatform(platform = process.platform) {
  if (platform !== "linux") {
    throw new Error(
      "The live native collaborator POC currently requires Linux or WSL for exact /proc process identity checks.",
    );
  }
}

function summarizeRuntimeEvents(events) {
  const started = events.find((event) => event.event === "claude_job_started");
  const terminal = [...events]
    .reverse()
    .find((event) => event.event === "claude_job_terminal");
  const runtimeStart = events.find(
    (event) => event.event === "runtime_started",
  );
  const toolCalls = events
    .filter((event) => event.event === "runtime_tool_called")
    .map((event) => event.tool);
  return {
    runtimeStarted: Boolean(runtimeStart),
    runtimeCwdMatched: runtimeStart?.cwdMatchesExpected === true,
    claudeStarted: Boolean(started),
    claudeCwdMatched: started?.cwdMatchesExpected === true,
    claudeStartLatencyMs: started?.startLatencyMs ?? null,
    terminalStatus: terminal?.status ?? null,
    directChildClosed: terminal?.childClosed === true,
    markerMatched: terminal?.markerMatched === true,
    toolUseCount: terminal?.toolUseCount ?? null,
    initObserved: terminal?.initObserved === true,
    advertisedToolCount: terminal?.advertisedToolCount ?? null,
    mcpServerCount: terminal?.mcpServerCount ?? null,
    runtimeToolCalls: toolCalls,
    claudeVersion:
      events.find((event) => event.event === "claude_initialized")?.version ??
      null,
    claudeModel:
      events.find((event) => event.event === "claude_initialized")?.model ??
      null,
  };
}

export function harnessFailures({
  codex,
  runtime,
  beforeGit,
  afterGit,
  turn,
  marker,
}) {
  const failures = [];
  const completedSpawnCalls =
    codex.completedSpawnCalls instanceof Map
      ? [...codex.completedSpawnCalls.values()]
      : [];
  if (completedSpawnCalls.length !== 1) {
    failures.push(
      `expected one completed native spawnAgent, observed ${completedSpawnCalls.length}`,
    );
  }
  const spawn =
    completedSpawnCalls.length === 1 ? completedSpawnCalls[0] : null;
  const receiverThreadId =
    spawn?.receiverThreadIds?.length === 1 ? spawn.receiverThreadIds[0] : null;
  if (
    spawn &&
    (spawn.eventThreadId !== codex.threadId ||
      spawn.senderThreadId !== codex.threadId ||
      spawn.status !== "completed")
  ) {
    failures.push(
      "the native spawnAgent was not a completed call from the parent thread",
    );
  }
  if (!receiverThreadId || codex.spawnedAgentThreadId !== receiverThreadId) {
    failures.push(
      "the native spawnAgent did not yield one inspected receiver thread",
    );
  }
  if (codex.spawnedAgentRole !== AGENT_NAME) {
    failures.push(
      "the spawned receiver did not have the claude_collaborator role",
    );
  }
  if (!codex.spawnedAgentCwdMatched) {
    failures.push("the spawned receiver cwd did not match the fixture");
  }

  const callsByThread =
    codex.runtimeToolCallsByThread instanceof Map
      ? codex.runtimeToolCallsByThread
      : new Map();
  const receiverCalls = receiverThreadId
    ? (callsByThread.get(receiverThreadId) ?? new Set())
    : new Set();
  const callsOnOtherThreads = [...callsByThread.entries()].some(
    ([threadId, calls]) => threadId !== receiverThreadId && calls.size > 0,
  );
  const completedMcpCalls =
    codex.completedRuntimeToolCalls instanceof Map
      ? [...codex.completedRuntimeToolCalls.values()]
      : [];
  const completedStartCount = completedMcpCalls.filter(
    (call) =>
      call.eventThreadId === receiverThreadId &&
      call.tool === "claude_start" &&
      call.status === "completed",
  ).length;
  const completedWaitCount = completedMcpCalls.filter(
    (call) =>
      call.eventThreadId === receiverThreadId &&
      call.tool === "claude_wait" &&
      call.status === "completed",
  ).length;
  const completedEventReadCount = completedMcpCalls.filter(
    (call) =>
      call.eventThreadId === receiverThreadId &&
      call.tool === "claude_events" &&
      call.status === "completed",
  ).length;
  const invalidCompletedMcpCall = completedMcpCalls.some(
    (call) =>
      call.eventThreadId !== receiverThreadId ||
      call.status !== "completed" ||
      !["claude_start", "claude_wait", "claude_events"].includes(call.tool),
  );
  if (
    completedStartCount !== 1 ||
    completedWaitCount < 1 ||
    completedEventReadCount < 1 ||
    invalidCompletedMcpCall
  ) {
    failures.push(
      "the completed MCP calls were not exactly one start plus bounded waits and event reads on the spawned receiver thread",
    );
  }
  if (
    !receiverCalls.has("claude_start") ||
    !receiverCalls.has("claude_wait") ||
    !receiverCalls.has("claude_events") ||
    receiverCalls.has("claude_cancel") ||
    callsOnOtherThreads
  ) {
    failures.push(
      "the local MCP calls were not bound exclusively to the spawned receiver thread",
    );
  }
  if (!runtime.runtimeStarted || !runtime.claudeStarted) {
    failures.push("the local runtime or Claude child did not start");
  }
  if (!runtime.runtimeCwdMatched || !runtime.claudeCwdMatched) {
    failures.push(
      "the local runtime or Claude child cwd did not match the fixture",
    );
  }
  if (runtime.terminalStatus !== "completed" || !runtime.markerMatched) {
    failures.push("Claude did not complete with the run-specific marker");
  }
  if (!runtime.directChildClosed) {
    failures.push("the direct Claude child was not confirmed closed");
  }
  if (runtime.toolUseCount !== 0) {
    failures.push("Claude emitted an unexpected tool use");
  }
  if (
    !runtime.initObserved ||
    runtime.advertisedToolCount !== 0 ||
    runtime.mcpServerCount !== 0
  ) {
    failures.push("Claude advertised unexpected runtime capabilities");
  }
  if (!runtime.runtimeToolCalls.includes("claude_start")) {
    failures.push("the native subagent did not call claude_start");
  }
  if (!runtime.runtimeToolCalls.includes("claude_wait")) {
    failures.push("the native subagent did not call claude_wait");
  }
  if (!runtime.runtimeToolCalls.includes("claude_events")) {
    failures.push("the native subagent did not call claude_events");
  }
  if (runtime.runtimeToolCalls.includes("claude_cancel")) {
    failures.push("the native subagent called claude_cancel after success");
  }
  if (turn.status !== "completed") {
    failures.push("the parent turn did not complete");
  }
  if (turn.text !== marker) {
    failures.push("the parent turn did not return the exact Claude marker");
  }
  if (
    beforeGit.head !== afterGit.head ||
    beforeGit.status !== afterGit.status
  ) {
    failures.push("the disposable Git fixture changed");
  }
  if (beforeGit.status !== "" || afterGit.status !== "") {
    failures.push("the disposable Git fixture was not clean");
  }
  return failures;
}

function assertHarnessResult(input) {
  const failures = harnessFailures(input);
  if (failures.length > 0) throw new Error(failures.join("; "));
}

async function runLiveHarness() {
  requireLiveOptIn();
  requireSupportedLivePlatform();
  const config = harnessConfiguration();
  const paths = createHarnessPaths(config);
  const marker = `CLAUDE_COLLABORATOR_POC_${randomBytes(12).toString("hex")}`;
  const markerHash = sha256(marker);
  let codex = null;
  let runtimePid = null;
  let cleanup = null;
  let failure = null;
  let result = null;
  let runtimeStateRemoved = false;
  const secrets = [
    marker,
    paths.runtimeRoot,
    paths.repository,
    paths.codexHome,
    paths.evidenceRoot,
    config.claudeCommand,
    config.codexCommand,
    SCRIPT_PATH,
    PROJECT_ROOT,
  ];
  try {
    const beforeGit = makeGitFixture(paths);
    const { authMode } = writeCodexConfiguration(paths, config, markerHash);
    recordEvent(paths.eventsPath, "harness_started", {
      markerHash,
      repositoryHash: sha256(paths.repository),
      initialHeadHash: sha256(beforeGit.head),
      initialClean: beforeGit.status === "",
      codexModel: config.codexModel,
      claudeModel: config.claudeModel,
      claudeBudgetUsd: config.budgetUsd,
      authMode,
    });
    codex = new CodexProcess({
      paths,
      config,
      eventsPath: paths.eventsPath,
    });
    await codex.initialize();
    await codex.startThread();
    const mainPrompt = [
      `Spawn exactly one native agent of type ${AGENT_NAME}.`,
      "Give it this bounded task:",
      `Ask the local Claude runtime to return exactly ${marker} and no other text.`,
      "Wait for that subagent to finish. Do not spawn or contact any other agent.",
      `Return exactly ${marker} only if the subagent returned it; otherwise report failure without inventing the marker.`,
    ].join("\n");
    const turn = await withTimeout(
      codex.runTurn(mainPrompt),
      config.timeoutMs,
      "native Claude collaborator POC timed out",
    );
    await codex.inspectSpawnedAgent();
    const afterGit = gitSnapshot(paths.repository);
    const runtimeEvents = readJsonLines(paths.runtimeLogPath);
    const runtime = summarizeRuntimeEvents(runtimeEvents);
    assertHarnessResult({ codex, runtime, beforeGit, afterGit, turn, marker });

    const runtimeState = existsSync(paths.runtimeStatePath)
      ? JSON.parse(readFileSync(paths.runtimeStatePath, "utf8"))
      : {};
    runtimePid = Number.isInteger(runtimeState.runtimePid)
      ? runtimeState.runtimePid
      : null;
    const claudePid = Number.isInteger(runtimeState.lastClaudePid)
      ? runtimeState.lastClaudePid
      : null;
    const directClaudeGone = claudePid ? !isProcessAlive(claudePid) : false;
    if (!directClaudeGone || runtimeState.lastClaudeClosed !== true) {
      throw new Error(
        "the direct Claude process remained live after completion",
      );
    }

    const retainedBeforeSummary = [
      existsSync(paths.eventsPath)
        ? readFileSync(paths.eventsPath, "utf8")
        : "",
      existsSync(paths.runtimeLogPath)
        ? readFileSync(paths.runtimeLogPath, "utf8")
        : "",
    ].join("\n");
    if (retainedBeforeSummary.includes(marker)) {
      throw new Error("retained evidence contained the raw run marker");
    }
    result = {
      beforeGit,
      afterGit,
      runtime,
      directClaudeGone,
      nativeSpawnAgentCount: codex.completedSpawnCalls.size,
      nativeRuntimeToolCallCount: codex.completedRuntimeToolCalls.size,
      codexVersion: versionFromUserAgent(codex.userAgent),
      spawnedAgentRole: codex.spawnedAgentRole,
      spawnedAgentCwdMatched: codex.spawnedAgentCwdMatched,
    };
  } catch (error) {
    failure = error;
  } finally {
    cleanup = await cleanupOwnedProcesses({
      codex,
      runtimePid,
      runtimeStatePath: paths.runtimeStatePath,
    });
    if (!cleanup.success) {
      const cleanupError = new Error(
        `owned process cleanup failed: ${cleanup.failures.join(", ")}`,
      );
      failure = failure
        ? new Error(
            `${errorShape(failure, secrets).message}; ${cleanupError.message}`,
          )
        : cleanupError;
    }
    if (cleanup.success) {
      try {
        rmSync(paths.runtimeRoot, { recursive: true, force: true });
      } catch (error) {
        failure = new Error(
          `${failure ? `${errorShape(failure, secrets).message}; ` : ""}runtime state removal failed: ${redactDiagnostic(error, secrets)}`,
        );
      }
      runtimeStateRemoved = !existsSync(paths.runtimeRoot);
      if (!runtimeStateRemoved && !failure) {
        failure = new Error("disposable runtime state was not removed");
      }
    }
    recordEvent(paths.eventsPath, "runtime_state_cleanup", {
      cleanupProven: cleanup.success,
      codexClosed: cleanup.codexClosed,
      runtimeClosed: cleanup.runtimeClosed,
      directClaudeClosed: cleanup.directClaudeClosed,
      removed: runtimeStateRemoved,
      preservedForRecovery: !cleanup.success && existsSync(paths.runtimeRoot),
    });
  }

  if (failure || !result) {
    const finalFailure =
      failure ?? new Error("live harness produced no result");
    recordEvent(paths.eventsPath, "harness_failed", {
      error: errorShape(finalFailure, secrets),
      cleanupFailures: cleanup?.failures ?? [],
    });
    writePrivateJson(paths.summaryPath, {
      success: false,
      experiment: "native-codex-subagent-local-claude-runtime",
      markerHash,
      error: errorShape(finalFailure, secrets),
      codexAppServerClosed: cleanup?.codexClosed === true,
      runtimeServerClosed: cleanup?.runtimeClosed === true,
      directClaudeChildClosed: cleanup?.directClaudeClosed === true,
      runtimeStateRemoved,
      runtimeStatePreservedForRecovery:
        cleanup?.success === false && existsSync(paths.runtimeRoot),
      evidenceFiles: ["events.jsonl", "runtime-events.jsonl", "summary.json"],
    });
    throw finalFailure;
  }

  const summary = {
    success: true,
    experiment: "native-codex-subagent-local-claude-runtime",
    agentName: AGENT_NAME,
    markerHash,
    nativeSpawnAgentCount: result.nativeSpawnAgentCount,
    nativeRuntimeToolCallCount: result.nativeRuntimeToolCallCount,
    spawnedAgentRole: result.spawnedAgentRole,
    spawnedAgentCwdMatched: result.spawnedAgentCwdMatched,
    runtimeMcpCallsBoundToSpawnedAgent: true,
    parentTurnCompletedWithExactResult: true,
    runtimeToolCalls: result.runtime.runtimeToolCalls,
    runtimeCwdMatched: result.runtime.runtimeCwdMatched,
    claudeCwdMatched: result.runtime.claudeCwdMatched,
    claudeStartReturnedPromptly:
      Number.isInteger(result.runtime.claudeStartLatencyMs) &&
      result.runtime.claudeStartLatencyMs < 3_000,
    claudeStartLatencyMs: result.runtime.claudeStartLatencyMs,
    claudeMarkerMatched: result.runtime.markerMatched,
    claudeToolUseCount: result.runtime.toolUseCount,
    claudeInitObserved: result.runtime.initObserved,
    claudeAdvertisedToolCount: result.runtime.advertisedToolCount,
    claudeMcpServerCount: result.runtime.mcpServerCount,
    directClaudeChildClosed:
      result.directClaudeGone && cleanup.directClaudeClosed,
    runtimeServerClosed: cleanup.runtimeClosed,
    codexAppServerClosed: cleanup.codexClosed,
    runtimeStateRemoved,
    gitHeadUnchanged: result.beforeGit.head === result.afterGit.head,
    gitCleanBeforeAndAfter:
      result.beforeGit.status === "" && result.afterGit.status === "",
    codexVersion: result.codexVersion,
    claudeCodeVersion: result.runtime.claudeVersion,
    codexModel: config.codexModel,
    claudeModel: result.runtime.claudeModel ?? config.claudeModel,
    claudeBudgetUsd: config.budgetUsd,
    evidenceFiles: ["events.jsonl", "runtime-events.jsonl", "summary.json"],
    limitations: [
      "experimental_version_sensitive_app_server_and_stream_protocols",
      "linux_or_wsl_process_identity_only",
      "direct_child_lifecycle_only",
      "disposable_local_poc_not_installed_product_support",
    ],
  };
  writePrivateJson(paths.summaryPath, summary);
  const retainedEvidence = [
    readFileSync(paths.eventsPath, "utf8"),
    existsSync(paths.runtimeLogPath)
      ? readFileSync(paths.runtimeLogPath, "utf8")
      : "",
    readFileSync(paths.summaryPath, "utf8"),
  ].join("\n");
  if (retainedEvidence.includes(marker)) {
    throw new Error("retained evidence contained the raw run marker");
  }
  console.log(
    JSON.stringify({ ...summary, evidenceRoot: paths.evidenceRoot }, null, 2),
  );
}

function printDryRun() {
  const config = harnessConfiguration();
  console.log(
    JSON.stringify(
      {
        live: false,
        requires: `${LIVE_FLAG}=1`,
        agentName: AGENT_NAME,
        nativeCodexSubagent: true,
        runtimeTransport: "local-stdio-mcp",
        runtimeTools: RUNTIME_TOOLS,
        asyncLifecycle: [
          "start",
          "cursor-progress-replay",
          "bounded-wait",
          "cancel",
        ],
        codexCommand: basename(config.codexCommand),
        claudeCommand: basename(config.claudeCommand),
        codexModel: config.codexModel,
        claudeModel: config.claudeModel,
        claudeBudgetUsd: config.budgetUsd,
        claudeJobTimeoutMs: config.jobTimeoutMs,
        sandbox: "read-only",
        claudeTools: [],
        disposableGitFixture: true,
        personalConfigurationChanged: false,
        providerCallsStarted: false,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    if (args.length !== 1) throw new Error("--help cannot be combined");
    console.log(HELP.trim());
    return;
  }
  if (args.includes("--dry-run")) {
    if (args.length !== 1) throw new Error("--dry-run cannot be combined");
    printDryRun();
    return;
  }
  if (args.includes("--runtime-server")) {
    if (args.length !== 1) {
      throw new Error("--runtime-server cannot be combined");
    }
    await runRuntimeServer();
    return;
  }
  if (args.length > 0) {
    throw new Error(`unknown argument ${args[0]}; use --help`);
  }
  await runLiveHarness();
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
