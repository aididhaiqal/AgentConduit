import { randomBytes } from "node:crypto";
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
import { dirname, isAbsolute, parse as parsePath, resolve } from "node:path";
import type { DeviceCredential } from "@agentconduit/core";

export const NODE_CONFIG_VERSION = 1 as const;
const MAX_CONFIG_BYTES = 64 * 1_024;

export interface NodeRuntimeConfig {
  version: typeof NODE_CONFIG_VERSION;
  profile: "node-production";
  configPath: string;
  name: string;
  deviceId: string;
  hubUrl: string;
  deviceTokenFile: string;
  /** In-memory only. */
  deviceToken: string;
  localTokenFile: string;
  /** In-memory only. */
  localToken: string;
  eventCursorFile: string;
  allowedRoots: string[];
  pathLabels: Record<string, string>;
  host: "127.0.0.1" | "::1";
  port: number;
  deviceHeartbeatIntervalMs: number;
  hubRequestTimeoutMs: number;
}

export interface NodeConfigSummary {
  version: typeof NODE_CONFIG_VERSION;
  profile: "node-production";
  configPath: string;
  name: string;
  deviceId: string;
  hubUrl: string;
  deviceTokenFile: string;
  localTokenFile: string;
  eventCursorFile: string;
  allowedRoots: string[];
  pathLabels: Record<string, string>;
  host: "127.0.0.1" | "::1";
  port: number;
  deviceHeartbeatIntervalMs: number;
  hubRequestTimeoutMs: number;
}

export interface InitializeNodeConfigOptions {
  configPath: string;
  stateDirectory: string;
  name: string;
  hubUrl: string;
  allowedRoots: readonly string[];
  pathLabels?: Readonly<Record<string, string>>;
  host?: "127.0.0.1" | "::1";
  port?: number;
  deviceHeartbeatIntervalMs?: number;
  hubRequestTimeoutMs?: number;
}

type JsonObject = Record<string, unknown>;

function privateDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a directory and may not be a symlink`);
  }
  if (
    process.platform !== "win32" &&
    ((typeof process.getuid === "function" && stats.uid !== process.getuid()) ||
      (stats.mode & 0o077) !== 0)
  ) {
    throw new Error(`${label} must be owned and private`);
  }
}

function privateFile(path: string, label: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file and may not be a symlink`);
  }
  if (
    process.platform !== "win32" &&
    ((typeof process.getuid === "function" && stats.uid !== process.getuid()) ||
      (stats.mode & 0o077) !== 0)
  ) {
    throw new Error(`${label} must be owned and private`);
  }
}

function absolute(name: string, value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as JsonObject;
}

function rejectUnknown(
  value: JsonObject,
  allowed: readonly string[],
  name: string,
) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(
      `${name} contains unsupported fields: ${extras.join(", ")}`,
    );
  }
}

