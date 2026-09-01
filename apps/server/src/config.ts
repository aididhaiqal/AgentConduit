import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  resolve,
} from "node:path";

export const PRODUCTION_CONFIG_VERSION = 1 as const;
export const DEFAULT_HTTP_LIMITS = {
  bodyLimitBytes: 256 * 1024,
  maxConcurrentRequests: 16,
  maxConnections: 64,
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 600,
  requestTimeoutMs: 30_000,
  shutdownTimeoutMs: 15_000,
} as const;

const MAX_CONFIG_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,512}$/;

export interface ProductionHttpConfig {
  bodyLimitBytes: number;
  maxConcurrentRequests: number;
  maxConnections: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export interface ProductionRuntimeConfig {
  version: typeof PRODUCTION_CONFIG_VERSION;
  profile: "production";
  configPath: string;
  databasePath: string;
  tokenFile: string;
  /** Kept in memory only; never include this object in logs or JSON output. */
  token: string;
  allowedRoots: string[];
  host: "127.0.0.1" | "::1";
  port: number;
  heartbeatTimeoutMs: number;
  http: ProductionHttpConfig;
}

export interface ProductionConfigSummary {
  version: typeof PRODUCTION_CONFIG_VERSION;
  profile: "production";
  configPath: string;
  databasePath: string;
  tokenFile: string;
  allowedRoots: string[];
  host: "127.0.0.1" | "::1";
  port: number;
  heartbeatTimeoutMs: number;
  http: ProductionHttpConfig;
}

export interface InitializeProductionConfigOptions {
  configPath: string;
  dataDirectory: string;
  allowedRoots: readonly string[];
  host?: "127.0.0.1" | "::1";
  port?: number;
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

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwned(path: string, label: string): void {
  if (process.platform === "win32") return;
  const uid = currentUid();
  const stats = statSync(path);
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(
      `${label} must be owned by the current operating-system user`,
    );
  }
}

function assertPrivateFile(path: string, label: string): void {
  const linkStats = lstatSync(path);
  if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
    throw new Error(`${label} must be a regular file and may not be a symlink`);
  }
  assertOwned(path, label);
  if (process.platform !== "win32" && (linkStats.mode & 0o077) !== 0) {
    throw new Error(
      `${label} permissions must not grant group or other access`,
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

function canonicalAllowedRoots(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new Error("allowedRoots must contain 1-128 absolute directories");
  }
  const roots = value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`allowedRoots[${index}] must be an absolute path`);
    }
    const absolute = requireAbsolute(`allowedRoots[${index}]`, entry);
    const canonical = realpathSync(absolute);
    if (!statSync(canonical).isDirectory()) {
      throw new Error(`allowedRoots[${index}] must be a directory`);
    }
    const parsed = parsePath(canonical);
    if (canonical === parsed.root) {
      throw new Error("allowedRoots may not contain a filesystem root");
    }
    return canonical;
  });
  return [...new Set(roots)];
}

function readJsonFile(path: string): unknown {
  assertPrivateFile(path, "Production configuration file");
  const stats = statSync(path);
  if (stats.size < 2 || stats.size > MAX_CONFIG_BYTES) {
    throw new Error(
      `Production configuration file must be 2-${MAX_CONFIG_BYTES} bytes`,
    );
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Production configuration file is not valid JSON");
  }
}

function readToken(path: string): string {
  assertPrivateFile(path, "Production bearer-token file");
  const stats = statSync(path);
  if (stats.size < 32 || stats.size > 1024) {
    throw new Error("Production bearer-token file has an invalid size");
  }
  const token = readFileSync(path, "utf8").trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(
      "Production bearer-token file must contain one 32-512 character opaque token",
    );
  }
  return token;
}

function parseHttp(value: unknown): ProductionHttpConfig {
  const object = value === undefined ? {} : requireObject(value, "http");
  rejectUnknownKeys(
    object,
    [
      "bodyLimitBytes",
      "maxConcurrentRequests",
      "maxConnections",
      "rateLimitWindowMs",
      "rateLimitMaxRequests",
      "requestTimeoutMs",
      "shutdownTimeoutMs",
    ],
    "http",
  );
  return {
    bodyLimitBytes: integer(
      "http.bodyLimitBytes",
      object.bodyLimitBytes,
      DEFAULT_HTTP_LIMITS.bodyLimitBytes,
      16 * 1024,
      1024 * 1024,
    ),
    maxConcurrentRequests: integer(
      "http.maxConcurrentRequests",
      object.maxConcurrentRequests,
      DEFAULT_HTTP_LIMITS.maxConcurrentRequests,
      1,
      256,
    ),
    maxConnections: integer(
      "http.maxConnections",
      object.maxConnections,
      DEFAULT_HTTP_LIMITS.maxConnections,
      1,
      4_096,
    ),
    rateLimitWindowMs: integer(
      "http.rateLimitWindowMs",
      object.rateLimitWindowMs,
      DEFAULT_HTTP_LIMITS.rateLimitWindowMs,
      1_000,
      60 * 60 * 1_000,
    ),
    rateLimitMaxRequests: integer(
      "http.rateLimitMaxRequests",
      object.rateLimitMaxRequests,
      DEFAULT_HTTP_LIMITS.rateLimitMaxRequests,
      1,
      100_000,
    ),
    requestTimeoutMs: integer(
      "http.requestTimeoutMs",
      object.requestTimeoutMs,
      DEFAULT_HTTP_LIMITS.requestTimeoutMs,
      1_000,
      5 * 60 * 1_000,
    ),
    shutdownTimeoutMs: integer(
      "http.shutdownTimeoutMs",
      object.shutdownTimeoutMs,
      DEFAULT_HTTP_LIMITS.shutdownTimeoutMs,
      1_000,
      5 * 60 * 1_000,
    ),
  };
}

