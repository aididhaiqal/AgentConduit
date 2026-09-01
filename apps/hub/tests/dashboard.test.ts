import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinationStore } from "@agentconduit/core";
import { createHubApp } from "../src/app.js";
import { HubService } from "../src/service.js";
import { enrollDevice, workspace } from "./helpers.js";

const publicDirectory = fileURLToPath(new URL("../public", import.meta.url));
const html = readFileSync(`${publicDirectory}/index.html`, "utf8");
const css = readFileSync(`${publicDirectory}/styles.css`, "utf8");
const javascript = readFileSync(`${publicDirectory}/app.js`, "utf8");
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
  vi.useRealTimers();
});

async function startDashboard(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const store = new CoordinationStore();
  stores.push(store);
  const service = new HubService(store);
  const app = createHubApp({
    service,
    ownerToken: `aco_${"a".repeat(64)}`,
    allowedOrigin: origin,
    secureCookies: false,
  });
  const listener = app.listen(port, "127.0.0.1");
  listeners.push(listener);
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  return origin;
}

describe("Hub dashboard contract", () => {
  it("ships a self-contained accessible signal-box shell", () => {
    expect(html).toContain('href="#view-content"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Operations views"');
    expect(html).toContain('data-view="jobs"');
    expect(html).toMatch(/<dialog\s+id="confirm-dialog"/);
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toContain(" onclick=");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (max-width: 700px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(`${html}\n${css}\n${javascript}`).not.toMatch(/https?:\/\//);
  });

  it("uses DOM text boundaries and exposes only the approved owner controls", () => {
    expect(javascript).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|eval\s*\(/,
    );
    expect(javascript).toContain('"/api/v1/admin/messages"');
    expect(javascript).toContain('"/api/v1/admin/devices/revoke"');
    expect(javascript).toContain('"/api/v1/admin/integrations/cancel"');
    expect(javascript).toContain('"/api/v1/admin/reconciliations"');
    expect(javascript).not.toMatch(
      /admin\/(shell|git|filesystem|leases\/release)/,
    );
    expect(javascript).not.toContain('"/api/v1/admin/enrollments"');
    expect(javascript).toContain("!item.claimedBy");
    expect(javascript).toContain("page.nextCursor");
    expect(javascript).toContain('"jobs"');
    expect(javascript).toContain("staleness does not prove abandonment");
  });

  it("refreshes a quiet dashboard until an abandoned active job becomes stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const store = new CoordinationStore(":memory:", {
      jobActivityTimeoutMs: 1_000,
    });
    stores.push(store);
    const service = new HubService(store);
    const device = enrollDevice(store, "Quiet PC");
    const observed = workspace(
      device.deviceId,
      "agentconduit.quiet-dashboard",
      "9",
      "feature/quiet-dashboard",
    );
    const agent = service.execute(device.deviceToken, "agent.register", {
      runtime: "codex",
      workspace: observed,
      sessionRef: "quiet-dashboard-agent",
    });
    service.execute(device.deviceToken, "job.create", {
      agentId: agent.agentId,
      sessionToken: agent.sessionToken,
      input: {
        idempotencyKey: "create:quiet-dashboard-job",
        kind: "analysis",
        displayName: "Quiet dashboard job",
      },
    });
    const unchangedAuditCursor = store.latestAuditCursor();

    class DashboardNode {
      children: DashboardNode[] = [];
      attributes = new Map<string, string>();
      dataset: Record<string, string> = {};
      textContent = "";
      className = "";
      title = "";
      hidden = false;
      value = "";
      disabled = false;

      constructor(text = "") {
        this.textContent = text;
      }

      append(...children: DashboardNode[]) {
        this.children.push(...children);
      }

      replaceChildren(...children: DashboardNode[]) {
        this.children = [...children];
      }

      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      }

      removeAttribute(name: string) {
        this.attributes.delete(name);
      }

      addEventListener() {}

      focus() {}

      querySelector() {
        return new DashboardNode();
      }

      querySelectorAll() {
        return [];
      }

      renderedText(): string {
        return [
          this.textContent,
          ...this.children.map((child) => child.renderedText()),
        ].join(" ");
      }
    }

    const nodes = new Map<string, DashboardNode>();
    const nodeFor = (selector: string) => {
      let node = nodes.get(selector);
      if (!node) {
        node = new DashboardNode();
        nodes.set(selector, node);
      }
      return node;
    };
    const document = {
      title: "",
      querySelector: nodeFor,
      querySelectorAll: () => [],
      createElement: () => new DashboardNode(),
      createTextNode: (text: string) => new DashboardNode(text),
      addEventListener: () => undefined,
    };
    class SilentEventSource {
      addEventListener() {}
      close() {}
    }
    let snapshotReads = 0;
    const response = (result: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ result }),
    });
    const fetch = async (path: string) => {
      if (path === "/api/v1/auth/session") {
        return response({
          csrfToken: "csrf-test-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (path.startsWith("/api/v1/admin/snapshot")) {
        snapshotReads += 1;
        return response(service.snapshot());
      }
      throw new Error(`Unexpected dashboard request: ${path}`);
    };
    const window = {
      setTimeout,
      clearTimeout,
    };

    runInNewContext(javascript, {
      console,
      Date,
      document,
      EventSource: SilentEventSource,
      fetch,
      FormData: class {},
      HTMLFormElement: DashboardNode,
      Intl,
      Node: DashboardNode,
      window,
    });
    for (let index = 0; index < 12; index += 1) await Promise.resolve();

    expect(snapshotReads).toBe(1);
    expect(nodeFor("#view-content").renderedText()).not.toContain(
      "Quiet dashboard job is stale",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();

    expect(snapshotReads).toBeGreaterThan(1);
    expect(nodeFor("#view-content").renderedText()).toContain(
      "Quiet dashboard job is stale",
    );
    expect(store.latestAuditCursor()).toBe(unchangedAuditCursor);
  });

  it("serves the dashboard and its assets under the hardened Hub headers", async () => {
    const origin = await startDashboard();
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await page.text()).toContain("AgentConduit signal box");

    const stylesheet = await fetch(`${origin}/styles.css`);
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toContain("text/css");
    const script = await fetch(`${origin}/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
  });
});
