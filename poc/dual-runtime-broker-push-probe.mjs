#!/usr/bin/env node

/*
 * Disposable Claude + Codex + AgentConduit interoperability probe.
 *
 * The live mode owns every process it starts, creates a temporary Git
 * repository with one linked worktree, and uses a temporary SQLite broker.
 * It proves the useful end-to-end boundary:
 *
 *   Claude registers -> Claude sends a durable message -> Codex reads and
 *   acknowledges it -> two real worktree registrations contend for one
 *   integration target and only one lease wins.
 *
 * Provider-native push is deliberately not treated as delivery here. The
 * Codex recipient is started explicitly after the message is durable; this
 * keeps the result deterministic while the separate provider push probes test
 * steering. The broker message is considered delivered only after
 * message.inbox + message.ack succeed.
 *
 * No raw model stream, prompt, session token, bearer token, or authentication
 * file is written to the retained evidence directory. Authentication is
 * inherited from the caller. The Codex temporary home may contain a symlink
 * to the caller's existing auth.json, never a copied credential.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let Client;
let StreamableHTTPClientTransport;
try {
  ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
  ({ StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
} catch {
  // The root workspace intentionally does not depend on the MCP SDK directly.
  ({ Client } = await import(
    new URL(
      "../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
      import.meta.url,
    )
  ));
  ({ StreamableHTTPClientTransport } = await import(
    new URL(
      "../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
      import.meta.url,
    )
  ));
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const SERVER_ENTRY = join(PROJECT_ROOT, "apps/server/dist/main.js");
const LIVE_FLAG = "AGENTCONDUIT_RUN_DUAL_RUNTIME_POC";
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";
const CLAUDE_READY = "CLAUDE_READY";
const CLAUDE_SENT = "CLAUDE_MESSAGE_SENT";
const CODEX_READY = "CODEX_READY";
const CODEX_ACK = "CODEX_MESSAGE_ACK";
const ACTIVE_MESSAGE = "AGENTCONDUIT_E2E_MESSAGE_7C2B";
const LEASE_SOURCE = "feature/agentconduit-e2e";
const LEASE_TARGET = "main";

const HELP = `
AgentConduit dual-runtime broker POC

This is a live API experiment and is disabled unless ${LIVE_FLAG}=1 is set.
It starts one temporary AgentConduit HTTP broker, one Claude Code stream
process, and one Codex app-server process. It then verifies registration,
durable message send/read/ack, and real-Git integration lease contention.

Run (from the AgentConduit checkout):

  ${LIVE_FLAG}=1 node poc/dual-runtime-broker-push-probe.mjs

Useful environment variables:

  AGENTCONDUIT_DUAL_POC_EVIDENCE_PARENT  Parent directory for redacted evidence
  AGENTCONDUIT_DUAL_POC_TIMEOUT_MS        Overall timeout (default: 300000)
  AGENTCONDUIT_DUAL_POC_STEP_TIMEOUT_MS   Per-step timeout (default: 90000)
  AGENTCONDUIT_DUAL_POC_CLAUDE_BUDGET_USD Claude cap (default: 0.25)
  AGENTCONDUIT_DUAL_POC_CLAUDE_MODEL     Claude model/alias
  AGENTCONDUIT_DUAL_POC_CODEX_MODEL      Codex model/alias
  AGENTCONDUIT_CLAUDE_COMMAND            Claude executable (default: claude)
  AGENTCONDUIT_CODEX_COMMAND             Codex executable (default: codex)

Codex app-server's empty-form approval for this temporary AgentConduit server
is accepted automatically; all other server requests are declined.

Use --dry-run to inspect the launch shape without starting clients or making
API calls. The harness never mutates a real repository or branch.
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
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms without POSIX mode bits.
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function envValue(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function appendWslEnv(existing, variable, direction = "w") {
  const entries = String(existing ?? "")
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const name = variable.toUpperCase();
  if (
    !entries.some((entry) => entry.split("/", 1)[0]?.toUpperCase() === name)
  ) {
    entries.push(`${variable}/${direction}`);
  }
  return entries.join(":");
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function positiveBudget(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error(`${name} must be greater than 0 and at most 100`);
  }
  return value;
}

function errorShape(error, secret) {
  const message = error instanceof Error ? error.message : String(error);
  const secrets = Array.isArray(secret) ? secret : [secret];
  const redacted = secrets
    .filter((value) => typeof value === "string" && value.length > 0)
    .reduce(
      (value, valueToRedact) => value.split(valueToRedact).join("<redacted>"),
      message,
    );
  return {
    name: error instanceof Error ? error.name : "Error",
    message: redacted.slice(0, 240),
    ...(error && typeof error === "object" && "code" in error
      ? { code: String(error.code) }
      : {}),
  };
}

function redactDiagnostic(value, secrets = []) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return null;
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("<redacted>");
  }
  return text.slice(0, 240);
}

function summarizeClaudeMcpServers(value, secrets) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((server) => server && typeof server === "object")
    .map((server) => ({
      name: typeof server.name === "string" ? server.name : "unknown",
      status: typeof server.status === "string" ? server.status : "unknown",
      ...(server.error !== undefined
        ? { error: redactDiagnostic(server.error, secrets) }
        : {}),
    }));
}

function summarizeClaudeMcpErrors(value, secrets) {
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((entry) => {
      if (!entry || typeof entry !== "object")
        return { error: redactDiagnostic(entry, secrets) };
      return {
        ...(typeof entry.serverName === "string"
          ? { serverName: entry.serverName }
          : {}),
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
        ...(typeof entry.code === "string" ? { code: entry.code } : {}),
        ...(typeof entry.message === "string"
          ? { message: redactDiagnostic(entry.message, secrets) }
          : {}),
        ...(entry.error !== undefined
          ? { error: redactDiagnostic(entry.error, secrets) }
          : {}),
      };
    });
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .slice(0, 16)
      .map(([name, entry]) => ({
        serverName: name,
        error: redactDiagnostic(entry, secrets),
      }));
  }
  return [];
}

function diagnosticTextFlags(value) {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  return {
    hasError: /\berror\b|failed|failure|unable|cannot|can't/.test(text),
    hasAuth: /401|403|unauthori[sz]ed|forbidden|token|credential/.test(text),
    hasWorkspace: /workspace|repository|worktree|git/.test(text),
    hasRegistration: /agent[ ._-]?register|registration/.test(text),
    bytes: Buffer.byteLength(text),
  };
}

function summarizeToolResultText(value) {
  if (typeof value !== "string") return {};
  const knownErrorCodes = [
    "invalid_input",
    "forbidden",
    "not_found",
    "conflict",
    "busy",
    "unauthorized",
    "git_error",
    "internal_error",
  ];
  const observedCodes = knownErrorCodes.filter((code) => value.includes(code));
  const observedKeys = [
    ...value.matchAll(/(?:^|[,{\s])"([A-Za-z][A-Za-z0-9_]*)"\s*:/g),
  ].map((match) => match[1]);
  const heuristic = {
    ...(observedCodes.length > 0 ? { observedErrorCodes: observedCodes } : {}),
    ...(observedKeys.length > 0
      ? { observedJsonKeys: [...new Set(observedKeys)].sort() }
      : {}),
  };
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return heuristic;
    return {
      ...heuristic,
      jsonKeys: Object.keys(parsed).sort(),
      ...(typeof parsed.error === "string" ? { errorCode: parsed.error } : {}),
      ...(typeof parsed.message === "string"
        ? { messageFlags: diagnosticTextFlags(parsed.message) }
        : {}),
    };
  } catch {
    return heuristic;
  }
}

function summarizeCodexElicitationParams(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { parameterType: Array.isArray(value) ? "array" : typeof value };
  }
  const params = value;
  const requestedSchema =
    params.requestedSchema && typeof params.requestedSchema === "object"
      ? params.requestedSchema
      : null;
  const properties =
    requestedSchema?.properties &&
    typeof requestedSchema.properties === "object" &&
    !Array.isArray(requestedSchema.properties)
      ? requestedSchema.properties
      : null;
  const required = Array.isArray(requestedSchema?.required)
    ? requestedSchema.required.filter((entry) => typeof entry === "string")
    : [];
  return {
    parameterKeys: Object.keys(params).sort(),
    ...(typeof params.serverName === "string"
      ? { serverName: params.serverName }
      : {}),
    ...(typeof params.mode === "string" ? { mode: params.mode } : {}),
    ...(typeof params.message === "string"
      ? {
          messageFlags: diagnosticTextFlags(params.message),
          messageHash: sha256(params.message),
        }
      : {}),
    ...(typeof params.threadId === "string"
      ? { threadIdHash: sha256(params.threadId) }
      : {}),
    ...(typeof params.turnId === "string"
      ? { turnIdHash: sha256(params.turnId) }
      : {}),
    ...(typeof params.elicitationId === "string"
      ? { elicitationIdHash: sha256(params.elicitationId) }
      : {}),
    ...(params._meta && typeof params._meta === "object"
      ? { metaKeys: Object.keys(params._meta).sort() }
      : {}),
    ...(requestedSchema
      ? {
          requestedSchemaKeys: Object.keys(requestedSchema).sort(),
          requestedSchemaType:
            typeof requestedSchema.type === "string"
              ? requestedSchema.type
              : null,
          requestedSchemaRequired: required,
          requestedSchemaPropertyKeys: properties
            ? Object.keys(properties).sort()
            : [],
        }
      : {
          requestedSchemaType:
            params.requestedSchema === true
              ? "openai/form"
              : typeof params.requestedSchema,
        }),
  };
}

function isDisposableAgentConduitElicitation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (value.serverName !== "agentconduit" || value.mode !== "form") {
    return false;
  }
  const schema = value.requestedSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  if (schema.type !== "object") return false;
  const properties = schema.properties;
  if (
    properties !== undefined &&
    (!properties || typeof properties !== "object" || Array.isArray(properties))
  ) {
    return false;
  }
  if (properties && Object.keys(properties).length > 0) return false;
  if (Array.isArray(schema.required) && schema.required.length > 0)
    return false;
  return true;
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

async function freePort() {
  const listener = createServer();
  await new Promise((resolvePromise, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise, reject) =>
    listener.close((error) => (error ? reject(error) : resolvePromise())),
  );
  if (!port) throw new Error("could not reserve a local port");
  return port;
}

function createEvidenceRoot() {
  const parent = resolve(
    envValue("AGENTCONDUIT_DUAL_POC_EVIDENCE_PARENT", tmpdir()),
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const evidenceRoot = mkdtempSync(join(parent, "agentconduit-dual-runtime-"));
  try {
    chmodSync(evidenceRoot, 0o700);
  } catch {
    // Best effort only.
  }
  const events = join(evidenceRoot, "events.jsonl");
  const summary = join(evidenceRoot, "summary.json");
  const runtimeRoot = mkdtempSync(
    join(tmpdir(), "agentconduit-dual-runtime-state-"),
  );
  try {
    chmodSync(runtimeRoot, 0o700);
  } catch {
    // Best effort only.
  }
  return { evidenceRoot, events, summary, runtimeRoot };
}

function makeGitFixture(runtimeRoot) {
  const repository = join(runtimeRoot, "repository");
  const linkedWorktree = join(runtimeRoot, "codex-worktree");
  mkdirSync(repository, { recursive: true, mode: 0o700 });
  runGit(repository, ["init", "-q", "-b", "main"]);
  runGit(repository, ["config", "user.name", "AgentConduit E2E"]);
  runGit(repository, [
    "config",
    "user.email",
    "agentconduit-e2e@example.invalid",
  ]);
  writeFileSync(
    join(repository, "README.md"),
    "AgentConduit disposable E2E fixture\n",
  );
  runGit(repository, ["add", "README.md"]);
  runGit(repository, ["commit", "-qm", "initial fixture"]);
  runGit(repository, ["checkout", "-qb", LEASE_SOURCE]);
  writeFileSync(join(repository, "feature.txt"), "disposable feature\n");
  runGit(repository, ["add", "feature.txt"]);
  runGit(repository, ["commit", "-qm", "feature fixture"]);
  runGit(repository, ["checkout", "main"]);
  runGit(repository, [
    "worktree",
    "add",
    "-qb",
    "codex/agentconduit-e2e",
    linkedWorktree,
  ]);
  return {
    repository,
    linkedWorktree,
    repositoryHead: runGit(repository, ["rev-parse", "HEAD"]),
    sourceOid: runGit(repository, ["rev-parse", `${LEASE_SOURCE}^{commit}`]),
  };
}

function textContent(result) {
  const item = result?.content?.find?.(
    (candidate) => candidate.type === "text",
  );
  return item?.text ?? "";
}

function summarizeMcpEnvelope(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = textContent(result);
  return {
    resultType: result === null ? "null" : typeof result,
    resultKeys:
      result && typeof result === "object" ? Object.keys(result).sort() : [],
    contentTypes: content.map((item) =>
      item && typeof item === "object" && typeof item.type === "string"
        ? item.type
        : typeof item,
    ),
    textBytes: Buffer.byteLength(text),
    textHash: text ? sha256(text) : null,
    textFlags: diagnosticTextFlags(text),
    structuredKeys:
      result?.structuredContent && typeof result.structuredContent === "object"
        ? Object.keys(result.structuredContent).sort()
        : [],
    isError: result?.isError === true,
  };
}

function extractAgentRegistration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate =
    value.result &&
    typeof value.result === "object" &&
    !Array.isArray(value.result)
      ? value.result
      : value;
  if (
    typeof candidate.agentId !== "string" ||
    !/^agt_[0-9a-f]{32}$/.test(candidate.agentId) ||
    typeof candidate.sessionToken !== "string" ||
    !/^acs_[0-9a-f]{64}$/.test(candidate.sessionToken)
  ) {
    return null;
  }
  return {
    agentId: candidate.agentId,
    sessionToken: candidate.sessionToken,
    runtime: typeof candidate.runtime === "string" ? candidate.runtime : null,
    workspace:
      candidate.workspace && typeof candidate.workspace === "object"
        ? candidate.workspace
        : null,
  };
}

function summarizeAgentConduitArguments(value, paths) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { inputType: Array.isArray(value) ? "array" : typeof value };
  }
  const workspacePath =
    typeof value.workspacePath === "string" ? value.workspacePath : null;
  return {
    inputKeys: Object.keys(value).sort(),
    workspacePathHash: workspacePath ? sha256(workspacePath) : null,
    workspacePathMatchesFixture:
      workspacePath === paths.repository ||
      workspacePath === paths.linkedWorktree,
    workspacePathMatchesRepository: workspacePath === paths.repository,
    workspacePathMatchesLinkedWorktree: workspacePath === paths.linkedWorktree,
    runtime: typeof value.runtime === "string" ? value.runtime : null,
    sessionRefHash:
      typeof value.sessionRef === "string" ? sha256(value.sessionRef) : null,
  };
}

function parseToolResultValue(text, structuredContent) {
  let parsed = null;
  if (typeof text === "string" && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Some app-server adapters expose only structuredContent.
    }
  }
  return structuredContent ?? parsed;
}

function parseMcpResult(result) {
  const text = textContent(result);
  if (!text) throw new Error("MCP result did not contain text");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const error = new Error(
      `MCP result was not JSON (${JSON.stringify(summarizeMcpEnvelope(result))})`,
    );
    throw error;
  }
  return { value, isError: result.isError === true };
}

async function connectMcp(baseUrl, token, label) {
  const client = new Client({
    name: `agentconduit-dual-${label}`,
    version: "0.1.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    },
  );
  await client.connect(transport);
  return client;
}

async function callMcp(client, name, args) {
  return parseMcpResult(await client.callTool({ name, arguments: args }));
}

function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const attempt = async () => {
      try {
        const response = await fetch(`${baseUrl}/healthz`);
        if (response.ok) {
          resolvePromise();
          return;
        }
      } catch {
        // The child may still be binding its listener.
      }
      if (Date.now() >= deadline) {
        reject(new Error("broker health check timed out"));
        return;
      }
      setTimeout(attempt, 100);
    };
    void attempt();
  });
}

function attachChildDiagnostics(child, eventsPath, label) {
  const state = {
    stderrBytes: 0,
    stderrHash: createHash("sha256"),
    stdoutBytes: 0,
    stdoutHash: createHash("sha256"),
  };
  child.stderr?.on("data", (chunk) => {
    state.stderrBytes += Buffer.byteLength(chunk);
    state.stderrHash.update(chunk);
  });
  child.stdout?.on("data", (chunk) => {
    state.stdoutBytes += Buffer.byteLength(chunk);
    state.stdoutHash.update(chunk);
  });
  child.on("error", (error) => {
    appendJsonLine(eventsPath, {
      at: timestamp(),
      event: "child_error",
      label,
      error: errorShape(error),
    });
  });
  return state;
}

async function stopChild(child, label, eventsPath) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  appendJsonLine(eventsPath, {
    at: timestamp(),
    event: "child_stop_requested",
    label,
  });
  try {
    child.kill("SIGTERM");
  } catch {
    // It may have exited between the check and kill.
  }
  await Promise.race([
    new Promise((resolvePromise) => child.once("close", resolvePromise)),
    sleep(5_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best effort only.
    }
  }
}

async function startBroker(paths, eventsPath, config) {
  const port = await freePort();
  const token = `acpoc_${randomBytes(24).toString("hex")}`;
  const database = join(paths.runtimeRoot, "broker", "coordination.db");
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    [
      SERVER_ENTRY,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--db",
      database,
      "--allowed-root",
      paths.runtimeRoot,
    ],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, AGENTCONDUIT_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const diagnostics = attachChildDiagnostics(child, eventsPath, "broker");
  const baseUrl = `http://127.0.0.1:${port}`;
  appendJsonLine(eventsPath, {
    at: timestamp(),
    event: "broker_spawned",
    port,
    databasePathHash: sha256(database),
  });
  await waitForHealth(baseUrl, config.stepTimeoutMs);
  appendJsonLine(eventsPath, { at: timestamp(), event: "broker_ready" });
  return { child, token, baseUrl, diagnostics };
}

class ClaudeProcess {
  constructor({ paths, eventsPath, broker, config, sessionRef }) {
    this.paths = paths;
    this.eventsPath = eventsPath;
    this.broker = broker;
    this.config = config;
    this.sessionRef = sessionRef;
    this.resultWaiters = [];
    this.events = [];
    this.resultCount = 0;
    this.toolCalls = 0;
    this.agentConduitToolCalls = 0;
    this.registration = null;
    this.toolUseNames = new Map();
    this.toolResults = [];
    this.mcpServers = [];
    this.mcpServerErrors = [];
    this.mcpConnected = false;
    this.outputRemainder = "";
    const command = envValue("AGENTCONDUIT_CLAUDE_COMMAND", "claude");
    const model = envValue(
      "AGENTCONDUIT_DUAL_POC_CLAUDE_MODEL",
      DEFAULT_CLAUDE_MODEL,
    );
    const mcpConfig = {
      mcpServers: {
        agentconduit: {
          type: "http",
          url: `${broker.baseUrl}/mcp`,
          // Claude expands this environment reference in its inline config;
          // the token never has to be written to the config snapshot.
          headers: { Authorization: "Bearer ${AGENTCONDUIT_TOKEN}" },
        },
      },
    };
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(mcpConfig),
      "--settings",
      JSON.stringify({}),
      "--no-session-persistence",
      "--tools",
      "",
      // dontAsk denies MCP mutations unless they are explicitly allowlisted.
      // Keep the allowlist scoped to this disposable AgentConduit server; no
      // built-in filesystem or shell tools are enabled by this harness.
      "--allowed-tools",
      "mcp__agentconduit__*",
      "--permission-mode",
      "dontAsk",
      "--max-budget-usd",
      String(config.claudeBudgetUsd),
    ];
    if (model) args.push("--model", model);
    const childEnv = {
      ...process.env,
      AGENTCONDUIT_TOKEN: broker.token,
      NO_COLOR: "1",
      CLAUDE_CODE_DISABLE_TELEMETRY:
        process.env.CLAUDE_CODE_DISABLE_TELEMETRY ?? "1",
    };
    // The installed Claude command is a Windows executable when this probe is
    // run from WSL. WSL only forwards variables named in WSLENV; without this
    // entry Claude sees the literal ${AGENTCONDUIT_TOKEN} header and the broker
    // correctly returns 401. The token remains process-local and is never put
    // in the inline config or retained evidence.
    if (process.platform !== "win32") {
      childEnv.WSLENV = appendWslEnv(
        childEnv.WSLENV,
        "AGENTCONDUIT_TOKEN",
        "w",
      );
    }
    this.child = spawn(command, args, {
      cwd: paths.repository,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.diagnostics = attachChildDiagnostics(this.child, eventsPath, "claude");
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onOutput(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.on("exit", (code, signal) => {
      this.record("claude_exit", { code, signal });
      this.rejectWaiters(new Error("Claude process exited"));
    });
    this.child.on("close", (code, signal) => {
      this.record("claude_close", {
        code,
        signal,
        resultCount: this.resultCount,
      });
    });
    this.record("claude_spawned", {
      argumentCount: args.length,
      model,
      tokenForwarding: process.platform === "win32" ? "native" : "wslenv",
      sessionRefHash: sha256(sessionRef),
    });
  }

  record(event, fields = {}) {
    const value = { at: timestamp(), event, ...fields };
    this.events.push(value);
    appendJsonLine(this.eventsPath, value);
  }

  rejectWaiters(error) {
    for (const waiter of this.resultWaiters.splice(0)) waiter.reject(error);
  }

  onOutput(chunk) {
    this.outputRemainder += chunk;
    let newline;
    while ((newline = this.outputRemainder.indexOf("\n")) >= 0) {
      const line = this.outputRemainder.slice(0, newline).replace(/\r$/, "");
      this.outputRemainder = this.outputRemainder.slice(newline + 1);
      if (!line) continue;
      try {
        this.onObject(JSON.parse(line));
      } catch {
        this.record("claude_malformed_output", {
          bytes: Buffer.byteLength(line),
        });
      }
    }
  }

  onObject(value) {
    if (!value || typeof value !== "object") return;
    this.events.push(value);
    if (value.type === "system" && value.subtype === "init") {
      this.version =
        typeof value.claude_code_version === "string"
          ? value.claude_code_version
          : null;
      this.model = typeof value.model === "string" ? value.model : null;
      this.mcpServers = summarizeClaudeMcpServers(value.mcp_servers, [
        this.broker.token,
        this.broker.baseUrl,
      ]);
      this.mcpServerErrors = summarizeClaudeMcpErrors(value.mcp_server_errors, [
        this.broker.token,
        this.broker.baseUrl,
      ]);
      this.mcpConnected = this.mcpServers.some(
        (server) =>
          server.name === "agentconduit" && server.status === "connected",
      );
      this.record("claude_init", {
        version: this.version,
        model: this.model,
        mcpServers: this.mcpServers,
        mcpServerErrors: this.mcpServerErrors,
        toolCount: Array.isArray(value.tools) ? value.tools.length : null,
      });
    }
    if (value.type === "user") {
      const content = value.message?.content ?? value.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item?.type !== "tool_result") continue;
          const text = Array.isArray(item.content)
            ? item.content
                .filter(
                  (part) =>
                    part &&
                    part.type === "text" &&
                    typeof part.text === "string",
                )
                .map((part) => part.text)
                .join("\n")
            : typeof item.content === "string"
              ? item.content
              : "";
          const toolUseId =
            typeof item.tool_use_id === "string" ? item.tool_use_id : null;
          const toolName = toolUseId
            ? (this.toolUseNames.get(toolUseId) ?? null)
            : null;
          const isError = item.is_error === true;
          this.toolResults.push({
            name: toolName,
            isError,
          });
          this.record("claude_tool_result", {
            name: toolName,
            isError,
            toolUseIdHash: toolUseId ? sha256(toolUseId) : null,
            flags: diagnosticTextFlags(text),
            ...summarizeToolResultText(text),
          });
          const parsed = parseToolResultValue(text, null);
          const registration = extractAgentRegistration(parsed);
          if (registration) {
            this.registration = registration;
            this.record("claude_registration_observed", {
              agentIdHash: sha256(registration.agentId),
              runtime: registration.runtime,
              repositoryIdHash:
                typeof registration.workspace?.repositoryId === "string"
                  ? sha256(registration.workspace.repositoryId)
                  : null,
              worktreeIdHash:
                typeof registration.workspace?.worktreeId === "string"
                  ? sha256(registration.workspace.worktreeId)
                  : null,
            });
          }
        }
      }
    }
    if (value.type === "assistant") {
      const content = value.message?.content ?? value.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item?.type === "tool_use") {
            this.toolCalls += 1;
            const name = typeof item.name === "string" ? item.name : "unknown";
            if (typeof item.id === "string")
              this.toolUseNames.set(item.id, name);
            if (name.includes("agentconduit")) this.agentConduitToolCalls += 1;
            const input =
              item.input && typeof item.input === "object" ? item.input : {};
            const workspacePath =
              typeof input.workspacePath === "string"
                ? input.workspacePath
                : null;
            this.record("claude_tool_call", {
              name,
              ...(name.includes("agentconduit")
                ? {
                    inputKeys: Object.keys(input).sort(),
                    workspacePathHash: workspacePath
                      ? sha256(workspacePath)
                      : null,
                    workspacePathMatchesRepository:
                      workspacePath === this.paths.repository,
                    runtime:
                      typeof input.runtime === "string" ? input.runtime : null,
                    sessionRefHash:
                      typeof input.sessionRef === "string"
                        ? sha256(input.sessionRef)
                        : null,
                  }
                : {}),
            });
          }
        }
      }
    }
    if (value.type === "result") {
      this.resultCount += 1;
      const text = typeof value.result === "string" ? value.result.trim() : "";
      const markers = [CLAUDE_READY, CLAUDE_SENT];
      const observed = markers.filter((marker) => text.includes(marker));
      const result = {
        number: this.resultCount,
        text,
        subtype: typeof value.subtype === "string" ? value.subtype : null,
        observed,
      };
      this.record("claude_result", {
        number: result.number,
        bytes: Buffer.byteLength(text),
        sha256: sha256(text),
        observed,
        subtype: result.subtype,
        flags: diagnosticTextFlags(text),
      });
      for (const waiter of [...this.resultWaiters]) {
        if (waiter.predicate(result)) {
          this.resultWaiters.splice(this.resultWaiters.indexOf(waiter), 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(result);
        }
      }
    }
    if (value.type === "error") {
      this.record("claude_error", {
        subtype: typeof value.subtype === "string" ? value.subtype : null,
        code: typeof value.code === "string" ? value.code : null,
      });
    }
  }

  send(label, content) {
    const wire = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });
    JSON.parse(wire);
    if (!this.child.stdin.writable || this.child.stdin.destroyed) {
      throw new Error("Claude stdin is not writable");
    }
    this.child.stdin.write(`${wire}\n`);
    this.record("claude_jsonl_sent", {
      label,
      bytes: Buffer.byteLength(wire) + 1,
      sha256: sha256(wire),
    });
  }

  waitForResult(predicate, timeoutMs) {
    for (const event of this.events) {
      if (event?.text !== undefined && predicate(event))
        return Promise.resolve(event);
    }
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: resolvePromise,
        reject,
        timeout: setTimeout(() => {
          const index = this.resultWaiters.indexOf(waiter);
          if (index >= 0) this.resultWaiters.splice(index, 1);
          reject(new Error("Claude result wait timed out"));
        }, timeoutMs),
      };
      this.resultWaiters.push(waiter);
    });
  }

  async close() {
    try {
      if (this.child.stdin.writable) this.child.stdin.end();
    } catch {
      // Best effort.
    }
    await stopChild(this.child, "claude", this.eventsPath);
  }
}

class CodexProcess {
  constructor({ paths, eventsPath, broker, config, sessionRef }) {
    this.paths = paths;
    this.eventsPath = eventsPath;
    this.broker = broker;
    this.config = config;
    this.sessionRef = sessionRef;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.notifications = [];
    this.outputRemainder = "";
    this.turnTexts = new Map();
    this.mcpStartupStatuses = new Map();
    this.mcpReady = false;
    this.agentConduitToolCalls = 0;
    this.registration = null;
    this.toolResults = [];
    const command = envValue("AGENTCONDUIT_CODEX_COMMAND", "codex");
    const model = envValue(
      "AGENTCONDUIT_DUAL_POC_CODEX_MODEL",
      DEFAULT_CODEX_MODEL,
    );
    const codexHome = join(paths.runtimeRoot, "codex-home");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const configuredCodexHome = envValue("CODEX_HOME", "");
    const authSource = configuredCodexHome
      ? join(configuredCodexHome, "auth.json")
      : join(envValue("HOME", ""), ".codex", "auth.json");
    let authMode = "inherited_environment";
    if (existsSync(authSource)) {
      try {
        symlinkSync(authSource, join(codexHome, "auth.json"));
        authMode = "temporary_symlink";
      } catch {
        // The child may still authenticate through an inherited API key.
      }
    }
    const configToml = [
      `[mcp_servers.agentconduit]`,
      `url = "${broker.baseUrl}/mcp"`,
      `bearer_token_env_var = "AGENTCONDUIT_TOKEN"`,
      `required = true`,
      `startup_timeout_sec = 20`,
      `tool_timeout_sec = 90`,
      "",
      `[projects."${paths.linkedWorktree}"]`,
      `trust_level = "trusted"`,
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), configToml, { mode: 0o600 });
    this.codexHome = codexHome;
    this.authMode = authMode;
    const childEnv = { ...process.env };
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
    Object.assign(childEnv, {
      CODEX_HOME: codexHome,
      AGENTCONDUIT_TOKEN: broker.token,
      RUST_LOG: "warn",
    });
    this.child = spawn(
      command,
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
        "features.multi_agent=false",
      ],
      {
        cwd: paths.linkedWorktree,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.diagnostics = attachChildDiagnostics(this.child, eventsPath, "codex");
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onOutput(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.on("exit", (code, signal) => {
      this.record("codex_exit", { code, signal });
      for (const request of this.pending.values())
        request.reject(new Error("Codex app-server exited"));
      this.pending.clear();
      this.rejectWaiters(new Error("Codex app-server exited"));
    });
    this.child.on("close", (code, signal) =>
      this.record("codex_close", { code, signal }),
    );
    this.record("codex_spawned", {
      model,
      authMode,
      sessionRefHash: sha256(sessionRef),
    });
    this.model = model;
  }

  record(event, fields = {}) {
    const value = { at: timestamp(), event, ...fields };
    appendJsonLine(this.eventsPath, value);
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
        resolve: (value) => {
          clearTimeout(timeout);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        method,
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
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(
          `${request.method}: ${message.error.message ?? "RPC error"}`,
        );
        error.rpcError = message.error;
        request.reject(error);
      } else {
        request.resolve(message.result);
      }
      this.record("codex_response", {
        id: message.id,
        method: request.method,
        errorCode: message.error?.code ?? null,
      });
      return;
    }
    if (message.method === "mcpServer/startupStatus/updated") {
      const params =
        message.params && typeof message.params === "object"
          ? message.params
          : {};
      const statusValue = params.status;
      const status =
        typeof statusValue === "string"
          ? statusValue
          : statusValue && typeof statusValue === "object"
            ? ([statusValue.status, statusValue.state, statusValue.phase].find(
                (value) => typeof value === "string",
              ) ?? null)
            : ([params.state, params.phase].find(
                (value) => typeof value === "string",
              ) ?? null);
      const serverName = [
        params.serverName,
        params.name,
        params.mcpServerName,
      ].find((value) => typeof value === "string");
      const errorValue =
        (statusValue &&
          typeof statusValue === "object" &&
          (statusValue.error ?? statusValue.message)) ??
        params.error ??
        params.message;
      const summary = {
        serverName: serverName ?? "unknown",
        status,
        ...(errorValue !== undefined &&
        errorValue !== null &&
        errorValue !== false
          ? {
              error: redactDiagnostic(errorValue, [
                this.broker.token,
                this.broker.baseUrl,
              ]),
            }
          : {}),
        parameterKeys: Object.keys(params).sort(),
        ...(statusValue && typeof statusValue === "object"
          ? { statusKeys: Object.keys(statusValue).sort() }
          : {}),
      };
      this.record("codex_mcp_startup_status", summary);
      if (serverName === "agentconduit") {
        if (status === "ready" || status === "connected") this.mcpReady = true;
        if (status === "failed" || status === "error") this.mcpReady = false;
        this.mcpStartupStatuses.set(serverName, status);
      }
    }
    if (
      message.method === "item/started" ||
      message.method === "item/completed"
    ) {
      const item =
        message.params?.item && typeof message.params.item === "object"
          ? message.params.item
          : {};
      const itemType = typeof item.type === "string" ? item.type : null;
      const toolName =
        [item.tool, item.name, item.toolName, item.server].find(
          (value) => typeof value === "string",
        ) ?? null;
      if (
        (toolName && toolName.toLowerCase().includes("agentconduit")) ||
        (item.server === "agentconduit" && itemType)
      ) {
        this.agentConduitToolCalls += 1;
      }
      this.record("codex_item", {
        phase: message.method === "item/started" ? "started" : "completed",
        itemType,
        itemIdHash: typeof item.id === "string" ? sha256(item.id) : null,
        toolName,
      });
      if (message.method === "item/completed" && itemType === "mcpToolCall") {
        const result =
          item.result && typeof item.result === "object" ? item.result : null;
        const content = Array.isArray(result?.content) ? result.content : [];
        const text = content
          .filter(
            (part) =>
              part && part.type === "text" && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n");
        const structured =
          result?.structuredContent &&
          typeof result.structuredContent === "object"
            ? result.structuredContent.result
            : null;
        const parsed = parseToolResultValue(text, structured);
        const registration = extractAgentRegistration(parsed);
        const isError =
          result?.isError === true ||
          Boolean(item.error) ||
          item.status === "failed";
        const argumentSummary = summarizeAgentConduitArguments(
          item.arguments,
          this.paths,
        );
        this.toolResults.push({
          server: typeof item.server === "string" ? item.server : null,
          tool: typeof item.tool === "string" ? item.tool : null,
          isError,
        });
        this.record("codex_tool_result", {
          server: typeof item.server === "string" ? item.server : null,
          tool: typeof item.tool === "string" ? item.tool : null,
          ...argumentSummary,
          status: typeof item.status === "string" ? item.status : null,
          resultKeys: result ? Object.keys(result).sort() : [],
          contentTypes: content.map((part) =>
            part && typeof part === "object" && typeof part.type === "string"
              ? part.type
              : typeof part,
          ),
          textBytes: Buffer.byteLength(text),
          textHash: text ? sha256(text) : null,
          textFlags: diagnosticTextFlags(text),
          ...summarizeToolResultText(text),
          resultIsError: isError,
          registrationObserved: Boolean(registration),
        });
        if (registration) {
          this.registration = registration;
          this.record("codex_registration_observed", {
            agentIdHash: sha256(registration.agentId),
            runtime: registration.runtime,
            repositoryIdHash:
              typeof registration.workspace?.repositoryId === "string"
                ? sha256(registration.workspace.repositoryId)
                : null,
            worktreeIdHash:
              typeof registration.workspace?.worktreeId === "string"
                ? sha256(registration.workspace.worktreeId)
                : null,
          });
        }
      }
    }
    if (Object.hasOwn(message, "id") && message.method) {
      this.record("codex_server_request", {
        id: message.id,
        method: message.method,
      });
      let result;
      if (message.method === "mcpServer/elicitation/request") {
        const params =
          message.params && typeof message.params === "object"
            ? message.params
            : {};
        this.record("codex_mcp_elicitation_request", {
          id: message.id,
          ...summarizeCodexElicitationParams(params),
        });
        // MCP elicitation responses use `action`, not the approval API's
        // `decision`. Accept only the empty form that Codex uses to approve
        // this disposable AgentConduit coordination tool; reject any other
        // server, mode, or schema without prompting or granting access.
        const accepted =
          params.threadId === this.threadId &&
          isDisposableAgentConduitElicitation(params);
        const action = accepted ? "accept" : "decline";
        result = {
          action,
          ...(action === "accept" ? { content: {} } : {}),
        };
        this.record("codex_mcp_elicitation_response", {
          id: message.id,
          action,
          accepted,
        });
      } else if (
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval" ||
        message.method === "item/permissions/requestApproval" ||
        message.method === "execCommandApproval" ||
        message.method === "applyPatchApproval"
      ) {
        result = { decision: "decline" };
      } else if (message.method === "item/tool/requestUserInput") {
        result = { answers: {} };
      } else {
        // The POC uses approvalPolicy=never/read-only. Decline any unexpected
        // request rather than allowing a model to mutate the fixture.
        result = { decision: "decline" };
      }
      this.send({ id: message.id, result });
      return;
    }
    if (message.method) {
      const item = { ...message, at: timestamp() };
      this.notifications.push(item);
      this.record("codex_notification", { method: message.method });
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(item)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(item);
        }
      }
      if (
        message.method === "item/agentMessage/delta" &&
        message.params?.turnId &&
        typeof message.params.delta === "string"
      ) {
        const prior = this.turnTexts.get(message.params.turnId) ?? "";
        this.turnTexts.set(message.params.turnId, prior + message.params.delta);
      }
    }
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  waitForNotification(predicate, timeoutMs = this.config.stepTimeoutMs) {
    for (const item of this.notifications) {
      if (predicate(item)) return Promise.resolve(item);
    }
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: resolvePromise,
        reject,
        timeout: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Codex notification wait timed out"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "agentconduit-dual-poc",
        title: "AgentConduit dual POC",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.record("codex_initialized", {
      userAgent:
        typeof result?.userAgent === "string" ? result.userAgent : null,
    });
    this.notify("initialized");
  }

  async startThread() {
    const result = await this.request("thread/start", {
      model: this.model,
      cwd: this.paths.linkedWorktree,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      runtimeWorkspaceRoots: [this.paths.linkedWorktree],
      serviceName: "agentconduit-dual-poc",
    });
    this.threadId = result?.thread?.id;
    if (!this.threadId) throw new Error("Codex did not return a thread id");
    this.record("codex_thread_ready", {
      model: result?.model ?? this.model,
      threadEphemeral: result?.thread?.ephemeral === true,
    });
  }

  async turn(input, label) {
    const result = await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: input }],
      effort: "low",
    });
    const turnId = result?.turn?.id;
    if (!turnId) throw new Error("Codex did not return a turn id");
    this.turnTexts.set(turnId, "");
    this.record("codex_turn_started", { label, turnIdHash: sha256(turnId) });
    const completed = await this.waitForNotification(
      (item) =>
        item.method === "turn/completed" && item.params?.turn?.id === turnId,
      this.config.stepTimeoutMs * 2,
    );
    const text = this.turnTexts.get(turnId) ?? "";
    const markers = [CODEX_READY, CODEX_ACK];
    const observed = markers.filter((marker) => text.includes(marker));
    this.record("codex_turn_completed", {
      label,
      status: completed.params?.turn?.status ?? null,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
      observed,
    });
    return {
      turnId,
      text,
      observed,
      status: completed.params?.turn?.status ?? null,
    };
  }

  async close() {
    await stopChild(this.child, "codex", this.eventsPath);
  }
}

function configFromEnvironment() {
  return {
    timeoutMs: boundedInteger(
      "AGENTCONDUIT_DUAL_POC_TIMEOUT_MS",
      300_000,
      30_000,
      900_000,
    ),
    stepTimeoutMs: boundedInteger(
      "AGENTCONDUIT_DUAL_POC_STEP_TIMEOUT_MS",
      90_000,
      10_000,
      300_000,
    ),
    claudeBudgetUsd: positiveBudget(
      "AGENTCONDUIT_DUAL_POC_CLAUDE_BUDGET_USD",
      0.25,
    ),
    claudeModel: envValue(
      "AGENTCONDUIT_DUAL_POC_CLAUDE_MODEL",
      DEFAULT_CLAUDE_MODEL,
    ),
    codexModel: envValue(
      "AGENTCONDUIT_DUAL_POC_CODEX_MODEL",
      DEFAULT_CODEX_MODEL,
    ),
  };
}

function printDryRun(config) {
  console.log(
    JSON.stringify(
      {
        live: false,
        requires: `${LIVE_FLAG}=1`,
        claudeCommand: envValue("AGENTCONDUIT_CLAUDE_COMMAND", "claude"),
        claudeModel: config.claudeModel,
        claudeBudgetUsd: config.claudeBudgetUsd,
        codexCommand: envValue("AGENTCONDUIT_CODEX_COMMAND", "codex"),
        codexModel: config.codexModel,
        note: "No broker, Git repository, client process, credential, or API call was started.",
      },
      null,
      2,
    ),
  );
}

async function runLeaseContention(
  client,
  paths,
  repositoryId,
  eventsPath,
  stepTimeoutMs,
) {
  const firstRegistration = await callMcp(client, "agent.register", {
    runtime: "e2e-lease-claude",
    workspacePath: paths.repository,
    sessionRef: "dual-lease-claude",
  });
  const secondRegistration = await callMcp(client, "agent.register", {
    runtime: "e2e-lease-codex",
    workspacePath: paths.linkedWorktree,
    sessionRef: "dual-lease-codex",
  });
  const first = firstRegistration.value;
  const second = secondRegistration.value;
  if (firstRegistration.isError || secondRegistration.isError) {
    throw new Error("lease harness registration failed");
  }
  const requestOne = await callMcp(client, "integration.enqueue", {
    agentId: first.agentId,
    sessionToken: first.sessionToken,
    workspacePath: paths.repository,
    sourceRef: LEASE_SOURCE,
    targetRef: LEASE_TARGET,
  });
  const requestTwo = await callMcp(client, "integration.enqueue", {
    agentId: second.agentId,
    sessionToken: second.sessionToken,
    workspacePath: paths.linkedWorktree,
    sourceRef: LEASE_SOURCE,
    targetRef: LEASE_TARGET,
  });
  const firstRequestId = requestOne.value.requestId;
  const secondRequestId = requestTwo.value.requestId;
  const claimed = await callMcp(client, "integration.claim", {
    agentId: first.agentId,
    sessionToken: first.sessionToken,
    requestId: firstRequestId,
    workspacePath: paths.repository,
  });
  const blocked = await callMcp(client, "integration.claim", {
    agentId: second.agentId,
    sessionToken: second.sessionToken,
    requestId: secondRequestId,
    workspacePath: paths.linkedWorktree,
  });
  const winner = !claimed.isError && claimed.value.status === "claimed";
  const conflict = blocked.isError && blocked.value.error === "conflict";
  appendJsonLine(eventsPath, {
    at: timestamp(),
    event: "lease_contention",
    winner,
    conflict,
    repositoryIdHash: sha256(repositoryId),
  });
  // Leave the temporary broker in a clean terminal state.
  await callMcp(client, "integration.cancel", {
    agentId: second.agentId,
    sessionToken: second.sessionToken,
    requestId: secondRequestId,
  });
  await callMcp(client, "integration.complete", {
    agentId: first.agentId,
    sessionToken: first.sessionToken,
    requestId: firstRequestId,
    workspacePath: paths.repository,
    outcome: "cancelled",
    note: "disposable dual-runtime POC cleanup",
  });
  return { winner, conflict };
}

async function runHarness() {
  if (process.env[LIVE_FLAG] !== "1") {
    throw new Error(
      `Refusing to start clients or make API calls. Set ${LIVE_FLAG}=1 explicitly (or use --dry-run).`,
    );
  }
  const config = configFromEnvironment();
  const paths = createEvidenceRoot();
  const eventsPath = paths.events;
  const state = {
    startedAt: timestamp(),
    success: false,
    broker: false,
    claude: false,
    codex: false,
    sameRepository: false,
    distinctWorktrees: false,
    messageSent: false,
    messagePendingBeforeAck: false,
    messageAcknowledged: false,
    leaseWinner: false,
    leaseConflict: false,
    failure: null,
  };
  let broker;
  let claude;
  let codex;
  let client;
  const deadline = Date.now() + config.timeoutMs;
  const record = (event, fields = {}) =>
    appendJsonLine(eventsPath, { at: timestamp(), event, ...fields });
  record("harness_start", {
    runtimeEvidenceDir: paths.evidenceRoot,
    config: {
      timeoutMs: config.timeoutMs,
      stepTimeoutMs: config.stepTimeoutMs,
      claudeBudgetUsd: config.claudeBudgetUsd,
      claudeModel: config.claudeModel,
      codexModel: config.codexModel,
    },
  });
  try {
    if (!existsSync(SERVER_ENTRY)) {
      throw new Error(
        "built AgentConduit server is missing; run pnpm build first",
      );
    }
    const fixture = makeGitFixture(paths.runtimeRoot);
    const runPaths = { ...paths, ...fixture };
    record("git_fixture_ready", {
      repositoryPathHash: sha256(fixture.repository),
      linkedWorktreePathHash: sha256(fixture.linkedWorktree),
      sourceOidHash: sha256(fixture.sourceOid),
      targetOidHash: sha256(fixture.repositoryHead),
    });
    broker = await startBroker(paths, eventsPath, config);
    state.broker = true;
    client = await connectMcp(broker.baseUrl, broker.token, "coordinator");
    claude = new ClaudeProcess({
      paths: runPaths,
      eventsPath,
      broker,
      config,
      sessionRef: "dual-claude-runtime",
    });
    claude.send(
      "registration",
      [
        "You are the Claude participant in a controlled AgentConduit interoperability test.",
        "Use the AgentConduit MCP tool agent.register exactly once.",
        `Pass runtime exactly claude-code, workspacePath exactly ${fixture.repository}, and sessionRef exactly dual-claude-runtime.`,
        `After the tool succeeds, reply ${CLAUDE_READY} only. Do not call other tools or inspect files.`,
      ].join(" "),
    );
    const claudeReady = await claude.waitForResult(
      (result) => result.observed.includes(CLAUDE_READY),
      config.stepTimeoutMs,
    );
    if (!claude.mcpConnected) {
      throw new Error(
        `Claude AgentConduit MCP was not connected (${JSON.stringify(
          claude.mcpServers,
        )}; errors=${JSON.stringify(claude.mcpServerErrors)})`,
      );
    }
    if (claude.agentConduitToolCalls < 1) {
      throw new Error(
        "Claude returned its marker without an observed AgentConduit MCP tool call",
      );
    }
    if (!claude.registration) {
      throw new Error(
        "Claude registration result was not observed in the MCP tool result",
      );
    }
    if (
      !claude.toolResults.some(
        (result) =>
          result.name === "mcp__agentconduit__agent_register" &&
          result.isError === false,
      )
    ) {
      throw new Error("Claude agent.register did not complete successfully");
    }
    state.claude = true;
    record("claude_registration_turn_complete", {
      resultNumber: claudeReady.number,
      toolCalls: claude.toolCalls,
      agentConduitToolCalls: claude.agentConduitToolCalls,
    });
    const afterClaude = await callMcp(client, "agent.list", {});
    record("agent_list_after_claude", {
      isError: afterClaude.isError,
      valueType: Array.isArray(afterClaude.value)
        ? "array"
        : typeof afterClaude.value,
      count: Array.isArray(afterClaude.value) ? afterClaude.value.length : null,
      runtimes: Array.isArray(afterClaude.value)
        ? afterClaude.value.map((agent) => agent?.runtime).filter(Boolean)
        : [],
    });

    codex = new CodexProcess({
      paths: runPaths,
      eventsPath,
      broker,
      config,
      sessionRef: "dual-codex-runtime",
    });
    await codex.initialize();
    await codex.startThread();
    const codexReady = await codex.turn(
      [
        "You are the Codex participant in a controlled AgentConduit interoperability test.",
        "Use the AgentConduit MCP tool agent.register exactly once.",
        `Pass runtime exactly codex, workspacePath exactly ${fixture.linkedWorktree}, and sessionRef exactly dual-codex-runtime.`,
        `After the tool succeeds, reply ${CODEX_READY} only. Do not use shell or other tools.`,
      ].join(" "),
      "registration",
    );
    if (!codexReady.observed.includes(CODEX_READY)) {
      throw new Error("Codex registration marker was not observed");
    }
    if (!codex.mcpReady) {
      throw new Error(
        "Codex AgentConduit MCP startup did not reach ready status",
      );
    }
    if (codex.agentConduitToolCalls < 1) {
      throw new Error(
        "Codex returned its marker without an observed AgentConduit MCP tool call",
      );
    }
    if (!codex.registration) {
      throw new Error(
        "Codex registration result was not observed in the MCP tool result",
      );
    }
    if (
      !codex.toolResults.some(
        (result) =>
          result.server === "agentconduit" &&
          result.tool === "agent.register" &&
          result.isError === false,
      )
    ) {
      throw new Error("Codex agent.register did not complete successfully");
    }
    state.codex = true;
    record("codex_registration_turn_complete", {
      agentConduitToolCalls: codex.agentConduitToolCalls,
      mcpReady: codex.mcpReady,
    });

    const listed = await callMcp(client, "agent.list", {});
    if (listed.isError || !Array.isArray(listed.value)) {
      throw new Error("agent.list did not return a list");
    }
    const claudeAgent = listed.value.find(
      (agent) => agent.runtime === "claude-code",
    );
    const codexAgent = listed.value.find((agent) => agent.runtime === "codex");
    if (!claudeAgent || !codexAgent) {
      throw new Error(
        "real Claude/Codex registrations were not visible to the broker",
      );
    }
    if (
      claudeAgent.agentId !== claude.registration.agentId ||
      codexAgent.agentId !== codex.registration.agentId
    ) {
      throw new Error(
        "broker presence did not match the runtime-observed registrations",
      );
    }
    record("agent_list_after_codex", {
      count: listed.value.length,
      runtimes: listed.value.map((agent) => agent?.runtime).filter(Boolean),
    });
    state.sameRepository =
      claudeAgent.workspace.repositoryId === codexAgent.workspace.repositoryId;
    state.distinctWorktrees =
      claudeAgent.workspace.worktreeId !== codexAgent.workspace.worktreeId;
    record("registrations_verified", {
      sameRepository: state.sameRepository,
      distinctWorktrees: state.distinctWorktrees,
      repositoryIdHash: sha256(claudeAgent.workspace.repositoryId),
    });
    if (!state.sameRepository || !state.distinctWorktrees) {
      throw new Error(
        "Claude and Codex did not register distinct worktrees in one repository scope",
      );
    }

    claude.send(
      "message_send",
      [
        "Now send one durable AgentConduit message.",
        `Call agent.list if needed, then call message.send with recipientAgentId exactly ${codexAgent.agentId}.`,
        `Use this exact message body: ${ACTIVE_MESSAGE}.`,
        "After message.send succeeds, reply exactly CLAUDE_MESSAGE_SENT. Do not call other tools.",
      ].join(" "),
    );
    const sentResult = await claude.waitForResult(
      (result) => result.observed.includes(CLAUDE_SENT),
      config.stepTimeoutMs,
    );
    if (
      !claude.toolResults.some(
        (result) =>
          result.name === "mcp__agentconduit__message_send" &&
          result.isError === false,
      )
    ) {
      throw new Error("Claude message.send did not complete successfully");
    }
    state.messageSent = true;
    record("claude_message_send_complete", { resultNumber: sentResult.number });

    const pendingInbox = await callMcp(client, "message.inbox", {
      agentId: codex.registration.agentId,
      sessionToken: codex.registration.sessionToken,
    });
    const pendingMessages = Array.isArray(pendingInbox.value)
      ? pendingInbox.value
      : [];
    const pending = pendingMessages.find(
      (message) => message.body === ACTIVE_MESSAGE,
    );
    state.messagePendingBeforeAck = Boolean(pending) && !pending.acknowledgedAt;
    record("message_pending_verified", {
      pending: state.messagePendingBeforeAck,
      messageCount: pendingMessages.length,
    });
    if (!pending || !state.messagePendingBeforeAck) {
      throw new Error("message was not pending before Codex acknowledgement");
    }

    const codexAck = await codex.turn(
      [
        "Process the pending AgentConduit message now.",
        "Call message.inbox using the agent registration context you already established.",
        `Find the message whose body is exactly ${ACTIVE_MESSAGE}, then call message.ack for that messageId.`,
        `After the acknowledgement succeeds, reply ${CODEX_ACK} only. Do not use shell or other tools.`,
      ].join(" "),
      "message_ack",
    );
    if (!codexAck.observed.includes(CODEX_ACK)) {
      throw new Error("Codex acknowledgement marker was not observed");
    }
    for (const tool of ["message.inbox", "message.ack"]) {
      if (
        !codex.toolResults.some(
          (result) =>
            result.server === "agentconduit" &&
            result.tool === tool &&
            result.isError === false,
        )
      ) {
        throw new Error(`Codex ${tool} did not complete successfully`);
      }
    }
    const acknowledgedInbox = await callMcp(client, "message.inbox", {
      agentId: codex.registration.agentId,
      sessionToken: codex.registration.sessionToken,
      includeAcknowledged: true,
    });
    const acknowledged = (
      Array.isArray(acknowledgedInbox.value) ? acknowledgedInbox.value : []
    ).find((message) => message.messageId === pending.messageId);
    state.messageAcknowledged = Boolean(acknowledged?.acknowledgedAt);
    record("message_ack_verified", { acknowledged: state.messageAcknowledged });
    if (!state.messageAcknowledged)
      throw new Error("broker did not record the message acknowledgement");

    const lease = await runLeaseContention(
      client,
      runPaths,
      claudeAgent.workspace.repositoryId,
      eventsPath,
      config.stepTimeoutMs,
    );
    state.leaseWinner = lease.winner;
    state.leaseConflict = lease.conflict;
    if (!state.leaseWinner || !state.leaseConflict) {
      throw new Error(
        "integration lease contention did not produce one winner and one conflict",
      );
    }
    state.success = true;
    record("harness_success", {
      messageAcknowledged: state.messageAcknowledged,
      leaseWinner: state.leaseWinner,
      leaseConflict: state.leaseConflict,
    });
  } catch (error) {
    state.failure = errorShape(error, [
      broker?.token,
      broker?.baseUrl,
      paths.runtimeRoot,
    ]);
    state.failureDiagnostics = {
      claude: claude
        ? {
            mcpServers: claude.mcpServers,
            mcpServerErrors: claude.mcpServerErrors,
            toolCalls: claude.toolCalls,
            agentConduitToolCalls: claude.agentConduitToolCalls,
            toolResults: claude.toolResults,
            registrationObserved: Boolean(claude.registration),
          }
        : null,
      codex: codex
        ? {
            mcpReady: codex.mcpReady,
            mcpStartupStatuses: Object.fromEntries(
              codex.mcpStartupStatuses.entries(),
            ),
            agentConduitToolCalls: codex.agentConduitToolCalls,
            toolResults: codex.toolResults,
            registrationObserved: Boolean(codex.registration),
          }
        : null,
    };
    record("harness_failure", { error: state.failure });
  } finally {
    await claude?.close().catch(() => undefined);
    await codex?.close().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await stopChild(broker?.child, "broker", eventsPath);
    try {
      rmSync(paths.runtimeRoot, { recursive: true, force: true });
      record("runtime_cleanup", { removed: true });
    } catch (error) {
      record("runtime_cleanup_failed", { error: errorShape(error) });
    }
  }
  const summary = {
    generatedAt: timestamp(),
    success: state.success,
    evidenceDir: paths.evidenceRoot,
    files: { events: paths.events, summary: paths.summary },
    observed: {
      broker: state.broker,
      claude: state.claude,
      codex: state.codex,
      sameRepository: state.sameRepository,
      distinctWorktrees: state.distinctWorktrees,
      messageSent: state.messageSent,
      messagePendingBeforeAck: state.messagePendingBeforeAck,
      messageAcknowledged: state.messageAcknowledged,
      leaseWinner: state.leaseWinner,
      leaseConflict: state.leaseConflict,
    },
    limitation:
      "The harness owns both runtime processes. It proves real MCP registration and durable cross-runtime acknowledgement, not control of arbitrary existing Desktop sessions. Native push remains an optional hint; broker acknowledgement is authoritative.",
    failure: state.failure,
    diagnostics: state.failureDiagnostics ?? null,
  };
  writePrivateJson(paths.summary, summary);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.success) process.exitCode = 1;
}

async function main() {
  const config = configFromEnvironment();
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP.trim());
    return;
  }
  if (args.includes("--dry-run")) {
    printDryRun(config);
    return;
  }
  if (args.length > 0)
    throw new Error(`unknown argument ${args[0]}; use --help`);
  await runHarness();
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
