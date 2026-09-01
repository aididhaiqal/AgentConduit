import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CoordinationStore } from "@agentconduit/core";

export const HUB_CONFIG_VERSION = 1 as const;
export const DEFAULT_HUB_HTTP_LIMITS = {
  bodyLimitBytes: 256 * 1_024,
  maxConnections: 256,
  requestTimeoutMs: 30_000,
  shutdownTimeoutMs: 15_000,
} as const;

const MAX_CONFIG_BYTES = 64 * 1_024;
const MAX_SECRET_BYTES = 1_024;

export interface HubHttpConfig {
  bodyLimitBytes: number;
  maxConnections: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export type HubTransportConfig =
  | {
      mode: "loopback-proxy";
      host: "127.0.0.1" | "::1";
      port: number;
    }
  | {
      mode: "direct-tls";
      host: string;
      port: number;
      certificateFile: string;
      privateKeyFile: string;
    };

export interface HubRuntimeConfig {
  version: typeof HUB_CONFIG_VERSION;
  profile: "hub-production";
  configPath: string;
  databasePath: string;
  ownerTokenFile: string;
  /** In-memory only. Never serialize or log this field. */
  ownerToken: string;
  publicBaseUrl: string;
  transport: HubTransportConfig;
  http: HubHttpConfig;
}

export interface HubConfigSummary {
  version: typeof HUB_CONFIG_VERSION;
  profile: "hub-production";
  configPath: string;
  databasePath: string;
  ownerTokenFile: string;
  publicBaseUrl: string;
  transport: HubTransportConfig;
  http: HubHttpConfig;
}

export interface InitializeHubConfigOptions {
  configPath: string;
  dataDirectory: string;
  publicBaseUrl: string;
  transport?:
    | { mode: "loopback-proxy"; host?: "127.0.0.1" | "::1"; port?: number }
    | {
        mode: "direct-tls";
        host: string;
        port?: number;
        certificateFile: string;
        privateKeyFile: string;
      };
}

type JsonObject = Record<string, unknown>;

function requireAbsolute(name: string, value: string): string {
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

function requireObject(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as JsonObject;
}

function rejectUnknownKeys(
  value: JsonObject,
  allowed: readonly string[],
  name: string,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(
      `${name} contains unsupported fields: ${extras.join(", ")}`,
    );
  }
}

function integer(
  name: string,
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum}-${maximum}`);
  }
  return result;
}

function assertOwned(path: string, label: string): void {
  if (process.platform === "win32" || typeof process.getuid !== "function")
    return;
  if (statSync(path).uid !== process.getuid()) {
    throw new Error(
      `${label} must be owned by the current operating-system user`,
    );
  }
}

function assertPrivateDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a directory and may not be a symlink`);
  }
  assertOwned(path, label);
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error(
      `${label} permissions must not grant group or other access`,
    );
  }
}

