import type { Server } from "node:http";
import { createServer, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENTCONDUIT_NODE_PROTOCOL,
  CoordinationStore,
} from "@agentconduit/core";
import {
  createHubApp,
  type HubAppOptions,
  type HubLogger,
} from "../src/app.js";
import { HubEventNotifier } from "../src/events.js";
import { HubService } from "../src/service.js";
import { enrollDevice, workspace } from "./helpers.js";

const listeners: Server[] = [];
const stores: CoordinationStore[] = [];

afterEach(async () => {
  await Promise.all(
    listeners
      .splice(0)
      .map(
        (listener) =>
          new Promise<void>((resolve) => listener.close(() => resolve())),
      ),
  );
  for (const store of stores.splice(0)) store.close();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startHub(
  logger?: HubLogger,
  appOptions: Partial<
    HubAppOptions & {
      clientIpMode: "loopback-proxy" | "direct-tls";
      attemptBucketCapacity: number;
    }
  > = {},
) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const ownerToken = `aco_${"a".repeat(64)}`;
  const store = new CoordinationStore();
  stores.push(store);
  const service = new HubService(store);
  const notifier = new HubEventNotifier();
  const app = createHubApp({
    service,
    ownerToken,
    allowedOrigin: origin,
    secureCookies: false,
    notifier,
    ...(logger ? { logger } : {}),
    ...appOptions,
  } as HubAppOptions);
  const listener = app.listen(port, "127.0.0.1");
  listeners.push(listener);
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  return { origin, ownerToken, store, service, notifier };
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

async function login(origin: string, ownerToken: string) {
  const response = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token: ownerToken }),
  });
  expect(response.status).toBe(200);
  const body = await json(response);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return { cookie: cookie!, csrf: body.result.csrfToken as string };
}

