import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hubConfigSummary,
  initializeHubConfig,
  loadHubConfig,
} from "../src/config.js";
import { parseHubCliArgs } from "../src/main.js";

function fixture() {
  const temporaryRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const root = mkdtempSync(join(temporaryRoot, "agentconduit-hub-config-"));
  const configDirectory = join(root, "config");
  const dataDirectory = join(root, "data");
  mkdirSync(configDirectory, { mode: 0o700 });
  mkdirSync(dataDirectory, { mode: 0o700 });
  return {
    root,
    configDirectory,
    dataDirectory,
    configPath: join(configDirectory, "hub.json"),
  };
}

describe("Hub production configuration", () => {
  it("initializes a protected loopback-proxy profile without disclosing its owner token", () => {
    const item = fixture();
    try {
      const summary = initializeHubConfig({
        configPath: item.configPath,
        dataDirectory: item.dataDirectory,
        publicBaseUrl: "https://hub.example.test",
      });
      expect(summary).toMatchObject({
        profile: "hub-production",
        publicBaseUrl: "https://hub.example.test",
        transport: { mode: "loopback-proxy", host: "127.0.0.1", port: 8790 },
      });
      const loaded = loadHubConfig(item.configPath);
      expect(loaded.ownerToken).toMatch(/^aco_[0-9a-f]{64}$/);
      expect(JSON.stringify(summary)).not.toContain(loaded.ownerToken);
      expect(JSON.stringify(hubConfigSummary(loaded))).not.toContain(
        loaded.ownerToken,
      );
      expect(readFileSync(summary.ownerTokenFile, "utf8").trim()).toBe(
        loaded.ownerToken,
      );
      if (process.platform !== "win32") {
        expect(statSync(item.configPath).mode & 0o077).toBe(0);
        expect(statSync(summary.ownerTokenFile).mode & 0o077).toBe(0);
        expect(statSync(summary.databasePath).mode & 0o077).toBe(0);
      }
      expect(() =>
        initializeHubConfig({
          configPath: item.configPath,
          dataDirectory: item.dataDirectory,
          publicBaseUrl: "https://hub.example.test",
        }),
      ).toThrow(/already exists/);
    } finally {
      rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("requires an HTTPS public origin and private direct-TLS key material", () => {
    const item = fixture();
    try {
      expect(() =>
        initializeHubConfig({
          configPath: item.configPath,
          dataDirectory: item.dataDirectory,
          publicBaseUrl: "http://hub.example.test",
        }),
      ).toThrow(/HTTPS/);

      const certificateFile = join(item.root, "certificate.pem");
      const privateKeyFile = join(item.root, "private-key.pem");
      writeFileSync(certificateFile, "test certificate\n", { mode: 0o644 });
      writeFileSync(privateKeyFile, "test private key\n", { mode: 0o600 });
      if (process.platform !== "win32") chmodSync(privateKeyFile, 0o644);
      expect(() =>
        initializeHubConfig({
          configPath: item.configPath,
          dataDirectory: item.dataDirectory,
          publicBaseUrl: "https://hub.example.test",
          transport: {
            mode: "direct-tls",
            host: "0.0.0.0",
            certificateFile,
            privateKeyFile,
          },
        }),
      ).toThrow(/private-key file permissions/);
    } finally {
      rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("parses bounded CLI commands and keeps secret values out of arguments", () => {
    expect(
      parseHubCliArgs([
        "init",
        "--config",
        "/private/hub.json",
        "--data-dir",
        "/private/data",
        "--public-base-url",
        "https://hub.example.test",
      ]),
    ).toMatchObject({
      command: "init",
      directTls: false,
      apply: false,
      configPath: "/private/hub.json",
      dataDirectory: "/private/data",
    });
    expect(
      parseHubCliArgs([
        "backup",
        "--config",
        "/private/hub.json",
        "--destination",
        "/private/backup.db",
      ]),
    ).toMatchObject({ command: "backup", destination: "/private/backup.db" });
    expect(
      parseHubCliArgs(["migrate", "--config", "/private/hub.json"]),
    ).toMatchObject({ command: "migrate", apply: false });
    expect(
      parseHubCliArgs([
        "migrate",
        "--config",
        "/private/hub.json",
        "--apply",
        "--backup",
        "/private/pre-v3.db",
      ]),
    ).toMatchObject({
      command: "migrate",
      apply: true,
      backupPath: "/private/pre-v3.db",
    });
    expect(() =>
      parseHubCliArgs([
        "migrate",
        "--config",
        "/private/hub.json",
        "--backup",
        "/private/unexpected.db",
      ]),
    ).toThrow("valid only with migrate --apply");
    expect(
      parseHubCliArgs([
        "enroll-device",
        "--config",
        "/private/hub.json",
        "--name",
        "Travel laptop",
      ]),
    ).toMatchObject({ command: "enroll-device", nameHint: "Travel laptop" });
    expect(() =>
      parseHubCliArgs([
        "doctor",
        "--config",
        "/private/hub.json",
        "--port",
        "9876",
      ]),
    ).toThrow("doctor does not accept --port");
    expect(() =>
      parseHubCliArgs([
        "serve",
        "--config",
        "relative.json",
        "--owner-token",
        "secret",
      ]),
    ).toThrow();
  });

  it("creates a one-time device enrollment without printing the owner token", () => {
    const item = fixture();
    try {
      initializeHubConfig({
        configPath: item.configPath,
        dataDirectory: item.dataDirectory,
        publicBaseUrl: "https://hub.example.test",
      });
      const config = loadHubConfig(item.configPath);
      const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
      const output = execFileSync(
        process.execPath,
        [
          main,
          "enroll-device",
          "--config",
          item.configPath,
          "--name",
          "Travel laptop",
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(output)).toMatchObject({
        command: "enroll-device",
        status: "created",
        enrollment: {
          enrollmentCode: expect.stringMatching(/^ace_[0-9a-f]{48}$/),
        },
      });
      expect(output).not.toContain(config.ownerToken);
    } finally {
      rmSync(item.root, { recursive: true, force: true });
    }
  });
});