/** Load and validate the complete fail-closed production configuration. */
export function loadProductionConfig(
  configuredPath: string,
): ProductionRuntimeConfig {
  const configPath = requireAbsolute(
    "Production configuration path",
    configuredPath,
  );
  assertPrivateDirectory(
    dirname(configPath),
    "Production configuration directory",
  );
  const object = requireObject(
    readJsonFile(configPath),
    "Production configuration",
  );
  rejectUnknownKeys(
    object,
    [
      "version",
      "profile",
      "databasePath",
      "tokenFile",
      "allowedRoots",
      "host",
      "port",
      "heartbeatTimeoutMs",
      "http",
    ],
    "Production configuration",
  );
  if (object.version !== PRODUCTION_CONFIG_VERSION) {
    throw new Error(
      `Production configuration version must be ${PRODUCTION_CONFIG_VERSION}`,
    );
  }
  if (object.profile !== "production") {
    throw new Error('Production configuration profile must be "production"');
  }
  if (typeof object.databasePath !== "string") {
    throw new Error("databasePath must be an absolute path");
  }
  if (typeof object.tokenFile !== "string") {
    throw new Error("tokenFile must be an absolute path");
  }
  const databasePath = requireAbsolute("databasePath", object.databasePath);
  const tokenFile = requireAbsolute("tokenFile", object.tokenFile);
  assertPrivateDirectory(
    dirname(tokenFile),
    "Production bearer-token directory",
  );
  const databaseDirectory = dirname(databasePath);
  assertPrivateDirectory(databaseDirectory, "Production database directory");
  try {
    assertPrivateFile(databasePath, "Production database file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const host = object.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Production host must be a numeric loopback address");
  }
  return {
    version: PRODUCTION_CONFIG_VERSION,
    profile: "production",
    configPath,
    databasePath,
    tokenFile,
    token: readToken(tokenFile),
    allowedRoots: canonicalAllowedRoots(object.allowedRoots),
    host,
    port: integer("port", object.port, 8787, 1, 65_535),
    heartbeatTimeoutMs: integer(
      "heartbeatTimeoutMs",
      object.heartbeatTimeoutMs,
      90_000,
      1_000,
      24 * 60 * 60 * 1_000,
    ),
    http: parseHttp(object.http),
  };
}

export function productionConfigSummary(
  config: ProductionRuntimeConfig,
): ProductionConfigSummary {
  return {
    version: config.version,
    profile: config.profile,
    configPath: config.configPath,
    databasePath: config.databasePath,
    tokenFile: config.tokenFile,
    allowedRoots: [...config.allowedRoots],
    host: config.host,
    port: config.port,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    http: { ...config.http },
  };
}

/**
 * Initialize protected configuration and token files. The database is opened
 * separately so a failed schema initialization cannot leave a partial broker.
 */
export function initializeProductionConfig(
  options: InitializeProductionConfigOptions,
): ProductionConfigSummary {
  const configPath = requireAbsolute(
    "Production configuration path",
    options.configPath,
  );
  const dataDirectory = requireAbsolute(
    "Production data directory",
    options.dataDirectory,
  );
  const allowedRoots = canonicalAllowedRoots([...options.allowedRoots]);
  const configDirectory = dirname(configPath);
  const tokenFile = join(configDirectory, "token");
  const databasePath = join(dataDirectory, "coordination.db");
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Production host must be a numeric loopback address");
  }
  const port = integer("port", options.port, 8787, 1, 65_535);

  for (const [path, label] of [
    [configPath, "Production configuration file"],
    [tokenFile, "Production bearer-token file"],
    [databasePath, "Production database file"],
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
    assertPrivateDirectory(
      configDirectory,
      "Production configuration directory",
    );
    assertPrivateDirectory(dataDirectory, "Production database directory");
  }

  const token = randomBytes(32).toString("base64url");
  const serialized = `${JSON.stringify(
    {
      version: PRODUCTION_CONFIG_VERSION,
      profile: "production",
      databasePath,
      tokenFile,
      allowedRoots,
      host,
      port,
      heartbeatTimeoutMs: 90_000,
      http: { ...DEFAULT_HTTP_LIMITS },
    },
    null,
    2,
  )}\n`;
  let tokenCreated = false;
  try {
    writeFileSync(tokenFile, `${token}\n`, { flag: "wx", mode: 0o600 });
    tokenCreated = true;
    writeFileSync(configPath, serialized, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (tokenCreated) rmSync(tokenFile, { force: true });
    throw error;
  }
  const loaded = loadProductionConfig(configPath);
  return productionConfigSummary(loaded);
}
