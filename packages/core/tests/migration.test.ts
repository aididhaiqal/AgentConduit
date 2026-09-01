import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CoordinationStore,
  migrateCoordinationDatabase,
  preflightCoordinationMigration,
} from "../src/store.js";

const LEGACY_SCHEMA = `
  CREATE TABLE workspaces (
    worktree_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL,
    root_path TEXT NOT NULL, common_git_dir TEXT NOT NULL, git_dir TEXT NOT NULL,
    remote_url TEXT, branch TEXT, head_oid TEXT NOT NULL, dirty INTEGER NOT NULL,
    ahead INTEGER NOT NULL, behind INTEGER NOT NULL, is_bare INTEGER NOT NULL,
    observed_at TEXT NOT NULL
  );
  CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY, runtime TEXT NOT NULL, display_name TEXT,
    session_key TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(worktree_id),
    capabilities_json TEXT NOT NULL, last_heartbeat TEXT NOT NULL,
    registered_at TEXT NOT NULL, unregistered_at TEXT
  );
  CREATE TABLE messages (
    message_id TEXT PRIMARY KEY, sender_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    recipient_agent_id TEXT NOT NULL REFERENCES agents(agent_id), body TEXT NOT NULL,
    correlation_id TEXT, created_at TEXT NOT NULL, acknowledged_at TEXT
  );
  CREATE TABLE lease_counters (resource TEXT PRIMARY KEY, next_token INTEGER NOT NULL);
  CREATE TABLE leases (
    lease_id TEXT PRIMARY KEY, resource TEXT NOT NULL,
    holder_agent_id TEXT NOT NULL REFERENCES agents(agent_id), fencing_token INTEGER NOT NULL,
    acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE integration_requests (
    request_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, source_ref TEXT NOT NULL,
    source_oid TEXT NOT NULL, target_ref TEXT NOT NULL, observed_target_oid TEXT NOT NULL,
    status TEXT NOT NULL, requested_by TEXT NOT NULL REFERENCES agents(agent_id),
    claimed_by TEXT REFERENCES agents(agent_id), lease_id TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, completed_at TEXT, result_json TEXT
  );
  CREATE TABLE audit_events (
    event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, actor_agent_id TEXT,
    resource_id TEXT, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
`;

function temporaryDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "agentconduit-migration-"));
  return { directory, path: join(directory, "coordination.sqlite") };
}

