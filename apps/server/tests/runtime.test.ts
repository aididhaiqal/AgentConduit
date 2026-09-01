import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeProductionConfig,
  loadProductionConfig,
} from "../src/config.js";
import {
  initializeProductionDatabase,
  openProductionService,
} from "../src/operations.js";
import { silentLogger } from "../src/logging.js";
import type { StructuredLogger } from "../src/logging.js";
import { startProductionHttpBroker } from "../src/runtime.js";

describe("production HTTP runtime", () => {
  const directories: string[] = [];

  function configuration(port = 0) {
    const root = mkdtempSync("/tmp/agentconduit-production-runtime-");
    directories.push(root);
    const configDirectory = join(root, "config");
    const dataDirectory = join(root, "data");
    const workspaceRoot = join(root, "workspaces");
    for (const directory of [configDirectory, dataDirectory, workspaceRoot]) {
      mkdirSync(directory, { mode: 0o700 });
    }
    const configPath = join(configDirectory, "config.json");
    initializeProductionConfig({
      configPath,
      dataDirectory,
      allowedRoots: [workspaceRoot],
    });
    const config = { ...loadProductionConfig(configPath), port };
    initializeProductionDatabase(config);
    return config;
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("checks database health before binding and closes on failure", async () => {
    const config = configuration();
    const service = openProductionService(config);
    service.store.db.pragma("foreign_keys = OFF");
    service.store.db
      .prepare(
        `INSERT INTO leases
          (lease_id, resource, holder_agent_id, fencing_token, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "lea_runtime_invalid_foreign_key",
        "test:runtime-invalid-foreign-key",
        "agt_missing",
        1,
        new Date().toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      );

    let runtime:
      Awaited<ReturnType<typeof startProductionHttpBroker>> | undefined;
    let failure: unknown;
    try {
      runtime = await startProductionHttpBroker({
        service,
        config,
        logger: silentLogger,
      });
    } catch (error) {
      failure = error;
    } finally {
      await runtime?.close("test-cleanup");
    }

    expect(failure).toMatchObject({ code: "storage_error" });
    expect(() => service.store.healthCheck()).toThrow();
  });

  it("closes the service and never logs startup when listener binding fails", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = blocker.address() as AddressInfo;
      const config = configuration(address.port);
      const service = openProductionService(config);
      const events: string[] = [];
      const logger: StructuredLogger = {
        info: (event) => events.push(event),
        warn: (event) => events.push(event),
        error: (event) => events.push(event),
      };

      await expect(
        startProductionHttpBroker({ service, config, logger }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(events).not.toContain("broker.started");
      expect(() => service.store.healthCheck()).toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
