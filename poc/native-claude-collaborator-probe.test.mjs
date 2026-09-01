import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TEST_PATH = fileURLToPath(import.meta.url);
const SCRIPT_PATH = join(
  dirname(TEST_PATH),
  "native-claude-collaborator-probe.mjs",
);
const RUNTIME_FLAG = "AGENTCONDUIT_NATIVE_CLAUDE_RUNTIME_INTERNAL";
let probeModulePromise;

function loadProbeModule() {
  probeModulePromise ??= import(
    `${new URL("./native-claude-collaborator-probe.mjs", import.meta.url)}?tests`
  );
  return probeModulePromise;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stringEnvironment(overrides = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([, value]) => typeof value === "string",
      ),
    ),
    ...overrides,
  };
}

async function loadMcpClientDependencies() {
  try {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]);
    return { Client, StdioClientTransport };
  } catch {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import(
        new URL(
          "../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
          import.meta.url,
        )
      ),
      import(
        new URL(
          "../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js",
          import.meta.url,
        )
      ),
    ]);
    return { Client, StdioClientTransport };
  }
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentconduit-native-claude-test-"));
  const cwd = join(root, "worktree");
  const fakeClaude = join(root, "fake-claude.mjs");
  const runtimeLog = join(root, "runtime-events.jsonl");
  const runtimeState = join(root, "runtime-state.json");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  JSON.parse(input.trim());
  const emitProviderOutput = () => {
    process.stdout.write(JSON.stringify({
      type: "system",
      subtype: "init",
      claude_code_version: "fake-1.0.0",
      model: "fake-claude",
      tools: process.env.FAKE_CLAUDE_ADVERTISE_TOOLS === "1" ? ["Read"] : [],
      mcp_servers: process.env.FAKE_CLAUDE_ADVERTISE_MCP === "1" ? [{ name: "unexpected" }] : []
    }) + "\\n");
    if (process.env.FAKE_CLAUDE_ASSISTANT_CONTENT !== undefined) {
      process.stdout.write(JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: process.env.FAKE_CLAUDE_ASSISTANT_CONTENT }]
        }
      }) + "\\n");
    }
    if (process.env.FAKE_CLAUDE_NEVER === "1") {
      setInterval(() => {}, 1000);
      return;
    }
    const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS || "0");
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: "result",
        subtype: "success",
        result: process.env.FAKE_CLAUDE_RESULT || ""
      }) + "\\n");
    }, delayMs);
  };
  setTimeout(
    emitProviderOutput,
    Number(process.env.FAKE_CLAUDE_INIT_DELAY_MS || "0")
  );
});
process.on("SIGTERM", () => process.exit(0));
`,
    { encoding: "utf8", mode: 0o700 },
  );
  chmodSync(fakeClaude, 0o700);
  writeFileSync(join(root, ".keep"), "fixture\n", { mode: 0o600 });
  return { root, cwd, fakeClaude, runtimeLog, runtimeState };
}

async function createRuntimeClient(fixture, marker, overrides = {}) {
  const { Client, StdioClientTransport } = await loadMcpClientDependencies();
  const environment = stringEnvironment({
    [RUNTIME_FLAG]: "1",
    AGENTCONDUIT_NATIVE_CLAUDE_RUNTIME_LOG: fixture.runtimeLog,
    AGENTCONDUIT_NATIVE_CLAUDE_RUNTIME_STATE: fixture.runtimeState,
    AGENTCONDUIT_NATIVE_CLAUDE_EXPECTED_CWD_HASH: sha256(fixture.cwd),
    AGENTCONDUIT_NATIVE_CLAUDE_EXPECTED_RESULT_HASH: sha256(marker),
    AGENTCONDUIT_CLAUDE_COMMAND: fixture.fakeClaude,
    AGENTCONDUIT_NATIVE_CLAUDE_MODEL: "fake-claude",
    AGENTCONDUIT_NATIVE_CLAUDE_BUDGET_USD: "0.01",
    AGENTCONDUIT_NATIVE_CLAUDE_JOB_TIMEOUT_MS: "5000",
    AGENTCONDUIT_NATIVE_CLAUDE_WAIT_MAXIMUM_MS: "2000",
    AGENTCONDUIT_NATIVE_CLAUDE_SHUTDOWN_MS: "500",
    ...overrides,
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SCRIPT_PATH, "--runtime-server"],
    cwd: fixture.cwd,
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({
    name: "agentconduit-native-claude-test",
    version: "0.1.0",
  });
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, undefined);
  const result = response.structuredContent?.result;
  assert.ok(result && typeof result === "object");
  return result;
}

test("overall timeout clears its losing deadline after successful work", async () => {
  const { withTimeout } = await loadProbeModule();
  const timer = { id: "deadline" };
  let cleared = null;
  const clock = {
    setTimeout() {
      return timer;
    },
    clearTimeout(value) {
      cleared = value;
    },
  };
  assert.equal(
    await withTimeout(Promise.resolve("finished"), 300_000, "timed out", clock),
    "finished",
  );
  assert.equal(cleared, timer);
});

function validHarnessInput() {
  const marker = "BOUND_NATIVE_MARKER";
  return {
    marker,
    codex: {
      threadId: "parent-thread",
      completedSpawnCalls: new Map([
        [
          "spawn-call",
          {
            eventThreadId: "parent-thread",
            senderThreadId: "parent-thread",
            receiverThreadIds: ["claude-thread"],
            status: "completed",
          },
        ],
      ]),
      spawnedAgentThreadId: "claude-thread",
      spawnedAgentRole: "claude_collaborator",
      spawnedAgentCwdMatched: true,
      completedRuntimeToolCalls: new Map([
        [
          "start-call",
          {
            eventThreadId: "claude-thread",
            tool: "claude_start",
            status: "completed",
          },
        ],
        [
          "wait-call",
          {
            eventThreadId: "claude-thread",
            tool: "claude_wait",
            status: "completed",
          },
        ],
        [
          "events-call",
          {
            eventThreadId: "claude-thread",
            tool: "claude_events",
            status: "completed",
          },
        ],
      ]),
      runtimeToolCallsByThread: new Map([
        [
          "claude-thread",
          new Set(["claude_start", "claude_wait", "claude_events"]),
        ],
      ]),
    },
    runtime: {
      runtimeStarted: true,
      runtimeCwdMatched: true,
      claudeStarted: true,
      claudeCwdMatched: true,
      terminalStatus: "completed",
      directChildClosed: true,
      markerMatched: true,
      toolUseCount: 0,
      initObserved: true,
      advertisedToolCount: 0,
      mcpServerCount: 0,
      runtimeToolCalls: ["claude_start", "claude_events", "claude_wait"],
    },
    beforeGit: { head: "same-head", status: "" },
    afterGit: { head: "same-head", status: "" },
    turn: { status: "completed", text: marker },
  };
}

test("native success criteria bind role, receiver thread, MCP calls, turn, and exact result", async () => {
  const { harnessFailures } = await loadProbeModule();
  assert.deepEqual(harnessFailures(validHarnessInput()), []);

  const genericAgent = validHarnessInput();
  genericAgent.codex.spawnedAgentRole = "default";
  assert.match(
    harnessFailures(genericAgent).join("; "),
    /claude_collaborator role/,
  );

  const unboundMcp = validHarnessInput();
  unboundMcp.codex.runtimeToolCallsByThread = new Map([
    ["other-thread", new Set(["claude_start", "claude_wait"])],
  ]);
  assert.match(
    harnessFailures(unboundMcp).join("; "),
    /spawned receiver thread/,
  );

  const failedMcp = validHarnessInput();
  failedMcp.codex.completedRuntimeToolCalls.get("wait-call").status = "failed";
  assert.match(harnessFailures(failedMcp).join("; "), /completed MCP calls/);

  const missingEventRead = validHarnessInput();
  missingEventRead.codex.completedRuntimeToolCalls.delete("events-call");
  missingEventRead.codex.runtimeToolCallsByThread
    .get("claude-thread")
    .delete("claude_events");
  missingEventRead.runtime.runtimeToolCalls = ["claude_start", "claude_wait"];
  assert.match(
    harnessFailures(missingEventRead).join("; "),
    /event reads|claude_events/,
  );

  const cancelledAfterSuccess = validHarnessInput();
  cancelledAfterSuccess.codex.completedRuntimeToolCalls.set("cancel-call", {
    eventThreadId: "claude-thread",
    tool: "claude_cancel",
    status: "completed",
  });
  cancelledAfterSuccess.codex.runtimeToolCallsByThread
    .get("claude-thread")
    .add("claude_cancel");
  cancelledAfterSuccess.runtime.runtimeToolCalls.push("claude_cancel");
  assert.match(
    harnessFailures(cancelledAfterSuccess).join("; "),
    /claude_cancel/,
  );

  const failedTurn = validHarnessInput();
  failedTurn.turn.status = "failed";
  assert.match(
    harnessFailures(failedTurn).join("; "),
    /parent turn did not complete/,
  );

  const containingText = validHarnessInput();
  containingText.turn.text = `Result: ${containingText.marker}`;
  assert.match(
    harnessFailures(containingText).join("; "),
    /exact Claude marker/,
  );
});

test("completed turn result selects the final parent answer, not commentary", async () => {
  const { completedTurnResult } = await loadProbeModule();
  assert.deepEqual(
    completedTurnResult({
      status: "completed",
      items: [
        {
          type: "agentMessage",
          text: "I will ask the collaborator for BOUND_NATIVE_MARKER.",
          phase: "commentary",
        },
        {
          type: "agentMessage",
          text: "BOUND_NATIVE_MARKER",
          phase: "final_answer",
        },
      ],
    }),
    {
      status: "completed",
      text: "BOUND_NATIVE_MARKER",
      agentMessageCount: 2,
      selectedPhase: "final_answer",
    },
  );
});

test("cleanup discovers an early runtime PID and fails closed if it lingers", async (t) => {
  const { cleanupOwnedProcesses } = await loadProbeModule();
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  writeFileSync(
    fixture.runtimeState,
    `${JSON.stringify({ runtimePid: 4242 })}\n`,
    { mode: 0o600 },
  );
  let stopped = false;
  const cleaned = await cleanupOwnedProcesses({
    codex: { close: async () => true },
    runtimePid: null,
    runtimeStatePath: fixture.runtimeState,
    operations: {
      isProcessAlive: () => !stopped,
      stopOwnedRuntimePid: async (pid) => {
        assert.equal(pid, 4242);
        stopped = true;
        return true;
      },
    },
  });
  assert.equal(cleaned.success, true);
  assert.equal(cleaned.runtimePid, 4242);

  const lingering = await cleanupOwnedProcesses({
    codex: { close: async () => false },
    runtimePid: null,
    runtimeStatePath: fixture.runtimeState,
    operations: {
      isProcessAlive: () => true,
      stopOwnedRuntimePid: async () => false,
    },
  });
  assert.equal(lingering.success, false);
  assert.ok(lingering.failures.includes("codex_app_server_not_closed"));
  assert.ok(lingering.failures.includes("runtime_server_not_closed"));
});

test("cleanup independently closes a recorded Claude child on early failure", async (t) => {
  const { cleanupOwnedProcesses } = await loadProbeModule();
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const identity = {
    startTimeTicks: "12345",
    commandLineHash: "a".repeat(64),
  };
  writeFileSync(
    fixture.runtimeState,
    `${JSON.stringify({
      runtimePid: 4242,
      activeClaudePid: 4343,
      lastClaudePid: 4343,
      lastClaudeClosed: false,
      activeClaudeIdentity: identity,
      lastClaudeIdentity: identity,
    })}\n`,
    { mode: 0o600 },
  );

  const alive = new Set([4242, 4343]);
  const cleaned = await cleanupOwnedProcesses({
    codex: { close: async () => true },
    runtimePid: null,
    runtimeStatePath: fixture.runtimeState,
    operations: {
      isProcessAlive: (pid) => alive.has(pid),
      stopOwnedRuntimePid: async (pid) => {
        assert.equal(pid, 4242);
        alive.delete(pid);
        return true;
      },
      processMatchesIdentity: (pid, value) => {
        assert.equal(pid, 4343);
        assert.deepEqual(value, identity);
        return true;
      },
      stopOwnedClaudePid: async (pid, value) => {
        assert.equal(pid, 4343);
        assert.deepEqual(value, identity);
        alive.delete(pid);
        return true;
      },
    },
  });
  assert.equal(cleaned.success, true);
  assert.equal(cleaned.directClaudeClosed, true);

  const lingering = await cleanupOwnedProcesses({
    codex: { close: async () => true },
    runtimePid: null,
    runtimeStatePath: fixture.runtimeState,
    operations: {
      isProcessAlive: (pid) => pid === 4343,
      stopOwnedRuntimePid: async () => true,
      processMatchesIdentity: () => true,
      stopOwnedClaudePid: async () => false,
    },
  });
  assert.equal(lingering.success, false);
  assert.equal(lingering.directClaudeClosed, false);
  assert.ok(lingering.failures.includes("direct_claude_child_not_closed"));
});

test("child termination reports failure when signalling throws", async (t) => {
  const { stopChild } = await loadProbeModule();
  const fixture = createFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const child = {
    exitCode: null,
    signalCode: null,
    kill() {
      throw new Error("signal rejected");
    },
  };
  assert.equal(await stopChild(child, "fake-child", fixture.runtimeLog), false);
});

test("live mode rejects platforms without exact process identity checks", async () => {
  const { requireSupportedLivePlatform } = await loadProbeModule();
  assert.throws(() => requireSupportedLivePlatform("win32"), /Linux or WSL/);
  assert.doesNotThrow(() => requireSupportedLivePlatform("linux"));
});

test("dry-run describes the native async boundary without starting providers", () => {
  const environment = stringEnvironment();
  delete environment.AGENTCONDUIT_RUN_NATIVE_CLAUDE_COLLABORATOR_POC;
  const output = execFileSync(process.execPath, [SCRIPT_PATH, "--dry-run"], {
    cwd: resolve(dirname(TEST_PATH), ".."),
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });
  const value = JSON.parse(output);
  assert.equal(value.live, false);
  assert.equal(value.nativeCodexSubagent, true);
  assert.deepEqual(value.runtimeTools, [
    "claude_start",
    "claude_wait",
    "claude_events",
    "claude_cancel",
  ]);
  assert.ok(value.asyncLifecycle.includes("cursor-progress-replay"));
  assert.equal(value.personalConfigurationChanged, false);
  assert.equal(value.providerCallsStarted, false);
});

test("runtime starts promptly, waits in bounded intervals, and returns fake Claude", async (t) => {
  const fixture = createFixture();
  const marker = "FAKE_CLAUDE_COLLABORATOR_OK";
  const promptSecret = "PROMPT_MUST_NOT_ENTER_PROGRESS";
  const assistantSecret = "ASSISTANT_STREAM_MUST_NOT_ENTER_PROGRESS";
  const { client } = await createRuntimeClient(fixture, marker, {
    FAKE_CLAUDE_DELAY_MS: "350",
    FAKE_CLAUDE_RESULT: marker,
    FAKE_CLAUDE_ASSISTANT_CONTENT: assistantSecret,
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const startedAt = Date.now();
  const started = await callTool(client, "claude_start", {
    prompt: `${promptSecret}; return exactly ${marker}`,
  });
  const startElapsedMs = Date.now() - startedAt;
  assert.equal(started.status, "running");
  assert.match(started.jobId, /^clj_[0-9a-f]{32}$/);
  assert.ok(startElapsedMs < 1_000, `start took ${startElapsedMs}ms`);
  assert.ok(started.startLatencyMs < 1_000);
  assert.ok(started.lastEventCursor >= 2);
  assert.ok(started.lastEventSequence >= 2);

  const firstWaitAt = Date.now();
  const pending = await callTool(client, "claude_wait", {
    jobId: started.jobId,
    waitMs: 25,
  });
  assert.equal(pending.status, "running");
  assert.ok(Date.now() - firstWaitAt < 500);

  const completed = await callTool(client, "claude_wait", {
    jobId: started.jobId,
    waitMs: 2_000,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.result, marker);
  assert.equal(completed.markerMatched, true);
  assert.equal(completed.directChildClosed, true);
  assert.equal(completed.toolUseCount, 0);
  assert.equal(completed.initObserved, true);
  assert.equal(completed.advertisedToolCount, 0);
  assert.equal(completed.mcpServerCount, 0);
  assert.equal(completed.claudeCodeVersion, "fake-1.0.0");

  const progress = [];
  let cursor = 0;
  for (;;) {
    const page = await callTool(client, "claude_events", {
      jobId: started.jobId,
      afterCursor: cursor,
      limit: 2,
    });
    assert.ok(page.events.length <= 2);
    if (page.events.length > 0) {
      assert.ok(page.nextCursor > cursor);
      progress.push(...page.events);
    }
    cursor = page.nextCursor;
    if (!page.hasMore) {
      assert.equal(page.latestCursor, cursor);
      assert.equal(page.latestSequence, progress.length);
      break;
    }
  }
  assert.deepEqual(
    progress.map((event) => event.type),
    [
      "created",
      "started",
      "provider_ready",
      "working",
      "checkpoint",
      "completed",
    ],
  );
  assert.deepEqual(
    progress.map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    progress.map((event) => event.status),
    ["queued", "running", "running", "running", "running", "succeeded"],
  );
  assert.ok(
    progress.every(
      (event, index) =>
        index === 0 || event.cursor > progress[index - 1].cursor,
    ),
  );
  assert.equal(completed.lastEventCursor, progress.at(-1).cursor);
  assert.equal(completed.lastEventSequence, progress.at(-1).sequence);
  const retainedProgress = JSON.stringify(progress);
  for (const secret of [promptSecret, assistantSecret, marker]) {
    assert.equal(retainedProgress.includes(secret), false);
  }
  assert.ok(
    progress.every(
      (event) =>
        !event.summary?.includes("\n") &&
        Buffer.byteLength(event.summary ?? "") <= 160,
    ),
  );

  const second = await callTool(client, "claude_start", {
    prompt: "Run a second bounded fake job.",
  });
  const secondCompleted = await callTool(client, "claude_wait", {
    jobId: second.jobId,
    waitMs: 2_000,
  });
  assert.equal(secondCompleted.status, "completed");
  const secondProgress = await callTool(client, "claude_events", {
    jobId: second.jobId,
    afterCursor: 0,
    limit: 100,
  });
  assert.equal(secondProgress.events[0].sequence, 1);
  assert.ok(secondProgress.events[0].cursor > progress.at(-1).cursor);
  assert.equal(
    secondProgress.events.at(-1).sequence,
    secondCompleted.lastEventSequence,
  );

  const evidence = readFileSync(fixture.runtimeLog, "utf8");
  assert.equal(evidence.includes(marker), false);
  assert.match(evidence, /"cwdMatchesExpected":true/);
  assert.match(evidence, /"markerMatched":true/);
  assert.match(evidence, /"processIdentityCaptured":true/);
  const state = JSON.parse(readFileSync(fixture.runtimeState, "utf8"));
  assert.equal(state.activeClaudePid, null);
  assert.equal(state.lastClaudeClosed, true);
  assert.match(state.lastClaudeIdentity.startTimeTicks, /^\d+$/);
  assert.match(state.lastClaudeIdentity.commandLineHash, /^[0-9a-f]{64}$/);
});

test("runtime preserves provider result boundary whitespace byte-for-byte", async (t) => {
  const fixture = createFixture();
  const marker = "\n  EXACT_PROVIDER_RESULT  \t\n";
  const { client } = await createRuntimeClient(fixture, marker, {
    FAKE_CLAUDE_RESULT: marker,
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const started = await callTool(client, "claude_start", {
    prompt:
      "Return the exact bounded marker, including its boundary whitespace.",
  });
  const completed = await callTool(client, "claude_wait", {
    jobId: started.jobId,
    waitMs: 2_000,
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.result, marker);
  assert.equal(completed.resultBytes, Buffer.byteLength(marker));
  assert.equal(completed.resultHash, sha256(marker));
  assert.equal(completed.markerMatched, true);
});

test("runtime applies the result limit before normalizing boundary whitespace", async (t) => {
  const fixture = createFixture();
  const oversized = " ".repeat(32 * 1_024 + 1);
  const { client } = await createRuntimeClient(fixture, oversized, {
    FAKE_CLAUDE_RESULT: oversized,
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const started = await callTool(client, "claude_start", {
    prompt: "Return the configured oversized fake result.",
  });
  const completed = await callTool(client, "claude_wait", {
    jobId: started.jobId,
    waitMs: 2_000,
  });

  assert.equal(completed.status, "failed");
  assert.equal(completed.errorCode, "result_too_large");
  assert.equal(completed.result, undefined);
  assert.equal(completed.resultBytes, null);
  assert.equal(completed.resultHash, null);
});

test("runtime cancellation is terminal, idempotent, and closes the fake child", async (t) => {
  const fixture = createFixture();
  const marker = "UNUSED_CANCEL_MARKER";
  const { client } = await createRuntimeClient(fixture, marker, {
    FAKE_CLAUDE_NEVER: "1",
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const started = await callTool(client, "claude_start", {
    prompt: `Eventually return ${marker}`,
  });
  assert.equal(started.status, "running");
  const cancelled = await callTool(client, "claude_cancel", {
    jobId: started.jobId,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.directChildClosed, true);
  assert.equal(cancelled.result, undefined);

  const cancelledAgain = await callTool(client, "claude_cancel", {
    jobId: started.jobId,
  });
  assert.equal(cancelledAgain.status, "cancelled");
  assert.equal(cancelledAgain.directChildClosed, true);
  const cancellationEvents = await callTool(client, "claude_events", {
    jobId: started.jobId,
    afterCursor: 0,
    limit: 100,
  });
  assert.equal(cancellationEvents.events.at(-1).type, "cancelled");
  assert.equal(cancellationEvents.events.at(-1).status, "cancelled");
  const state = JSON.parse(readFileSync(fixture.runtimeState, "utf8"));
  assert.equal(state.activeClaudePid, null);
  assert.equal(state.lastClaudeClosed, true);
  assert.match(state.lastClaudeIdentity.startTimeTicks, /^\d+$/);
  assert.match(state.lastClaudeIdentity.commandLineHash, /^[0-9a-f]{64}$/);
});

test("runtime rejects advertised Claude tools or MCP servers even without tool use", async (t) => {
  const fixture = createFixture();
  const marker = "CAPABILITY_DRIFT_MARKER";
  const { client } = await createRuntimeClient(fixture, marker, {
    FAKE_CLAUDE_RESULT: marker,
    FAKE_CLAUDE_ADVERTISE_TOOLS: "1",
    FAKE_CLAUDE_ADVERTISE_MCP: "1",
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  });
  const started = await callTool(client, "claude_start", {
    prompt: `Return exactly ${marker}`,
  });
  const completed = await callTool(client, "claude_wait", {
    jobId: started.jobId,
    waitMs: 2_000,
  });
  assert.equal(completed.status, "failed");
  assert.equal(completed.errorCode, "unexpected_runtime_capabilities");
  assert.equal(completed.directChildClosed, true);
  assert.equal(completed.initObserved, true);
  assert.equal(completed.advertisedToolCount, 1);
  assert.equal(completed.mcpServerCount, 1);
  const failureEvents = await callTool(client, "claude_events", {
    jobId: started.jobId,
    afterCursor: 0,
    limit: 100,
  });
  assert.equal(failureEvents.events.at(-1).type, "failed");
  assert.equal(failureEvents.events.at(-1).status, "failed");
});

test("bounded waits do not fabricate progress when no provider event arrives", async (t) => {
  const fixture = createFixture();
  const marker = "NO_FABRICATED_PROGRESS_MARKER";
  const { client } = await createRuntimeClient(fixture, marker, {
    FAKE_CLAUDE_INIT_DELAY_MS: "500",
    FAKE_CLAUDE_NEVER: "1",
  });
  t.after(async () => {
    await client.close().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const started = await callTool(client, "claude_start", {
    prompt: `Eventually return ${marker}`,
  });
  const initial = await callTool(client, "claude_events", {
    jobId: started.jobId,
    afterCursor: 0,
    limit: 100,
  });
  assert.deepEqual(
    initial.events.map((event) => event.type),
    ["created", "started"],
  );
  const pending = await callTool(client, "claude_wait", {
    jobId: started.jobId,
    waitMs: 25,
  });
  assert.equal(pending.status, "running");
  assert.equal(pending.lastEventCursor, initial.latestCursor);
  const unchanged = await callTool(client, "claude_events", {
    jobId: started.jobId,
    afterCursor: initial.nextCursor,
    limit: 100,
  });
  assert.deepEqual(unchanged.events, []);
  assert.equal(unchanged.nextCursor, initial.nextCursor);
  assert.equal(unchanged.latestCursor, initial.latestCursor);

  const cancelled = await callTool(client, "claude_cancel", {
    jobId: started.jobId,
  });
  assert.equal(cancelled.status, "cancelled");
});