function columnNames(database: Database.Database, table: string): string[] {
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

describe("CoordinationStore migrations", () => {
  it("upgrades the known unversioned additive schema and stamps its version", () => {
    const database = temporaryDatabase();
    let store: CoordinationStore | undefined;
    try {
      const legacy = new Database(database.path);
      legacy.exec(LEGACY_SCHEMA);
      legacy.close();

      store = new CoordinationStore(database.path);
      expect(columnNames(store.db, "workspaces")).toContain("project_id");
      expect(columnNames(store.db, "workspaces")).toContain("upstream_status");
      expect(columnNames(store.db, "workspaces")).toContain("upstream_ref");
      expect(columnNames(store.db, "agents")).toContain("session_secret_hash");
      expect(store.db.pragma("user_version", { simple: true })).toBe(4);
      expect(columnNames(store.db, "audit_events")).toContain("event_cursor");
      expect(columnNames(store.db, "devices")).toContain("device_id");
    } finally {
      store?.close();
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("upgrades the version-one schema without treating old zero counts as synchronized", () => {
    const database = temporaryDatabase();
    let store: CoordinationStore | undefined;
    try {
      const versionOne = new Database(database.path);
      versionOne.exec(LEGACY_SCHEMA);
      versionOne.exec(
        "ALTER TABLE workspaces ADD COLUMN project_id TEXT; ALTER TABLE agents ADD COLUMN session_secret_hash TEXT;",
      );
      versionOne
        .prepare(
          `INSERT INTO workspaces
            (worktree_id, repository_id, root_path, common_git_dir, git_dir, branch,
             head_oid, dirty, ahead, behind, is_bare, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "wt_v1",
          "repo_v1",
          "/tmp/v1",
          "/tmp/v1/.git",
          "/tmp/v1/.git",
          "main",
          "a".repeat(40),
          0,
          0,
          0,
          0,
          "2026-08-31T00:00:00.000Z",
        );
      versionOne.pragma("user_version = 1");
      versionOne.close();

      store = new CoordinationStore(database.path);

      expect(store.db.pragma("user_version", { simple: true })).toBe(4);
      expect(columnNames(store.db, "workspaces")).toContain("upstream_status");
      expect(columnNames(store.db, "workspaces")).toContain("upstream_ref");
      const [workspace] = store.listWorkspaces("repo_v1");
      expect(workspace?.upstream).toEqual({ status: "unavailable" });
      expect(workspace).not.toHaveProperty("ahead");
      expect(workspace).not.toHaveProperty("behind");
    } finally {
      store?.close();
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("upgrades the production-workstation version-two schema and preserves ordered audit history", () => {
    const database = temporaryDatabase();
    let store: CoordinationStore | undefined;
    try {
      const versionTwo = new Database(database.path);
      versionTwo.exec(LEGACY_SCHEMA);
      versionTwo.exec(`
        ALTER TABLE workspaces ADD COLUMN project_id TEXT;
        ALTER TABLE workspaces ADD COLUMN upstream_status TEXT NOT NULL DEFAULT 'unavailable';
        ALTER TABLE workspaces ADD COLUMN upstream_ref TEXT;
        ALTER TABLE agents ADD COLUMN session_secret_hash TEXT;
        CREATE INDEX idx_workspaces_repository ON workspaces(repository_id);
        CREATE UNIQUE INDEX idx_agents_session_workspace ON agents(session_key, workspace_id);
        CREATE INDEX idx_agents_workspace ON agents(workspace_id);
        CREATE INDEX idx_messages_inbox ON messages(recipient_agent_id, acknowledged_at, created_at);
        CREATE UNIQUE INDEX idx_leases_resource ON leases(resource);
        CREATE INDEX idx_integrations_queue ON integration_requests(repository_id, target_ref, created_at);
        INSERT INTO audit_events(event_id, event_type, metadata_json, created_at)
          VALUES ('legacy-event', 'legacy.recorded', '{}', '2026-08-31T00:00:00.000Z');
      `);
      versionTwo.pragma("user_version = 2");
      versionTwo.close();

      store = new CoordinationStore(database.path);

      expect(store.db.pragma("user_version", { simple: true })).toBe(4);
      expect(store.listAuditEvents()).toMatchObject([
        {
          cursor: 1,
          eventId: "legacy-event",
          eventType: "legacy.recorded",
        },
      ]);
      expect(store.recordAuditEvent("remote.enabled").cursor).toBe(2);
      expect(columnNames(store.db, "devices")).toContain("token_hash");
      expect(columnNames(store.db, "workspace_devices")).toContain("device_id");
    } finally {
      store?.close();
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("upgrades schema version three additively with the durable job tables", () => {
    const database = temporaryDatabase();
    let store: CoordinationStore | undefined;
    try {
      const current = new CoordinationStore(database.path);
      current.close();
      const versionThree = new Database(database.path);
      versionThree.exec("DROP TABLE job_events; DROP TABLE jobs;");
      versionThree.pragma("user_version = 3");
      versionThree.close();

      expect(preflightCoordinationMigration(database.path)).toMatchObject({
        currentVersion: 3,
        targetVersion: 4,
        migrationRequired: true,
      });
      store = new CoordinationStore(database.path);

      expect(store.db.pragma("user_version", { simple: true })).toBe(4);
      expect(columnNames(store.db, "jobs")).toContain("last_event_cursor");
      expect(columnNames(store.db, "job_events")).toContain("event_sequence");
      expect(store.recordAuditEvent("after.job-migration").cursor).toBe(1);
    } finally {
      store?.close();
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("requires an explicit production migration without mutating an old schema", () => {
    const database = temporaryDatabase();
    try {
      const versionOne = new Database(database.path);
      versionOne.exec(LEGACY_SCHEMA);
      versionOne.exec(
        "ALTER TABLE workspaces ADD COLUMN project_id TEXT; ALTER TABLE agents ADD COLUMN session_secret_hash TEXT;",
      );
      versionOne.pragma("user_version = 1");
      versionOne.close();

      expect(
        () =>
          new CoordinationStore(database.path, {
            migrations: "require-current",
          }),
      ).toThrowError(
        expect.objectContaining({
          code: "storage_error",
          details: {
            currentVersion: 1,
            requiredVersion: 4,
            action: "run_production_migration",
          },
        }),
      );

      const inspection = new Database(database.path);
      expect(inspection.pragma("user_version", { simple: true })).toBe(1);
      expect(inspection.pragma("journal_mode", { simple: true })).toBe(
        "delete",
      );
      expect(columnNames(inspection, "workspaces")).not.toContain(
        "upstream_status",
      );
      inspection.close();
    } finally {
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("preflights without mutation and migrates only after publishing a verified legacy backup", async () => {
    const database = temporaryDatabase();
    const backupPath = join(database.directory, "before-migration.sqlite");
    try {
      const versionOne = new Database(database.path);
      versionOne.exec(LEGACY_SCHEMA);
      versionOne.exec(
        "ALTER TABLE workspaces ADD COLUMN project_id TEXT; ALTER TABLE agents ADD COLUMN session_secret_hash TEXT;",
      );
      versionOne
        .prepare(
          `INSERT INTO workspaces
            (worktree_id, repository_id, root_path, common_git_dir, git_dir, branch,
             head_oid, dirty, ahead, behind, is_bare, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "wt_preserved",
          "repo_preserved",
          "/tmp/preserved",
          "/tmp/preserved/.git",
          "/tmp/preserved/.git",
          "main",
          "a".repeat(40),
          0,
          0,
          0,
          0,
          "2026-08-31T00:00:00.000Z",
        );
      versionOne.pragma("user_version = 1");
      versionOne.close();

      expect(preflightCoordinationMigration(database.path)).toEqual({
        databasePath: database.path,
        currentVersion: 1,
        targetVersion: 4,
        migrationRequired: true,
        quickCheck: "ok",
        foreignKeyViolations: 0,
      });
      const unchanged = new Database(database.path);
      expect(unchanged.pragma("user_version", { simple: true })).toBe(1);
      expect(columnNames(unchanged, "workspaces")).not.toContain(
        "upstream_status",
      );
      unchanged.close();

      await expect(
        migrateCoordinationDatabase(database.path, backupPath),
      ).resolves.toMatchObject({
        status: "migrated",
        databasePath: database.path,
        fromVersion: 1,
        toVersion: 4,
        backup: {
          destinationPath: backupPath,
          schemaVersion: 1,
          quickCheck: "ok",
        },
        database: { status: "ok", schemaVersion: 4 },
      });
      expect(existsSync(backupPath)).toBe(true);

      const backup = new Database(backupPath, {
        readonly: true,
        fileMustExist: true,
      });
      expect(backup.pragma("user_version", { simple: true })).toBe(1);
      expect(columnNames(backup, "workspaces")).not.toContain(
        "upstream_status",
      );
      expect(
        backup
          .prepare("SELECT repository_id FROM workspaces WHERE worktree_id = ?")
          .get("wt_preserved"),
      ).toEqual({ repository_id: "repo_preserved" });
      backup.close();

      const migrated = new CoordinationStore(database.path, {
        migrations: "require-current",
      });
      expect(migrated.listWorkspaces("repo_preserved")).toHaveLength(1);
      migrated.close();

      await expect(
        migrateCoordinationDatabase(database.path, backupPath),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("fails closed for newer and unknown legacy schemas", () => {
    const database = temporaryDatabase();
    try {
      const future = new Database(database.path);
      future.pragma("user_version = 5");
      future.close();
      expect(() => new CoordinationStore(database.path)).toThrowError(
        expect.objectContaining({ code: "storage_error" }),
      );

      rmSync(database.path, { force: true });
      const current = new CoordinationStore(database.path);
      current.close();
      const missingTable = new Database(database.path);
      missingTable.exec("DROP TABLE audit_events");
      missingTable.close();
      expect(() => new CoordinationStore(database.path)).toThrowError(
        expect.objectContaining({ code: "storage_error" }),
      );
      const inspection = new Database(database.path);
      const auditTable = inspection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'",
        )
        .get();
      expect(auditTable).toBeUndefined();
      inspection.close();

      rmSync(database.path, { force: true });
      const unknown = new Database(database.path);
      unknown.exec(
        `${LEGACY_SCHEMA} ALTER TABLE agents ADD COLUMN mystery TEXT;`,
      );
      unknown.close();
      expect(() => new CoordinationStore(database.path)).toThrowError(
        expect.objectContaining({ code: "storage_error" }),
      );

      rmSync(database.path, { force: true });
      const unrelated = new Database(database.path);
      unrelated.exec("CREATE TABLE application_state (id INTEGER PRIMARY KEY)");
      unrelated.close();
      expect(() => new CoordinationStore(database.path)).toThrowError(
        expect.objectContaining({ code: "storage_error" }),
      );
    } finally {
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("fails closed when current coordination constraints or table ownership drift", () => {
    const database = temporaryDatabase();
    try {
      const current = new CoordinationStore(database.path);
      current.close();
      const missingIndex = new Database(database.path);
      missingIndex.exec("DROP INDEX idx_leases_resource");
      missingIndex.close();

      expect(
        () =>
          new CoordinationStore(database.path, {
            migrations: "require-current",
          }),
      ).toThrowError(
        expect.objectContaining({
          code: "storage_error",
          message: "Unsupported index idx_leases_resource",
        }),
      );

      rmSync(database.path, { force: true });
      const fresh = new CoordinationStore(database.path);
      fresh.close();
      const mixed = new Database(database.path);
      mixed.exec("CREATE TABLE unrelated_state (id INTEGER PRIMARY KEY)");
      mixed.close();

      expect(
        () =>
          new CoordinationStore(database.path, {
            migrations: "require-current",
          }),
      ).toThrowError(
        expect.objectContaining({
          code: "storage_error",
          message: "Database contains unsupported tables",
        }),
      );
    } finally {
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("fails closed for a non-AgentConduit database with a version marker", () => {
    const database = temporaryDatabase();
    try {
      const unrelated = new Database(database.path);
      unrelated.exec("CREATE TABLE application_state (id INTEGER PRIMARY KEY)");
      unrelated.pragma("user_version = 1");
      unrelated.close();

      expect(() => new CoordinationStore(database.path)).toThrowError(
        expect.objectContaining({ code: "storage_error" }),
      );

      const inspection = new Database(database.path);
      expect(
        inspection
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "application_state" }]);
      expect(inspection.pragma("user_version", { simple: true })).toBe(1);
      inspection.close();
    } finally {
      rmSync(database.directory, { recursive: true, force: true });
    }
  });

  it("normalizes database-open lock contention as a retryable conflict", () => {
    const database = temporaryDatabase();
    let blocker: Database.Database | undefined;
    try {
      blocker = new Database(database.path);
      blocker.exec(LEGACY_SCHEMA);
      blocker.exec("BEGIN IMMEDIATE");
      expect(() => new CoordinationStore(database.path)).toThrowError(
        expect.objectContaining({
          code: "conflict",
          details: {
            operation: "storage.open",
            sqliteCode: "SQLITE_BUSY",
          },
        }),
      );
    } finally {
      if (blocker?.inTransaction) blocker.exec("ROLLBACK");
      blocker?.close();
      rmSync(database.directory, { recursive: true, force: true });
    }
  });
});