function text(name: string, value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must be 1-${maximum} characters`);
  }
  return normalized;
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

function httpsOrigin(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("hubUrl must be an HTTPS origin");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("hubUrl must be an HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("hubUrl must contain only an HTTPS scheme and authority");
  }
  return parsed.origin;
}

function roots(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new Error("allowedRoots must contain 1-128 directories");
  }
  const canonical = value.map((entry, index) => {
    const path = absolute(`allowedRoots[${index}]`, entry);
    const real = realpathSync(path);
    if (!statSync(real).isDirectory() || real === parsePath(real).root) {
      throw new Error(`allowedRoots[${index}] must be a non-root directory`);
    }
    return real;
  });
  return [...new Set(canonical)];
}

function labels(
  value: unknown,
  allowedRoots: readonly string[],
): Record<string, string> {
  if (value === undefined) return {};
  const parsed = object(value, "pathLabels");
  const result: Record<string, string> = {};
  for (const [path, label] of Object.entries(parsed)) {
    const canonical = realpathSync(absolute("pathLabels key", path));
    if (!allowedRoots.includes(canonical)) {
      throw new Error("pathLabels keys must be canonical allowed roots");
    }
    result[canonical] = text(`pathLabels.${path}`, label, 128);
  }
  return result;
}

function readSecret(path: string, pattern: RegExp, label: string): string {
  privateFile(path, label);
  const stats = statSync(path);
  if (stats.size < 32 || stats.size > 1_024)
    throw new Error(`${label} has an invalid size`);
  const value = readFileSync(path, "utf8").trim();
  if (!pattern.test(value))
    throw new Error(`${label} contains an invalid token`);
  return value;
}

function mustNotExist(path: string, label: string): void {
  try {
    lstatSync(path);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Validate local destinations before consuming a one-time remote enrollment. */
export function preflightNodeConfigInitialization(
  options: InitializeNodeConfigOptions,
): void {
  const configPath = absolute("Node configuration path", options.configPath);
  const stateDirectory = absolute(
    "Node state directory",
    options.stateDirectory,
  );
  const configDirectory = dirname(configPath);
  const allowedRoots = roots([...options.allowedRoots]);
  labels(options.pathLabels ?? {}, allowedRoots);
  text("name", options.name, 128);
  httpsOrigin(options.hubUrl);
  if (
    options.host !== undefined &&
    options.host !== "127.0.0.1" &&
    options.host !== "::1"
  ) {
    throw new Error("Node host must be a numeric loopback address");
  }
  integer("port", options.port, 8788, 1, 65_535);
  integer(
    "deviceHeartbeatIntervalMs",
    options.deviceHeartbeatIntervalMs,
    30_000,
    5_000,
    5 * 60 * 1_000,
  );
  integer(
    "hubRequestTimeoutMs",
    options.hubRequestTimeoutMs,
    30_000,
    1_000,
    5 * 60 * 1_000,
  );
  try {
    privateDirectory(configDirectory, "Node configuration directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    privateDirectory(stateDirectory, "Node state directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const [path, label] of [
    [configPath, "Node configuration file"],
    [resolve(configDirectory, "device-token"), "Node device-token file"],
    [resolve(configDirectory, "local-token"), "Node local-token file"],
    [resolve(stateDirectory, "event-cursor"), "Node event-cursor file"],
  ] as const) {
    mustNotExist(path, label);
  }
}

export function loadNodeConfig(configuredPath: string): NodeRuntimeConfig {
  const configPath = absolute("Node configuration path", configuredPath);
  privateDirectory(dirname(configPath), "Node configuration directory");
  privateFile(configPath, "Node configuration file");
  const stats = statSync(configPath);
  if (stats.size < 2 || stats.size > MAX_CONFIG_BYTES) {
    throw new Error("Node configuration file has an invalid size");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch {
    throw new Error("Node configuration file is not valid JSON");
  }
  const config = object(raw, "Node configuration");
  rejectUnknown(
    config,
    [
      "version",
      "profile",
      "name",
      "deviceId",
      "hubUrl",
      "deviceTokenFile",
      "localTokenFile",
      "eventCursorFile",
      "allowedRoots",
      "pathLabels",
      "host",
      "port",
      "deviceHeartbeatIntervalMs",
      "hubRequestTimeoutMs",
    ],
    "Node configuration",
  );
  if (config.version !== NODE_CONFIG_VERSION) {
    throw new Error(
      `Node configuration version must be ${NODE_CONFIG_VERSION}`,
    );
  }
  if (config.profile !== "node-production") {
    throw new Error('Node configuration profile must be "node-production"');
  }
  const deviceId = text("deviceId", config.deviceId, 64);
  if (!/^dev_[0-9a-f]{32}$/.test(deviceId))
    throw new Error("deviceId is invalid");
  const deviceTokenFile = absolute("deviceTokenFile", config.deviceTokenFile);
  const localTokenFile = absolute("localTokenFile", config.localTokenFile);
  const eventCursorFile = absolute("eventCursorFile", config.eventCursorFile);
  privateDirectory(dirname(deviceTokenFile), "Node device-token directory");
  privateDirectory(dirname(localTokenFile), "Node local-token directory");
  privateDirectory(dirname(eventCursorFile), "Node cursor directory");
  const allowedRoots = roots(config.allowedRoots);
  const host = config.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Node host must be a numeric loopback address");
  }
  return {
    version: NODE_CONFIG_VERSION,
    profile: "node-production",
    configPath,
    name: text("name", config.name, 128),
    deviceId,
    hubUrl: httpsOrigin(config.hubUrl),
    deviceTokenFile,
    deviceToken: readSecret(
      deviceTokenFile,
      /^acd_[0-9a-f]{64}$/,
      "Node device-token file",
    ),
    localTokenFile,
    localToken: readSecret(
      localTokenFile,
      /^acn_[0-9a-f]{64}$/,
      "Node local-token file",
    ),
    eventCursorFile,
    allowedRoots,
    pathLabels: labels(config.pathLabels, allowedRoots),
    host,
    port: integer("port", config.port, 8788, 1, 65_535),
    deviceHeartbeatIntervalMs: integer(
      "deviceHeartbeatIntervalMs",
      config.deviceHeartbeatIntervalMs,
      30_000,
      5_000,
      5 * 60 * 1_000,
    ),
    hubRequestTimeoutMs: integer(
      "hubRequestTimeoutMs",
      config.hubRequestTimeoutMs,
      30_000,
      1_000,
      5 * 60 * 1_000,
    ),
  };
}

export function nodeConfigSummary(
  config: NodeRuntimeConfig,
): NodeConfigSummary {
  const {
    deviceToken: _deviceToken,
    localToken: _localToken,
    ...summary
  } = config;
  return {
    ...summary,
    allowedRoots: [...summary.allowedRoots],
    pathLabels: { ...summary.pathLabels },
  };
}

export function initializeNodeConfigFromCredential(
  options: InitializeNodeConfigOptions,
  credential: DeviceCredential,
): NodeConfigSummary {
  preflightNodeConfigInitialization(options);
  if (!/^dev_[0-9a-f]{32}$/.test(credential.deviceId)) {
    throw new Error("Enrolled deviceId is invalid");
  }
  if (!/^acd_[0-9a-f]{64}$/.test(credential.deviceToken)) {
    throw new Error("Enrolled device token is invalid");
  }
  const configPath = absolute("Node configuration path", options.configPath);
  const stateDirectory = absolute(
    "Node state directory",
    options.stateDirectory,
  );
  const configDirectory = dirname(configPath);
  const deviceTokenFile = resolve(configDirectory, "device-token");
  const localTokenFile = resolve(configDirectory, "local-token");
  const eventCursorFile = resolve(stateDirectory, "event-cursor");
  const allowedRoots = roots([...options.allowedRoots]);
  const pathLabels = labels(options.pathLabels ?? {}, allowedRoots);
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Node host must be a numeric loopback address");
  }
  const serialized = `${JSON.stringify(
    {
      version: NODE_CONFIG_VERSION,
      profile: "node-production",
      name: text("name", options.name, 128),
      deviceId: credential.deviceId,
      hubUrl: httpsOrigin(options.hubUrl),
      deviceTokenFile,
      localTokenFile,
      eventCursorFile,
      allowedRoots,
      pathLabels,
      host,
      port: integer("port", options.port, 8788, 1, 65_535),
      deviceHeartbeatIntervalMs: integer(
        "deviceHeartbeatIntervalMs",
        options.deviceHeartbeatIntervalMs,
        30_000,
        5_000,
        5 * 60 * 1_000,
      ),
      hubRequestTimeoutMs: integer(
        "hubRequestTimeoutMs",
        options.hubRequestTimeoutMs,
        30_000,
        1_000,
        5 * 60 * 1_000,
      ),
    },
    null,
    2,
  )}\n`;
  for (const [path, label] of [
    [configPath, "Node configuration file"],
    [deviceTokenFile, "Node device-token file"],
    [localTokenFile, "Node local-token file"],
    [eventCursorFile, "Node event-cursor file"],
  ] as const) {
    mustNotExist(path, label);
  }
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    privateDirectory(configDirectory, "Node configuration directory");
    privateDirectory(stateDirectory, "Node state directory");
  }
  const localToken = `acn_${randomBytes(32).toString("hex")}`;
  const created: string[] = [];
  try {
    for (const [path, value] of [
      [deviceTokenFile, `${credential.deviceToken}\n`],
      [localTokenFile, `${localToken}\n`],
      [eventCursorFile, "0\n"],
      [configPath, serialized],
    ] as const) {
      writeFileSync(path, value, { flag: "wx", mode: 0o600 });
      if (process.platform !== "win32") chmodSync(path, 0o600);
      created.push(path);
    }
  } catch (error) {
    for (const path of created.reverse()) rmSync(path, { force: true });
    throw error;
  }
  return nodeConfigSummary(loadNodeConfig(configPath));
}

export function readEnrollmentCode(path: string): string {
  const absolutePath = absolute("Enrollment code file", path);
  return readSecret(absolutePath, /^ace_[0-9a-f]{48}$/, "Enrollment code file");
}
