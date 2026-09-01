import { describe, expect, it, vi } from "vitest";
import type { DeviceCredential } from "@agentconduit/core";
import { HubClient, enrollWithHub } from "../src/client.js";

const deviceToken = `acd_${"a".repeat(64)}`;

function credential(): DeviceCredential {
  return {
    deviceId: `dev_${"b".repeat(32)}`,
    deviceToken,
    name: "PC One",
    platform: "linux",
    architecture: "x64",
    nodeVersion: "0.1.0",
    capabilities: ["mcp"],
    health: {
      status: "healthy",
      uptimeSeconds: 10,
      memoryUsedPercent: 20,
    },
    status: "online",
    enrolledAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("HubClient", () => {
  it("requires HTTPS except for an explicit loopback development boundary", () => {
    expect(
      () => new HubClient({ baseUrl: "http://example.com", deviceToken }),
    ).toThrow("Hub URL must use HTTPS");
    expect(
      () =>
        new HubClient({
          baseUrl: "http://127.0.0.1:8787",
          deviceToken,
          allowInsecureLoopback: true,
        }),
    ).not.toThrow();
  });

  it("sends a versioned authenticated RPC and records successful contact", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        protocol: "agentconduit.node.v1",
        operation: "workspace.list",
      });
      return Response.json({ result: { items: [] } });
    });
    const client = new HubClient({
      baseUrl: "https://hub.example.test",
      deviceToken,
      fetch: fetcher,
    });
    await expect(client.rpc("workspace.list", {})).resolves.toEqual({
      items: [],
    });
    expect(client.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(client.lastFailureAt).toBeUndefined();
  });

  it("fails closed on outage, revocation, invalid JSON, and oversized responses", async () => {
    const outage = new HubClient({
      baseUrl: "https://hub.example.test",
      deviceToken,
      fetch: async () => {
        throw new Error("secret network detail");
      },
    });
    await expect(outage.rpc("workspace.list", {})).rejects.toMatchObject({
      code: "storage_error",
      details: { reason: "hub_unavailable", coordinated: false },
    });

    const revoked = new HubClient({
      baseUrl: "https://hub.example.test",
      deviceToken,
      fetch: async () =>
        Response.json({ error: "unauthorized" }, { status: 401 }),
    });
    await expect(revoked.rpc("workspace.list", {})).rejects.toMatchObject({
      code: "forbidden",
    });

    const invalid = new HubClient({
      baseUrl: "https://hub.example.test",
      deviceToken,
      fetch: async () => new Response("not-json"),
    });
    await expect(invalid.rpc("workspace.list", {})).rejects.toMatchObject({
      code: "storage_error",
      message: "Hub response is not valid JSON",
    });

    const oversized = new HubClient({
      baseUrl: "https://hub.example.test",
      deviceToken,
      fetch: async () =>
        new Response("{}", {
          headers: { "content-length": String(1024 * 1024 + 1) },
        }),
    });
    await expect(oversized.rpc("workspace.list", {})).rejects.toMatchObject({
      code: "storage_error",
      message: "Hub response is too large",
    });
  });

  it("enrolls once without putting the code in the URL", async () => {
    const issued = credential();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://hub.example.test/api/v1/enroll");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        enrollmentCode: `ace_${"c".repeat(48)}`,
        name: "PC One",
      });
      return Response.json({ result: issued }, { status: 201 });
    });
    await expect(
      enrollWithHub(
        "https://hub.example.test",
        {
          enrollmentCode: `ace_${"c".repeat(48)}`,
          name: "PC One",
          platform: "linux",
          architecture: "x64",
          nodeVersion: "0.1.0",
          capabilities: ["mcp"],
          health: {
            status: "healthy",
            uptimeSeconds: 1,
            memoryUsedPercent: 1,
          },
        },
        { fetch: fetcher },
      ),
    ).resolves.toEqual(issued);
  });
});