function assertPrivateFile(path: string, label: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file and may not be a symlink`);
  }
  assertOwned(path, label);
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error(
      `${label} permissions must not grant group or other access`,
    );
  }
}

function assertRegularFile(
  path: string,
  label: string,
  maximum: number,
): string {
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size < 1 ||
    stats.size > maximum
  ) {
    throw new Error(
      `${label} must be a bounded regular file and may not be a symlink`,
    );
  }
  return realpathSync(path);
}

function parsePublicBaseUrl(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("publicBaseUrl must be an HTTPS URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("publicBaseUrl must be an HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "publicBaseUrl must contain only an HTTPS scheme and authority",
    );
  }
  return parsed.origin;
}

function parseHttp(value: unknown): HubHttpConfig {
  const object = value === undefined ? {} : requireObject(value, "http");
  rejectUnknownKeys(
    object,
    [
      "bodyLimitBytes",
      "maxConnections",
      "requestTimeoutMs",
      "shutdownTimeoutMs",
    ],
    "http",
  );
  return {
    bodyLimitBytes: integer(
      "http.bodyLimitBytes",
      object.bodyLimitBytes,
      DEFAULT_HUB_HTTP_LIMITS.bodyLimitBytes,
      16 * 1_024,
      1024 * 1_024,
    ),
    maxConnections: integer(
      "http.maxConnections",
      object.maxConnections,
      DEFAULT_HUB_HTTP_LIMITS.maxConnections,
      1,
      4_096,
    ),
    requestTimeoutMs: integer(
      "http.requestTimeoutMs",
      object.requestTimeoutMs,
      DEFAULT_HUB_HTTP_LIMITS.requestTimeoutMs,
      1_000,
      5 * 60 * 1_000,
    ),
    shutdownTimeoutMs: integer(
      "http.shutdownTimeoutMs",
      object.shutdownTimeoutMs,
      DEFAULT_HUB_HTTP_LIMITS.shutdownTimeoutMs,
      1_000,
      5 * 60 * 1_000,
    ),
  };
}

function parseTransport(value: unknown): HubTransportConfig {
  const object = requireObject(value, "transport");
  if (object.mode === "loopback-proxy") {
    rejectUnknownKeys(object, ["mode", "host", "port"], "transport");
    const host = object.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1") {
      throw new Error("loopback-proxy transport host must be numeric loopback");
    }
    return {
      mode: "loopback-proxy",
      host,
      port: integer("transport.port", object.port, 8790, 1, 65_535),
    };
  }
  if (object.mode === "direct-tls") {
    rejectUnknownKeys(
      object,
      ["mode", "host", "port", "certificateFile", "privateKeyFile"],
      "transport",
    );
    if (typeof object.host !== "string" || isIP(object.host) === 0) {
      throw new Error("direct-tls transport host must be a numeric IP address");
    }
    if (typeof object.certificateFile !== "string") {
      throw new Error("transport.certificateFile must be an absolute path");
    }
    if (typeof object.privateKeyFile !== "string") {
      throw new Error("transport.privateKeyFile must be an absolute path");
    }
    const certificateFile = assertRegularFile(
      requireAbsolute("transport.certificateFile", object.certificateFile),
      "Hub TLS certificate file",
      1024 * 1_024,
    );
    const privateKeyFile = requireAbsolute(
      "transport.privateKeyFile",
      object.privateKeyFile,
    );
    assertPrivateFile(privateKeyFile, "Hub TLS private-key file");
    return {
      mode: "direct-tls",
      host: object.host,
      port: integer("transport.port", object.port, 8790, 1, 65_535),
      certificateFile,
      privateKeyFile: realpathSync(privateKeyFile),
    };
  }
  throw new Error('transport.mode must be "loopback-proxy" or "direct-tls"');
}

function readJson(path: string): unknown {
  assertPrivateFile(path, "Hub configuration file");
  const stats = statSync(path);
  if (stats.size < 2 || stats.size > MAX_CONFIG_BYTES) {
    throw new Error("Hub configuration file has an invalid size");
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Hub configuration file is not valid JSON");
  }
}

function readOwnerToken(path: string): string {
  assertPrivateFile(path, "Hub owner-token file");
  const stats = statSync(path);
  if (stats.size < 32 || stats.size > MAX_SECRET_BYTES) {
    throw new Error("Hub owner-token file has an invalid size");
  }
  const token = readFileSync(path, "utf8").trim();
  if (!/^aco_[0-9a-f]{64}$/.test(token)) {
    throw new Error("Hub owner-token file contains an invalid token");
  }
  return token;
}

export function loadHubConfig(configuredPath: string): HubRuntimeConfig {
  const configPath = requireAbsolute("Hub configuration path", configuredPath);
  assertPrivateDirectory(dirname(configPath), "Hub configuration directory");
  const object = requireObject(readJson(configPath), "Hub configuration");
  rejectUnknownKeys(
    object,
    [
      "version",
      "profile",
      "databasePath",
      "ownerTokenFile",
      "publicBaseUrl",
      "transport",
      "http",
    ],
    "Hub configuration",
  );
  if (object.version !== HUB_CONFIG_VERSION) {
    throw new Error(`Hub configuration version must be ${HUB_CONFIG_VERSION}`);
  }
  if (object.profile !== "hub-production") {
    throw new Error('Hub configuration profile must be "hub-production"');
  }
  if (typeof object.databasePath !== "string") {
    throw new Error("databasePath must be an absolute path");
  }
  if (typeof object.ownerTokenFile !== "string") {
    throw new Error("ownerTokenFile must be an absolute path");
  }
  const databasePath = requireAbsolute("databasePath", object.databasePath);
  const ownerTokenFile = requireAbsolute(
    "ownerTokenFile",
    object.ownerTokenFile,
  );
  assertPrivateDirectory(dirname(databasePath), "Hub database directory");
  assertPrivateDirectory(dirname(ownerTokenFile), "Hub owner-token directory");
  try {
    assertPrivateFile(databasePath, "Hub database file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    version: HUB_CONFIG_VERSION,
    profile: "hub-production",
    configPath,
    databasePath,
    ownerTokenFile,
    ownerToken: readOwnerToken(ownerTokenFile),
    publicBaseUrl: parsePublicBaseUrl(object.publicBaseUrl),
    transport: parseTransport(object.transport),
    http: parseHttp(object.http),
  };
}

export function hubConfigSummary(config: HubRuntimeConfig): HubConfigSummary {
  return {
    version: config.version,
    profile: config.profile,
    configPath: config.configPath,
    databasePath: config.databasePath,
    ownerTokenFile: config.ownerTokenFile,
    publicBaseUrl: config.publicBaseUrl,
    transport: { ...config.transport },
    http: { ...config.http },
  };
}

export function initializeHubConfig(
  options: InitializeHubConfigOptions,
): HubConfigSummary {
  const configPath = requireAbsolute(
    "Hub configuration path",
    options.configPath,
  );
  const dataDirectory = requireAbsolute(
    "Hub data directory",
    options.dataDirectory,
  );
  const publicBaseUrl = parsePublicBaseUrl(options.publicBaseUrl);
  const configDirectory = dirname(configPath);
  const ownerTokenFile = join(configDirectory, "owner-token");
  const databasePath = join(dataDirectory, "hub.db");
  const transportInput = options.transport ?? {
    mode: "loopback-proxy" as const,
  };
  const transportObject: Record<string, unknown> =
    transportInput.mode === "loopback-proxy"
      ? {
          mode: "loopback-proxy",
          host: transportInput.host ?? "127.0.0.1",
          port: transportInput.port ?? 8790,
        }
      : {
          mode: "direct-tls",
          host: transportInput.host,
          port: transportInput.port ?? 8790,
          certificateFile: requireAbsolute(
            "transport.certificateFile",
            transportInput.certificateFile,
          ),
          privateKeyFile: requireAbsolute(
            "transport.privateKeyFile",
            transportInput.privateKeyFile,
          ),
        };
  const transport = parseTransport(transportObject);

  for (const [path, label] of [
    [configPath, "Hub configuration file"],
    [ownerTokenFile, "Hub owner-token file"],
    [databasePath, "Hub database file"],
  ] as const) {
    try {
      lstatSync(path);
      throw new Error(`${label} already exists`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    assertPrivateDirectory(configDirectory, "Hub configuration directory");
    assertPrivateDirectory(dataDirectory, "Hub database directory");
  }
  const ownerToken = `aco_${randomBytes(32).toString("hex")}`;
  const serialized = `${JSON.stringify(
    {
      version: HUB_CONFIG_VERSION,
      profile: "hub-production",
      databasePath,
      ownerTokenFile,
      publicBaseUrl,
      transport,
      http: { ...DEFAULT_HUB_HTTP_LIMITS },
    },
    null,
    2,
  )}\n`;
  let tokenCreated = false;
  let configCreated = false;
  try {
    writeFileSync(ownerTokenFile, `${ownerToken}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    tokenCreated = true;
    writeFileSync(configPath, serialized, { flag: "wx", mode: 0o600 });
    configCreated = true;
    const store = new CoordinationStore(databasePath);
    store.close();
    if (process.platform !== "win32") {
      chmodSync(databasePath, 0o600);
      // SQLite honors the process umask, but initialization makes the intended
      // owner-only database contract explicit before returning.
      const mode = statSync(databasePath).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new Error("Hub database file permissions are not private");
      }
    }
  } catch (error) {
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    if (configCreated) rmSync(configPath, { force: true });
    if (tokenCreated) rmSync(ownerTokenFile, { force: true });
    throw error;
  }
  return hubConfigSummary(loadHubConfig(configPath));
}
