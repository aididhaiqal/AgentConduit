#!/usr/bin/env node
import { arch, platform } from "node:os";
import { isAbsolute } from "node:path";
import {
  createJsonLogger,
  safeErrorMessage,
  type StructuredLogger,
} from "@agentconduit/server";
import { HubClient, enrollWithHub } from "./client.js";
import {
  initializeNodeConfigFromCredential,
  loadNodeConfig,
  nodeConfigSummary,
  preflightNodeConfigInitialization,
  readEnrollmentCode,
} from "./config.js";
import { observeDeviceHealth } from "./health.js";
import {
  NODE_CAPABILITIES,
  NODE_VERSION,
  runNodeStdio,
  startNodeRuntime,
  type NodeRuntime,
} from "./runtime.js";

export type NodeCommand = "enroll" | "serve" | "stdio" | "doctor" | "help";

export interface NodeCliOptions {
  command: NodeCommand;
  configPath?: string;
  stateDirectory?: string;
  hubUrl?: string;
  enrollmentCodeFile?: string;
  name?: string;
  allowedRoots: string[];
  pathLabels: Record<string, string>;
  host?: "127.0.0.1" | "::1";
  port?: number;
  deviceHeartbeatIntervalMs?: number;
  hubRequestTimeoutMs?: number;
}

export interface NodeCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface NodeCliDependencies {
  enroll: typeof enrollWithHub;
  client(config: ReturnType<typeof loadNodeConfig>): HubClient;
  logger(secrets: readonly string[]): StructuredLogger;
  startRuntime: typeof startNodeRuntime;
  runStdio: typeof runNodeStdio;
  waitForTermination(): Promise<"SIGINT" | "SIGTERM">;
}

const processIo: NodeCliIo = {
  stdout: (value) => process.stdout.write(`${value}\n`),
  stderr: (value) => process.stderr.write(`${value}\n`),
};