describe("Hub HTTP boundary", () => {
  it("authenticates the owner, enrolls a device, executes Node RPC, and revokes immediately", async () => {
    const { origin, ownerToken } = await startHub();
    expect((await fetch(`${origin}/livez`)).status).toBe(200);
    expect((await fetch(`${origin}/readyz`)).status).toBe(200);
    expect((await fetch(`${origin}/api/v1/admin/snapshot`)).status).toBe(401);

    const owner = await login(origin, ownerToken);
    const missingCsrf = await fetch(`${origin}/api/v1/admin/enrollments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: owner.cookie,
        origin,
      },
      body: JSON.stringify({ nameHint: "Desk PC" }),
    });
    expect(missingCsrf.status).toBe(403);

    const opened = await fetch(`${origin}/api/v1/admin/enrollments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: owner.cookie,
        origin,
        "x-agentconduit-csrf": owner.csrf,
      },
      body: JSON.stringify({ nameHint: "Desk PC" }),
    });
    expect(opened.status).toBe(200);
    const enrollment = (await json(opened)).result;
    expect(enrollment.enrollmentCode).toMatch(/^ace_[0-9a-f]{48}$/);

    const enrolled = await fetch(`${origin}/api/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollmentCode: enrollment.enrollmentCode,
        name: "Desk PC",
        platform: "linux",
        architecture: "x64",
        nodeVersion: "0.1.0",
        capabilities: ["mcp", "event-stream"],
        health: {
          status: "healthy",
          uptimeSeconds: 100,
          memoryUsedPercent: 25,
          loadAverage1: 0.2,
        },
      }),
    });
    expect(enrolled.status).toBe(201);
    const device = (await json(enrolled)).result;
    expect(device.deviceToken).toMatch(/^acd_[0-9a-f]{64}$/);

    const heartbeat = await fetch(`${origin}/api/v1/node/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${device.deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: AGENTCONDUIT_NODE_PROTOCOL,
        operation: "device.heartbeat",
        params: {
          nodeVersion: "0.1.1",
          capabilities: ["mcp", "event-stream"],
          health: {
            status: "healthy",
            uptimeSeconds: 110,
            memoryUsedPercent: 26,
          },
        },
      }),
    });
    expect(heartbeat.status).toBe(200);
    expect((await json(heartbeat)).result.nodeVersion).toBe("0.1.1");

    const snapshot = await fetch(`${origin}/api/v1/admin/snapshot`, {
      headers: { cookie: owner.cookie },
    });
    expect(snapshot.status).toBe(200);
    expect((await json(snapshot)).result.devices).toHaveLength(1);

    const revoked = await fetch(`${origin}/api/v1/admin/devices/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: owner.cookie,
        origin,
        "x-agentconduit-csrf": owner.csrf,
      },
      body: JSON.stringify({ deviceId: device.deviceId }),
    });
    expect(revoked.status).toBe(200);
    expect((await json(revoked)).result.status).toBe("revoked");

    const afterRevoke = await fetch(`${origin}/api/v1/node/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${device.deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: AGENTCONDUIT_NODE_PROTOCOL,
        operation: "agent.list",
        params: {},
      }),
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("replays durable events over SSE and never logs submitted credentials", async () => {
    const entries: Array<{ event: string; fields?: Record<string, unknown> }> =
      [];
    const logger: HubLogger = {
      info: (event, fields) =>
        entries.push({ event, ...(fields ? { fields } : {}) }),
      warn: (event, fields) =>
        entries.push({ event, ...(fields ? { fields } : {}) }),
      error: (event, fields) =>
        entries.push({ event, ...(fields ? { fields } : {}) }),
    };
    const { origin, ownerToken } = await startHub(logger);
    const owner = await login(origin, ownerToken);
    await fetch(`${origin}/api/v1/admin/enrollments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: owner.cookie,
        origin,
        "x-agentconduit-csrf": owner.csrf,
      },
      body: JSON.stringify({ nameHint: "Event PC" }),
    });

    const controller = new AbortController();
    const stream = await fetch(`${origin}/api/v1/admin/events?cursor=0`, {
      headers: { cookie: owner.cookie },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const chunk = await stream.body!.getReader().read();
    controller.abort();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("event: coordination");
    expect(text).toContain("device.enrollment_created");
    expect(JSON.stringify(entries)).not.toContain(ownerToken);
    expect(JSON.stringify(entries)).not.toContain(owner.csrf);
  });

  it("replays normalized job progress as a push hint without exposing the session token", async () => {
    const { origin, ownerToken, store, service } = await startHub();
    const device = enrollDevice(store, "Job Event PC");
    const observed = workspace(
      device.deviceId,
      "agentconduit.job-sse",
      "4",
      "main",
    );
    const agent = service.execute(device.deviceToken, "agent.register", {
      runtime: "codex",
      sessionRef: "job-sse-agent",
      workspace: observed,
    });
    const job = service.execute(device.deviceToken, "job.create", {
      agentId: agent.agentId,
      sessionToken: agent.sessionToken,
      input: {
        idempotencyKey: "create:job-sse",
        kind: "analysis",
        displayName: "SSE projection",
      },
    });
    service.execute(device.deviceToken, "job.emit", {
      agentId: agent.agentId,
      sessionToken: agent.sessionToken,
      jobId: job.jobId,
      event: {
        idempotencyKey: "event:job-sse",
        type: "checkpoint",
        phase: "verification",
        summary: "Normalized progress is replayable",
      },
    });

    const controller = new AbortController();
    const stream = await fetch(`${origin}/api/v1/admin/events?cursor=0`, {
      headers: { authorization: `Bearer ${ownerToken}` },
      signal: controller.signal,
    });
    const chunk = await stream.body!.getReader().read();
    controller.abort();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("job.event.checkpoint");
    expect(text).toContain("Normalized progress is replayable");
    expect(text).not.toContain(agent.sessionToken);
  });

  it("resets oversized event history instead of replaying it without bounds", async () => {
    const { origin, ownerToken, store } = await startHub();
    for (let index = 0; index < 600; index += 1) {
      store.recordAuditEvent("test.replay", `resource-${index}`, { index });
    }
    const controller = new AbortController();
    const stream = await fetch(`${origin}/api/v1/admin/events?cursor=0`, {
      headers: { authorization: `Bearer ${ownerToken}` },
      signal: controller.signal,
    });
    const first = await stream.body!.getReader().read();
    controller.abort();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: reset");
    expect(text).toContain('"reason":"replay_limit"');
    expect(text).toContain('"latestCursor":600');
    expect(text).not.toContain("event: coordination");
  });

  it("resets replay when event bytes exceed the stream budget", async () => {
    const { origin, ownerToken, store } = await startHub();
    for (let index = 0; index < 10; index += 1) {
      store.recordAuditEvent("test.large_replay", `large-${index}`, {
        payload: "e".repeat(32 * 1_024),
      });
    }
    const controller = new AbortController();
    const stream = await fetch(`${origin}/api/v1/admin/events?cursor=0`, {
      headers: { authorization: `Bearer ${ownerToken}` },
      signal: controller.signal,
    });
    const first = await stream.body!.getReader().read();
    controller.abort();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: reset");
    expect(text).toContain('"reason":"replay_limit"');
    expect(text).toContain('"latestCursor":10');
    expect(text).not.toContain("event: coordination");
  });

  it("waits for SSE drain before writing the next durable event", async () => {
    const { origin, ownerToken, store } = await startHub();
    store.recordAuditEvent("test.first", "first");
    store.recordAuditEvent("test.second", "second");
    let coordinationWrites = 0;
    let blockedResponse: ServerResponse | undefined;
    const originalWrite = ServerResponse.prototype.write;
    const write = vi
      .spyOn(ServerResponse.prototype, "write")
      .mockImplementation(function (
        this: ServerResponse,
        chunk: Uint8Array | string,
        ...args: unknown[]
      ) {
        const result = (
          originalWrite as (...values: unknown[]) => boolean
        ).call(this, chunk, ...args);
        if (String(chunk).includes("event: coordination")) {
          coordinationWrites += 1;
          if (coordinationWrites === 1) {
            blockedResponse = this;
            return false;
          }
        }
        return result;
      } as typeof ServerResponse.prototype.write);
    const controller = new AbortController();
    try {
      const stream = await fetch(`${origin}/api/v1/admin/events?cursor=0`, {
        headers: { authorization: `Bearer ${ownerToken}` },
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(coordinationWrites).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(coordinationWrites).toBe(1);
      blockedResponse!.emit("drain");
      await vi.waitFor(() => expect(coordinationWrites).toBe(2));
      await stream.body!.cancel();
    } finally {
      controller.abort();
      write.mockRestore();
    }
  });

  it("paginates the owner snapshot under one replay watermark and a hard response-byte budget", async () => {
    const { origin, ownerToken, store, service } = await startHub();
    const device = enrollDevice(store, "Snapshot PC");
    const observed = workspace(
      device.deviceId,
      "agentconduit.snapshot-pages",
      "9",
      "main",
    );
    const sender = service.execute(device.deviceToken, "agent.register", {
      runtime: "codex",
      sessionRef: "snapshot-sender",
      workspace: observed,
    });
    const recipient = service.execute(device.deviceToken, "agent.register", {
      runtime: "claude-code",
      sessionRef: "snapshot-recipient",
      workspace: observed,
    });
    for (let index = 0; index < 40; index += 1) {
      const prefix = `snapshot-${String(index).padStart(2, "0")}:`;
      store.sendMessage(
        {
          senderAgentId: sender.agentId,
          recipientAgentId: recipient.agentId,
          body: `${prefix}${"m".repeat(32 * 1_024 - prefix.length)}`,
        },
        sender.sessionToken,
      );
    }
    const owner = await login(origin, ownerToken);
    const messageIds = new Set<string>();
    let cursor: string | undefined;
    let eventWatermark: number | undefined;
    let pages = 0;
    do {
      const url = new URL("/api/v1/admin/snapshot", origin);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, { headers: { cookie: owner.cookie } });
      const serialized = await response.text();
      expect(response.status).toBe(200);
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
        512 * 1_024,
      );
      const result = (JSON.parse(serialized) as Record<string, any>).result;
      for (const message of result.messages) messageIds.add(message.messageId);
      if (eventWatermark === undefined) {
        eventWatermark = result.latestEventCursor;
        expect(result.nextCursor).toEqual(expect.any(String));
        store.revokeDevice(device.deviceId);
        expect(store.latestAuditCursor()).toBeGreaterThan(eventWatermark);
      } else {
        expect(result.latestEventCursor).toBe(eventWatermark);
      }
      cursor = result.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(100);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(messageIds.size).toBe(40);
  });

  it("isolates proxy client rate limits and evicts bounded attempt buckets", async () => {
    const { origin, ownerToken } = await startHub(undefined, {
      clientIpMode: "loopback-proxy",
      attemptBucketCapacity: 2,
    });
    const attempt = async (
      clientIp: string,
      token: string,
      requestOrigin = origin,
    ) =>
      await fetch(`${origin}/api/v1/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: requestOrigin,
          "x-forwarded-for": clientIp,
        },
        body: JSON.stringify({ token }),
      });

    for (let index = 0; index < 8; index += 1) {
      expect((await attempt("203.0.113.10", "wrong-token")).status).toBe(401);
    }
    expect((await attempt("203.0.113.10", "wrong-token")).status).toBe(429);
    expect((await attempt("203.0.113.11", ownerToken)).status).toBe(200);

    expect((await attempt("203.0.113.12", "wrong-token")).status).toBe(401);
    expect((await attempt("203.0.113.13", "wrong-token")).status).toBe(401);
    expect((await attempt("203.0.113.10", ownerToken)).status).toBe(200);

    for (let index = 0; index < 8; index += 1) {
      expect(
        (await attempt("203.0.113.20", "wrong-token", "https://evil.test"))
          .status,
      ).toBe(403);
    }
    expect((await attempt("203.0.113.20", ownerToken)).status).toBe(200);
  });

  it("isolates device enrollment attempts behind the trusted loopback proxy", async () => {
    const { origin, service } = await startHub(undefined, {
      clientIpMode: "loopback-proxy",
    });
    const enrollment = service.createEnrollment("Valid enrollment");
    const request = async (clientIp: string | undefined, code: string) =>
      await fetch(`${origin}/api/v1/enroll`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(clientIp ? { "x-forwarded-for": clientIp } : {}),
        },
        body: JSON.stringify({
          enrollmentCode: code,
          name: "Travel PC",
          platform: "linux",
          architecture: "x64",
          nodeVersion: "0.1.0",
          capabilities: ["mcp"],
          health: {
            status: "healthy",
            uptimeSeconds: 1,
            memoryUsedPercent: 10,
          },
        }),
      });

    expect((await request(undefined, enrollment.enrollmentCode)).status).toBe(
      400,
    );
    for (let index = 0; index < 20; index += 1) {
      expect(
        (await request("203.0.113.30", `ace_${"f".repeat(48)}`)).status,
      ).toBe(403);
    }
    expect(
      (await request("203.0.113.30", `ace_${"f".repeat(48)}`)).status,
    ).toBe(429);
    expect(
      (await request("203.0.113.31", enrollment.enrollmentCode)).status,
    ).toBe(201);
  });

  it("ignores forwarding headers when Hub TLS terminates directly", async () => {
    const { origin, ownerToken } = await startHub(undefined, {
      clientIpMode: "direct-tls",
    });
    const attempt = async (index: number, token: string) =>
      await fetch(`${origin}/api/v1/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": `203.0.113.${index + 40}`,
        },
        body: JSON.stringify({ token }),
      });
    for (let index = 0; index < 8; index += 1) {
      expect((await attempt(index, "wrong-token")).status).toBe(401);
    }
    expect((await attempt(9, ownerToken)).status).toBe(429);
  });

  it("accepts explicit owner bearer automation without bypassing route bounds", async () => {
    const { origin, ownerToken } = await startHub();
    const response = await fetch(`${origin}/api/v1/admin/enrollments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ nameHint: "Automation PC" }),
    });
    expect(response.status).toBe(200);
    expect((await json(response)).result.enrollmentCode).toMatch(
      /^ace_[0-9a-f]{48}$/,
    );

    const unknown = await fetch(`${origin}/api/v1/admin/shell`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "git status" }),
    });
    expect(unknown.status).toBe(404);
  });

  it("does not expose internal failure messages or details over public HTTP", async () => {
    const entries: Array<{ event: string; fields?: Record<string, unknown> }> =
      [];
    const logger: HubLogger = {
      info: (event, fields) =>
        entries.push({ event, ...(fields ? { fields } : {}) }),
      warn: (event, fields) =>
        entries.push({ event, ...(fields ? { fields } : {}) }),
      error: (event, fields) =>
        entries.push({ event, ...(fields ? { fields } : {}) }),
    };
    const { origin, ownerToken, service } = await startHub(logger);
    const owner = await login(origin, ownerToken);
    service.snapshot = () => {
      throw new Error(
        "SQLite failed at /private/hub/state.db with secret material",
      );
    };

    const response = await fetch(`${origin}/api/v1/admin/snapshot`, {
      headers: { cookie: owner.cookie },
    });
    expect(response.status).toBe(503);
    const serialized = JSON.stringify({ body: await json(response), entries });
    expect(serialized).toContain("Hub operation failed");
    expect(serialized).not.toContain("/private/hub/state.db");
    expect(serialized).not.toContain("secret material");
  });
});
