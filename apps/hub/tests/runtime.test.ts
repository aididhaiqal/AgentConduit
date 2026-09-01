import type { Server } from "node:http";
import { createServer, request } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CoordinationStore } from "@agentconduit/core";
import { initializeHubConfig, loadHubConfig } from "../src/config.js";
import type { HubLogger } from "../src/app.js";
import { startHubRuntime } from "../src/runtime.js";
import { HubService } from "../src/service.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function get(
  port: number,
  path: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { host: "hub.example.test" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    call.once("error", reject);
    call.end();
  });
}

function getTls(
  port: number,
  path: string,
  certificate: Buffer,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { host: `127.0.0.1:${port}` },
        ca: certificate,
        rejectUnauthorized: true,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    call.once("error", reject);
    call.end();
  });
}

describe("Hub production runtime", () => {
  it("serves through a loopback reverse-proxy boundary and drains before closing SQLite", async () => {
    const temporaryRoot = process.platform === "win32" ? tmpdir() : "/tmp";
    const root = mkdtempSync(join(temporaryRoot, "agentconduit-hub-runtime-"));
    const configDirectory = join(root, "config");
    const dataDirectory = join(root, "data");
    mkdirSync(configDirectory, { mode: 0o700 });
    mkdirSync(dataDirectory, { mode: 0o700 });
    const configPath = join(configDirectory, "hub.json");
    const port = await freePort();
    let runtime: Awaited<ReturnType<typeof startHubRuntime>> | undefined;
    try {
      initializeHubConfig({
        configPath,
        dataDirectory,
        publicBaseUrl: "https://hub.example.test",
        transport: { mode: "loopback-proxy", port },
      });
      const config = loadHubConfig(configPath);
      const entries: string[] = [];
      const logger: HubLogger = {
        info: (event) => entries.push(event),
        warn: (event) => entries.push(event),
        error: (event) => entries.push(event),
      };
      runtime = await startHubRuntime({
        service: new HubService(
          new CoordinationStore(config.databasePath, {
            migrations: "require-current",
          }),
        ),
        config,
        logger,
      });
      const ready = await get(port, "/readyz");
      expect(ready.status).toBe(200);
      expect(JSON.parse(ready.body)).toMatchObject({ status: "ready" });
      expect(ready.headers["strict-transport-security"]).toContain(
        "max-age=31536000",
      );

      await runtime.close("test");
      runtime = undefined;
      expect(entries).toContain("hub.started");
      expect(entries).toContain("hub.draining");
      expect(entries).toContain("hub.stopped");

      const reopened = new CoordinationStore(config.databasePath, {
        migrations: "require-current",
      });
      expect(reopened.healthCheck().status).toBe("ok");
      reopened.close();
    } finally {
      await runtime?.close("cleanup");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("performs a verified direct-TLS handshake with the configured certificate", async () => {
    const temporaryRoot = process.platform === "win32" ? tmpdir() : "/tmp";
    const root = mkdtempSync(
      join(temporaryRoot, "agentconduit-hub-direct-tls-"),
    );
    const configDirectory = join(root, "config");
    const dataDirectory = join(root, "data");
    mkdirSync(configDirectory, { mode: 0o700 });
    mkdirSync(dataDirectory, { mode: 0o700 });
    const configPath = join(configDirectory, "hub.json");
    const certificateFile = join(configDirectory, "certificate.pem");
    const privateKeyFile = join(configDirectory, "private-key.pem");
    // These source fixtures are a public, disposable localhost pair. Copying
    // into the private runtime directory exercises the production key checks.
    const fixtureDirectory = fileURLToPath(
      new URL("./fixtures/", import.meta.url),
    );
    const certificate = readFileSync(
      join(fixtureDirectory, "localhost-test-cert.pem"),
    );
    writeFileSync(certificateFile, certificate, { mode: 0o644 });
    writeFileSync(
      privateKeyFile,
      readFileSync(join(fixtureDirectory, "localhost-test-key.pem")),
      { mode: 0o600 },
    );
    if (process.platform !== "win32") chmodSync(privateKeyFile, 0o600);
    expect(statSync(privateKeyFile).mode & 0o777).toBe(0o600);
    const port = await freePort();
    let runtime: Awaited<ReturnType<typeof startHubRuntime>> | undefined;
    try {
      initializeHubConfig({
        configPath,
        dataDirectory,
        publicBaseUrl: `https://127.0.0.1:${port}`,
        transport: {
          mode: "direct-tls",
          host: "127.0.0.1",
          port,
          certificateFile,
          privateKeyFile,
        },
      });
      const config = loadHubConfig(configPath);
      runtime = await startHubRuntime({
        service: new HubService(
          new CoordinationStore(config.databasePath, {
            migrations: "require-current",
          }),
        ),
        config,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      });

      const ready = await getTls(port, "/readyz", certificate);
      expect(ready.status).toBe(200);
      expect(JSON.parse(ready.body)).toMatchObject({ status: "ready" });
      expect(runtime.publicBaseUrl).toBe(`https://127.0.0.1:${port}`);
    } finally {
      await runtime?.close("cleanup");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
