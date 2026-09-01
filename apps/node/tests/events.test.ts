import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinationError, type AuditEventRecord } from "@agentconduit/core";
import type { HubClient } from "../src/client.js";
import {
  FileEventCursorStore,
  MemoryEventCursorStore,
  NodeEventSupervisor,
} from "../src/events.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function event(cursor: number): AuditEventRecord {
  return {
    cursor,
    eventId: `evt_${cursor}`,
    eventType: "message.sent",
    resourceId: `msg_${cursor}`,
    metadata: { recipientAgentId: `agt_${"a".repeat(32)}` },
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function sse(...blocks: string[]): Response {
  return new Response(`${blocks.join("\n\n")}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function coordination(value: AuditEventRecord): string {
  return [
    `id: ${value.cursor}`,
    "event: coordination",
    `data: ${JSON.stringify({ protocol: "agentconduit.node.v1", event: value })}`,
  ].join("\n");
}

describe("FileEventCursorStore", () => {
  it("persists a private monotonic replay position atomically", () => {
    const root = mkdtempSync("/tmp/agentconduit-node-cursor-");
    directories.push(root);
    chmodSync(root, 0o700);
    const path = join(root, "cursor");
    const store = new FileEventCursorStore(path);
    expect(store.load()).toBe(0);
    store.save(42);
    expect(readFileSync(path, "utf8")).toBe("42\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(store.load()).toBe(42);
  });

  it("rejects an exposed or malformed cursor", () => {
    const root = mkdtempSync("/tmp/agentconduit-node-cursor-");
    directories.push(root);
    chmodSync(root, 0o700);
    const path = join(root, "cursor");
    writeFileSync(path, "not-a-cursor\n", { mode: 0o600 });
    expect(() => new FileEventCursorStore(path).load()).toThrow(
      "Event cursor is invalid",
    );
    chmodSync(path, 0o644);
    expect(() => new FileEventCursorStore(path).load()).toThrow(
      "permissions must be private",
    );
  });
});

describe("NodeEventSupervisor", () => {
  it("replays durable events once and saves the cursor after handling", async () => {
    const cursorStore = new MemoryEventCursorStore();
    const received: number[] = [];
    let calls = 0;
    const client = {
      async openEventStream(_cursor: number, signal: AbortSignal) {
        calls += 1;
        if (calls === 1)
          return sse(coordination(event(1)), coordination(event(2)));
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    } as HubClient;
    const supervisor = new NodeEventSupervisor({
      client,
      cursorStore,
      minBackoffMs: 1,
      maxBackoffMs: 1,
      onEvent: (value) => received.push(value.cursor),
    });
    supervisor.start();
    await vi.waitFor(() => expect(cursorStore.load()).toBe(2));
    await supervisor.stop();
    expect(received).toEqual([1, 2]);
  });

  it("honors a replay reset and stops permanently after credential revocation", async () => {
    const cursorStore = new MemoryEventCursorStore(1);
    const warnings: string[] = [];
    let calls = 0;
    const client = {
      async openEventStream() {
        calls += 1;
        if (calls === 1) {
          return sse(
            `event: reset\ndata: ${JSON.stringify({ latestCursor: 5 })}`,
            coordination(event(6)),
          );
        }
        throw new CoordinationError("forbidden", "revoked");
      },
    } as HubClient;
    const supervisor = new NodeEventSupervisor({
      client,
      cursorStore,
      minBackoffMs: 1,
      maxBackoffMs: 1,
      onWarning: (warning) => warnings.push(warning),
    });
    supervisor.start();
    await vi.waitFor(() => expect(warnings).toHaveLength(1));
    await supervisor.stop();
    expect(cursorStore.load()).toBe(6);
    expect(warnings[0]).toContain("credential");
    expect(calls).toBe(2);
  });
});
