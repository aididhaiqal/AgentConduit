import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HTTP_LIMITS,
  initializeProductionConfig,
  loadProductionConfig,
  productionConfigSummary,
} from "../src/config.js";

describe("production configuration", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture(): {
    root: string;
    configPath: string;
    dataDirectory: string;
    allowedRoot: string;
  } {
    // WSL may inherit a Windows TEMP path whose DrvFS mount intentionally
    // cannot represent private POSIX modes. Use the native temporary
    // filesystem when POSIX permission behavior is under test.
    const temporaryRoot = process.platform === "win32" ? tmpdir() : "/tmp";
    const root = mkdtempSync(
      join(temporaryRoot, "agentconduit-production-config-"),
    );
    directories.push(root);
    const configDirectory = join(root, "config");
    const dataDirectory = join(root, "data");
    const allowedRoot = join(root, "workspaces");
    mkdirSync(configDirectory, { mode: 0o700 });
    mkdirSync(dataDirectory, { mode: 0o700 });
    mkdirSync(allowedRoot, { mode: 0o700 });
    return {
      root,
      configPath: join(configDirectory, "config.json"),
      dataDirectory,
      allowedRoot,
    };
  }

  it("initializes and reloads a protected token-free production summary", () => {
    const paths = fixture();
    const summary = initializeProductionConfig({
      configPath: paths.configPath,
      dataDirectory: paths.dataDirectory,
      allowedRoots: [paths.allowedRoot],
    });

    expect(summary).toMatchObject({
      profile: "production",
      databasePath: join(paths.dataDirectory, "coordination.db"),
      allowedRoots: [paths.allowedRoot],
      host: "127.0.0.1",
      port: 8787,
      http: DEFAULT_HTTP_LIMITS,
    });
    expect(summary).not.toHaveProperty("token");

    const persisted = JSON.parse(readFileSync(paths.configPath, "utf8")) as {
      token?: string;
      tokenFile: string;
    };
    expect(persisted).not.toHaveProperty("token");
    expect(readFileSync(persisted.tokenFile, "utf8").trim()).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    const loaded = loadProductionConfig(paths.configPath);
    expect(loaded.token).toHaveLength(43);
    expect(productionConfigSummary(loaded)).toEqual(summary);
  });

  it("refuses to overwrite an existing configuration or token", () => {
    const paths = fixture();
    initializeProductionConfig({
      configPath: paths.configPath,
      dataDirectory: paths.dataDirectory,
      allowedRoots: [paths.allowedRoot],
    });

    expect(() =>
      initializeProductionConfig({
        configPath: paths.configPath,
        dataDirectory: paths.dataDirectory,
        allowedRoots: [paths.allowedRoot],
      }),
    ).toThrow();
  });

  it("fails closed for non-private token permissions", () => {
    if (process.platform === "win32") return;
    const paths = fixture();
    const summary = initializeProductionConfig({
      configPath: paths.configPath,
      dataDirectory: paths.dataDirectory,
      allowedRoots: [paths.allowedRoot],
    });
    chmodSync(summary.tokenFile, 0o644);

    expect(() => loadProductionConfig(paths.configPath)).toThrow(
      "Production bearer-token file permissions must not grant group or other access",
    );
  });

  it("fails closed for non-private configuration and token directories", () => {
    if (process.platform === "win32") return;
    const paths = fixture();
    const summary = initializeProductionConfig({
      configPath: paths.configPath,
      dataDirectory: paths.dataDirectory,
      allowedRoots: [paths.allowedRoot],
    });
    const configDirectory = dirname(paths.configPath);

    chmodSync(configDirectory, 0o755);
    expect(() => loadProductionConfig(paths.configPath)).toThrow(
      "Production configuration directory permissions must not grant group or other access",
    );
    chmodSync(configDirectory, 0o700);

    const tokenDirectory = join(paths.root, "external-token");
    const tokenFile = join(tokenDirectory, "token");
    mkdirSync(tokenDirectory, { mode: 0o755 });
    writeFileSync(tokenFile, `${readFileSync(summary.tokenFile, "utf8")}`, {
      mode: 0o600,
    });
    const config = JSON.parse(readFileSync(paths.configPath, "utf8")) as Record<
      string,
      unknown
    >;
    config.tokenFile = tokenFile;
    writeFileSync(paths.configPath, `${JSON.stringify(config)}\n`, {
      mode: 0o600,
    });

    expect(() => loadProductionConfig(paths.configPath)).toThrow(
      "Production bearer-token directory permissions must not grant group or other access",
    );
  });

  it("rejects relative paths, filesystem-root enrollment, and unknown fields", () => {
    const paths = fixture();
    const tokenFile = join(paths.root, "token");
    writeFileSync(tokenFile, `${"a".repeat(48)}\n`, { mode: 0o600 });
    const unsafe = {
      version: 1,
      profile: "production",
      databasePath: "relative.db",
      tokenFile,
      allowedRoots: [paths.allowedRoot],
      surprise: true,
    };
    writeFileSync(paths.configPath, `${JSON.stringify(unsafe)}\n`, {
      mode: 0o600,
    });
    expect(() => loadProductionConfig(paths.configPath)).toThrow(
      "unsupported fields: surprise",
    );

    delete (unsafe as Record<string, unknown>).surprise;
    writeFileSync(paths.configPath, `${JSON.stringify(unsafe)}\n`, {
      mode: 0o600,
    });
    expect(() => loadProductionConfig(paths.configPath)).toThrow(
      "databasePath must be an absolute path",
    );

    unsafe.databasePath = join(paths.dataDirectory, "coordination.db");
    unsafe.allowedRoots = [process.platform === "win32" ? "C:\\" : "/"];
    writeFileSync(paths.configPath, `${JSON.stringify(unsafe)}\n`, {
      mode: 0o600,
    });
    expect(() => loadProductionConfig(paths.configPath)).toThrow(
      "allowedRoots may not contain a filesystem root",
    );
  });

  it("rejects aliases and non-loopback production hosts", () => {
    const paths = fixture();
    const summary = initializeProductionConfig({
      configPath: paths.configPath,
      dataDirectory: paths.dataDirectory,
      allowedRoots: [paths.allowedRoot],
    });
    const config = JSON.parse(readFileSync(paths.configPath, "utf8")) as Record<
      string,
      unknown
    >;
    config.host = "localhost";
    writeFileSync(paths.configPath, `${JSON.stringify(config)}\n`, {
      mode: 0o600,
    });

    expect(() => loadProductionConfig(paths.configPath)).toThrow(
      "Production host must be a numeric loopback address",
    );
    expect(summary.host).toBe("127.0.0.1");
  });
});
