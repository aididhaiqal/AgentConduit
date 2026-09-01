import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationStore } from "@agentconduit/core";
import {
  initializeProductionConfig,
  loadProductionConfig,
} from "../src/config.js";
import {
  backupProduction,
  doctorProduction,
  initializeProductionDatabase,
  maintainProduction,
  migrateProduction,
  openProductionService,
  preflightProductionMigration,
} from "../src/operations.js";

describe("production database operations", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function configuration() {
    const temporaryRoot = process.platform === "win32" ? tmpdir() : "/tmp";
    const root = mkdtempSync(
      join(temporaryRoot, "agentconduit-production-operations-"),
    );
    directories.push(root);
    const configDirectory = join(root, "config");
    const dataDirectory = join(root, "data");
    const workspaceRoot = join(root, "workspaces");
    mkdirSync(configDirectory, { mode: 0o700 });
    mkdirSync(dataDirectory, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const configPath = join(configDirectory, "config.json");
    initializeProductionConfig({
      configPath,
      dataDirectory,
      allowedRoots: [workspaceRoot],
    });
    return { root, config: loadProductionConfig(configPath) };
  }

  it("initializes, doctors, and reopens only the current database schema", () => {
    const { config } = configuration();
    expect(initializeProductionDatabase(config)).toMatchObject({
      status: "ok",
      schemaVersion: 4,
    });
    expect(() => initializeProductionDatabase(config)).toThrow(
      "Production database file already exists",
    );
    expect(doctorProduction(config)).toMatchObject({
      profile: "production",
      database: {
        path: config.databasePath,
        status: "ok",
        schemaVersion: 4,
      },
      allowedRootCount: 1,
      host: "127.0.0.1",
      port: 8787,
    });
    const service = openProductionService(config);
    expect(service.heartbeatTimeoutMs).toBe(90_000);
    expect(service.allowedRoots).toEqual(config.allowedRoots);
    service.close();
  });

  it("does not create a missing database during production serving", () => {
    const { config } = configuration();

    expect(existsSync(config.databasePath)).toBe(false);
    expect(() => openProductionService(config)).toThrow();
    expect(existsSync(config.databasePath)).toBe(false);
  });

  it("rejects a current-schema database with foreign-key violations", () => {
    const { config } = configuration();
    initializeProductionDatabase(config);
    const corruptor = new CoordinationStore(config.databasePath, {
      migrations: "require-current",
    });
    corruptor.db.pragma("foreign_keys = OFF");
    corruptor.db
      .prepare(
        `INSERT INTO leases
          (lease_id, resource, holder_agent_id, fencing_token, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "lea_invalid_foreign_key",
        "test:invalid-foreign-key",
        "agt_missing",
        1,
        new Date().toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      );
    corruptor.close();

    expect(() => openProductionService(config)).toThrowError(
      expect.objectContaining({ code: "storage_error" }),
    );
  });

  it("creates a verified production backup without overwriting", async () => {
    const { root, config } = configuration();
    initializeProductionDatabase(config);
    const destination = join(root, "backup", "coordination.db");
    mkdirSync(join(root, "backup"), { mode: 0o700 });

    await expect(backupProduction(config, destination)).resolves.toMatchObject({
      destinationPath: destination,
      schemaVersion: 4,
      quickCheck: "ok",
    });
    await expect(backupProduction(config, destination)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("previews production maintenance by default and applies only explicitly", () => {
    const { config } = configuration();
    initializeProductionDatabase(config);
    const cutoff = "2020-01-01T00:00:00.000Z";
    const policy = {
      staleBefore: cutoff,
      acknowledgedMessagesBefore: cutoff,
      terminalIntegrationsBefore: cutoff,
      terminalJobsBefore: cutoff,
      auditEventsBefore: cutoff,
    };

    expect(maintainProduction(config, policy)).toMatchObject({
      mode: "preview",
      staleAgents: { candidates: 0, blocked: 0, markedOffline: 0 },
    });
    expect(maintainProduction(config, policy, { apply: true })).toMatchObject({
      mode: "applied",
      staleAgents: { candidates: 0, blocked: 0, markedOffline: 0 },
    });
  });

  it("preflights schema changes without mutation and requires a verified backup to migrate", async () => {
    const { root, config } = configuration();
    initializeProductionDatabase(config);
    const legacyMarker = openProductionService(config);
    legacyMarker.store.db.pragma("user_version = 1");
    legacyMarker.close();

    expect(preflightProductionMigration(config)).toMatchObject({
      databasePath: config.databasePath,
      currentVersion: 1,
      targetVersion: 4,
      migrationRequired: true,
    });
    const backupPath = join(root, "backup", "before-migration.db");
    mkdirSync(join(root, "backup"), { mode: 0o700 });

    await expect(migrateProduction(config, backupPath)).resolves.toMatchObject({
      status: "migrated",
      fromVersion: 1,
      toVersion: 4,
      backup: { destinationPath: backupPath, schemaVersion: 1 },
      database: { status: "ok", schemaVersion: 4 },
    });
    expect(doctorProduction(config).database.schemaVersion).toBe(4);
  });
});
