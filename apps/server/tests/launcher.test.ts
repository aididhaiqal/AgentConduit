import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { afterEach, describe, expect, test } from "vitest";

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback test port");
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

async function waitForReady(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`Readiness returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw lastError ?? new Error("Timed out waiting for readiness");
}

describe("agentconduit-mcp launcher", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "runs when Node receives an npm-bin-style symlink path",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "agentconduit-bin-"));
      temporaryDirectories.push(directory);
      const launcher = resolve(import.meta.dirname, "../dist/main.js");
      const binLink = join(directory, "agentconduit-mcp");
      symlinkSync(launcher, binLink);

      const result = spawnSync(process.execPath, [binLink, "--help"], {
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("AgentConduit MCP broker");
    },
  );

  test.skipIf(process.platform === "win32")(
    "initializes, doctors, and backs up a production workstation database without printing its token",
    () => {
      const root = mkdtempSync("/tmp/agentconduit-launcher-production-");
      temporaryDirectories.push(root);
      const launcher = resolve(import.meta.dirname, "../dist/main.js");
      const configDirectory = join(root, "config");
      const dataDirectory = join(root, "data");
      const workspaceDirectory = join(root, "workspaces");
      const backupDirectory = join(root, "backup");
      for (const directory of [
        configDirectory,
        dataDirectory,
        workspaceDirectory,
        backupDirectory,
      ]) {
        mkdirSync(directory, { mode: 0o700 });
      }
      const configPath = join(configDirectory, "config.json");
      const backupPath = join(backupDirectory, "coordination.db");

      const initialized = spawnSync(
        process.execPath,
        [
          launcher,
          "init",
          "--config",
          configPath,
          "--data-dir",
          dataDirectory,
          "--allowed-root",
          workspaceDirectory,
        ],
        { encoding: "utf8" },
      );
      expect(initialized.status).toBe(0);
      expect(initialized.stderr).toBe("");
      const initResult = JSON.parse(initialized.stdout) as {
        command: string;
        config: { tokenFile: string };
      };
      expect(initResult.command).toBe("init");
      const token = readFileSync(initResult.config.tokenFile, "utf8").trim();
      expect(token).toHaveLength(43);
      expect(initialized.stdout).not.toContain(token);

      const doctor = spawnSync(
        process.execPath,
        [launcher, "doctor", "--config", configPath],
        { encoding: "utf8" },
      );
      expect(doctor.status).toBe(0);
      expect(JSON.parse(doctor.stdout)).toMatchObject({
        command: "doctor",
        profile: "production",
        database: { status: "ok", schemaVersion: 4 },
      });
      expect(doctor.stdout).not.toContain(token);

      const backup = spawnSync(
        process.execPath,
        [launcher, "backup", "--config", configPath, "--output", backupPath],
        { encoding: "utf8" },
      );
      expect(backup.status).toBe(0);
      expect(JSON.parse(backup.stdout)).toMatchObject({
        command: "backup",
        status: "verified",
        destinationPath: backupPath,
        quickCheck: "ok",
      });
      expect(backup.stdout).not.toContain(token);

      const migration = spawnSync(
        process.execPath,
        [launcher, "migrate", "--config", configPath],
        { encoding: "utf8" },
      );
      expect(migration.status).toBe(0);
      expect(JSON.parse(migration.stdout)).toMatchObject({
        command: "migrate",
        mode: "preview",
        currentVersion: 4,
        targetVersion: 4,
        migrationRequired: false,
      });
      expect(migration.stdout).not.toContain(token);

      const maintenanceCutoff = "2020-01-01T00:00:00.000Z";
      const maintenance = spawnSync(
        process.execPath,
        [
          launcher,
          "maintenance",
          "--config",
          configPath,
          "--stale-before",
          maintenanceCutoff,
          "--messages-before",
          maintenanceCutoff,
          "--integrations-before",
          maintenanceCutoff,
          "--jobs-before",
          maintenanceCutoff,
          "--audit-before",
          maintenanceCutoff,
        ],
        { encoding: "utf8" },
      );
      expect(maintenance.status).toBe(0);
      expect(JSON.parse(maintenance.stdout)).toMatchObject({
        command: "maintenance",
        mode: "preview",
        staleAgents: { candidates: 0, blocked: 0, markedOffline: 0 },
      });
      expect(maintenance.stdout).not.toContain(token);
    },
  );

  test.skipIf(process.platform === "win32")(
    "serves readiness from the packaged production launcher and drains cleanly on SIGTERM",
    async () => {
      const root = mkdtempSync("/tmp/agentconduit-launcher-runtime-");
      temporaryDirectories.push(root);
      const launcher = resolve(import.meta.dirname, "../dist/main.js");
      const configDirectory = join(root, "config");
      const dataDirectory = join(root, "data");
      const workspaceDirectory = join(root, "workspaces");
      for (const directory of [
        configDirectory,
        dataDirectory,
        workspaceDirectory,
      ]) {
        mkdirSync(directory, { mode: 0o700 });
      }
      const configPath = join(configDirectory, "config.json");
      const initialized = spawnSync(
        process.execPath,
        [
          launcher,
          "init",
          "--config",
          configPath,
          "--data-dir",
          dataDirectory,
          "--allowed-root",
          workspaceDirectory,
        ],
        { encoding: "utf8" },
      );
      expect(initialized.status).toBe(0);
      const tokenFile = (
        JSON.parse(initialized.stdout) as {
          config: { tokenFile: string };
        }
      ).config.tokenFile;
      const token = readFileSync(tokenFile, "utf8").trim();
      const port = await reserveLoopbackPort();
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
        string,
        unknown
      >;
      config.port = port;
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
      });

      const child = spawn(
        process.execPath,
        [launcher, "serve", "--config", configPath],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (value: string) => {
        stdout += value;
      });
      child.stderr.on("data", (value: string) => {
        stderr += value;
      });
      try {
        const ready = await waitForReady(
          `http://127.0.0.1:${port}/readyz`,
          5_000,
        );
        await expect(ready.json()).resolves.toMatchObject({ status: "ready" });
        const databasePath = String(config.databasePath);
        for (const path of [
          databasePath,
          `${databasePath}-wal`,
          `${databasePath}-shm`,
        ]) {
          expect(existsSync(path)).toBe(true);
          expect(statSync(path).mode & 0o077).toBe(0);
        }
        expect(child.kill("SIGTERM")).toBe(true);
        const exit = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolveExit, rejectExit) => {
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            rejectExit(new Error("Production launcher did not drain in time"));
          }, 5_000);
          child.once("exit", (code, signal) => {
            clearTimeout(timeout);
            resolveExit({ code, signal });
          });
        });
        expect(exit).toEqual({ code: 0, signal: null });
        expect(stdout).toBe("");
        const events = stderr
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string });
        expect(events.map((entry) => entry.event)).toEqual(
          expect.arrayContaining([
            "broker.started",
            "http.request",
            "broker.draining",
            "broker.stopped",
          ]),
        );
        expect(stderr).not.toContain(token);

        const doctor = spawnSync(
          process.execPath,
          [launcher, "doctor", "--config", configPath],
          { encoding: "utf8" },
        );
        expect(doctor.status).toBe(0);
        expect(JSON.parse(doctor.stdout)).toMatchObject({
          database: { status: "ok", schemaVersion: 4 },
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
    },
    15_000,
  );
});