function waitForTermination(): Promise<"SIGINT" | "SIGTERM"> {
  return new Promise((resolve) => {
    const stop = (signal: "SIGINT" | "SIGTERM") => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve(signal);
    };
    const onSigint = () => stop("SIGINT");
    const onSigterm = () => stop("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

const defaultDependencies: NodeCliDependencies = {
  enroll: enrollWithHub,
  client: (config) =>
    new HubClient({
      baseUrl: config.hubUrl,
      deviceToken: config.deviceToken,
      requestTimeoutMs: config.hubRequestTimeoutMs,
    }),
  logger: (secrets) => createJsonLogger({ secrets }),
  startRuntime: startNodeRuntime,
  runStdio: runNodeStdio,
  waitForTermination,
};

function valueAfter(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}

function absolute(name: string, value: string | undefined): string {
  if (!value || !isAbsolute(value))
    throw new Error(`${name} must be an absolute path`);
  return value;
}

function integer(
  flag: string,
  value: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${flag} must be an integer from ${minimum}-${maximum}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be an integer from ${minimum}-${maximum}`);
  }
  return parsed;
}

function pathLabel(value: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("--path-label must use <absolute-root>=<display-label>");
  }
  const root = absolute("--path-label root", value.slice(0, separator));
  const label = value.slice(separator + 1).trim();
  if (!label || label.length > 128) {
    throw new Error("--path-label display label must be 1-128 characters");
  }
  return [root, label];
}

export function parseNodeCliArgs(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): NodeCliOptions {
  const commandValue = argv[0] ?? "help";
  if (commandValue === "--help" || commandValue === "-h") {
    return { command: "help", allowedRoots: [], pathLabels: {} };
  }
  if (!["enroll", "serve", "stdio", "doctor", "help"].includes(commandValue)) {
    throw new Error(`unknown command: ${commandValue}`);
  }
  const command = commandValue as NodeCommand;
  let configPath = environment.AGENTCONDUIT_NODE_CONFIG;
  let stateDirectory: string | undefined;
  let hubUrl: string | undefined;
  let enrollmentCodeFile: string | undefined;
  let name: string | undefined;
  const allowedRoots: string[] = [];
  const pathLabels: Record<string, string> = {};
  let host: "127.0.0.1" | "::1" | undefined;
  let port: number | undefined;
  let deviceHeartbeatIntervalMs: number | undefined;
  let hubRequestTimeoutMs: number | undefined;
  const seen = new Set<string>();

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--help" || flag === "-h") {
      return { command: "help", allowedRoots: [], pathLabels: {} };
    }
    if (flag !== "--allowed-root" && flag !== "--path-label") {
      if (seen.has(flag)) throw new Error(`${flag} may be specified only once`);
      seen.add(flag);
    }
    switch (flag) {
      case "--config":
        configPath = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--state-dir":
        stateDirectory = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--hub":
        hubUrl = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--enrollment-code-file":
        enrollmentCodeFile = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--name":
        name = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--allowed-root":
        allowedRoots.push(absolute(flag, valueAfter(argv, index, flag)));
        index += 1;
        break;
      case "--path-label": {
        const [root, label] = pathLabel(valueAfter(argv, index, flag));
        if (pathLabels[root])
          throw new Error(`duplicate --path-label root: ${root}`);
        pathLabels[root] = label;
        index += 1;
        break;
      }
      case "--host": {
        const value = valueAfter(argv, index, flag);
        if (value !== "127.0.0.1" && value !== "::1") {
          throw new Error("--host must be 127.0.0.1 or ::1");
        }
        host = value;
        index += 1;
        break;
      }
      case "--port":
        port = integer(flag, valueAfter(argv, index, flag), 1, 65_535);
        index += 1;
        break;
      case "--heartbeat-ms":
        deviceHeartbeatIntervalMs = integer(
          flag,
          valueAfter(argv, index, flag),
          5_000,
          5 * 60 * 1_000,
        );
        index += 1;
        break;
      case "--request-timeout-ms":
        hubRequestTimeoutMs = integer(
          flag,
          valueAfter(argv, index, flag),
          1_000,
          5 * 60 * 1_000,
        );
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }

  if (command === "help") {
    return { command, allowedRoots: [], pathLabels: {} };
  }
  configPath = absolute("--config", configPath);
  if (command !== "enroll") {
    const enrollmentOnly = [
      stateDirectory,
      hubUrl,
      enrollmentCodeFile,
      name,
      allowedRoots.length > 0,
      Object.keys(pathLabels).length > 0,
      host,
      port,
      deviceHeartbeatIntervalMs,
      hubRequestTimeoutMs,
    ];
    if (enrollmentOnly.some(Boolean)) {
      throw new Error(`${command} accepts only --config`);
    }
    return { command, configPath, allowedRoots: [], pathLabels: {} };
  }
  stateDirectory = absolute("--state-dir", stateDirectory);
  enrollmentCodeFile = absolute("--enrollment-code-file", enrollmentCodeFile);
  if (!hubUrl) throw new Error("enroll requires --hub");
  if (!name) throw new Error("enroll requires --name");
  if (allowedRoots.length === 0) {
    throw new Error("enroll requires at least one --allowed-root");
  }
  return {
    command,
    configPath,
    stateDirectory,
    hubUrl,
    enrollmentCodeFile,
    name,
    allowedRoots,
    pathLabels,
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(deviceHeartbeatIntervalMs !== undefined
      ? { deviceHeartbeatIntervalMs }
      : {}),
    ...(hubRequestTimeoutMs !== undefined ? { hubRequestTimeoutMs } : {}),
  };
}

export function nodeUsage(): string {
  return [
    "Usage:",
    "  agentconduit-node enroll --config <absolute-path> --state-dir <absolute-path> --hub <https-origin> --enrollment-code-file <absolute-path> --name <device-name> --allowed-root <absolute-path> [...]",
    "    [--path-label <absolute-root>=<display-label>] [--host <numeric-loopback>] [--port <n>]",
    "  agentconduit-node serve --config <absolute-path>",
    "  agentconduit-node stdio --config <absolute-path>",
    "  agentconduit-node doctor --config <absolute-path>",
    "",
    "Enrollment and Hub traffic require HTTPS. The local MCP listener is authenticated and numeric-loopback-only. Tokens are stored in protected files and are never printed.",
  ].join("\n");
}

export async function runNodeCli(
  options: NodeCliOptions,
  io: NodeCliIo = processIo,
  dependencies: NodeCliDependencies = defaultDependencies,
): Promise<number> {
  if (options.command === "help") {
    io.stdout(nodeUsage());
    return 0;
  }
  if (process.platform !== "win32") process.umask(0o077);
  if (options.command === "enroll") {
    const initialization = {
      configPath: options.configPath!,
      stateDirectory: options.stateDirectory!,
      name: options.name!,
      hubUrl: options.hubUrl!,
      allowedRoots: options.allowedRoots,
      pathLabels: options.pathLabels,
      ...(options.host ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.deviceHeartbeatIntervalMs !== undefined
        ? { deviceHeartbeatIntervalMs: options.deviceHeartbeatIntervalMs }
        : {}),
      ...(options.hubRequestTimeoutMs !== undefined
        ? { hubRequestTimeoutMs: options.hubRequestTimeoutMs }
        : {}),
    };
    preflightNodeConfigInitialization(initialization);
    const credential = await dependencies.enroll(options.hubUrl!, {
      enrollmentCode: readEnrollmentCode(options.enrollmentCodeFile!),
      name: options.name!,
      platform: platform(),
      architecture: arch(),
      nodeVersion: NODE_VERSION,
      capabilities: [...NODE_CAPABILITIES],
      health: observeDeviceHealth(),
    });
    const config = initializeNodeConfigFromCredential(
      initialization,
      credential,
    );
    io.stdout(
      JSON.stringify(
        { command: "enroll", status: "enrolled", config },
        null,
        2,
      ),
    );
    return 0;
  }

  const config = loadNodeConfig(options.configPath!);
  const client = dependencies.client(config);
  const logger = dependencies.logger([config.deviceToken, config.localToken]);
  if (options.command === "doctor") {
    const device = await client.rpc("device.heartbeat", {
      nodeVersion: NODE_VERSION,
      capabilities: [...NODE_CAPABILITIES],
      health: observeDeviceHealth(),
    });
    if (device.deviceId !== config.deviceId) {
      throw new Error(
        "Hub device identity does not match the Node configuration",
      );
    }
    const safeDevice = {
      deviceId: device.deviceId,
      name: device.name,
      platform: device.platform,
      architecture: device.architecture,
      nodeVersion: device.nodeVersion,
      capabilities: [...device.capabilities],
      health: { ...device.health },
      status: device.status,
      enrolledAt: device.enrolledAt,
      lastSeenAt: device.lastSeenAt,
      ...(device.revokedAt ? { revokedAt: device.revokedAt } : {}),
    };
    io.stdout(
      JSON.stringify(
        {
          command: "doctor",
          status: "ready",
          config: nodeConfigSummary(config),
          device: safeDevice,
          hub: { lastSuccessAt: client.lastSuccessAt },
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (options.command === "stdio") {
    await dependencies.runStdio(config, logger, client);
    return 0;
  }
  if (options.command !== "serve") {
    throw new Error(`Unsupported command: ${options.command}`);
  }
  let runtime: NodeRuntime | undefined;
  try {
    runtime = await dependencies.startRuntime({ config, logger, client });
    const signal = await dependencies.waitForTermination();
    await runtime.close(signal);
  } catch (error) {
    await runtime?.close("startup_error");
    throw error;
  }
  return 0;
}

const direct =
  process.argv[1]?.endsWith("/main.js") ||
  process.argv[1]?.endsWith("\\main.js") ||
  process.argv[1]?.endsWith("/main.ts") ||
  process.argv[1]?.endsWith("\\main.ts");

if (direct) {
  const secrets: string[] = [];
  runNodeCli(parseNodeCliArgs(process.argv.slice(2))).catch(
    (error: unknown) => {
      processIo.stderr(safeErrorMessage(error, secrets));
      process.exitCode = 1;
    },
  );
}
