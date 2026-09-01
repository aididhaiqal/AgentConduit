#!/usr/bin/env node
import { isAbsolute } from "node:path";
import {
  CoordinationStore,
  migrateCoordinationDatabase,
  preflightCoordinationMigration,
} from "@agentconduit/core";
import {
  hubConfigSummary,
  initializeHubConfig,
  loadHubConfig,
} from "./config.js";
import { createJsonHubLogger } from "./logging.js";
import { startHubRuntime } from "./runtime.js";
import { HubService } from "./service.js";

export type HubCommand =
  "init" | "serve" | "doctor" | "backup" | "migrate" | "enroll-device" | "help";

export interface HubCliOptions {
  command: HubCommand;
  configPath?: string;
  dataDirectory?: string;
  publicBaseUrl?: string;
  destination?: string;
  backupPath?: string;
  directTls: boolean;
  host?: string;
  port?: number;
  certificateFile?: string;
  privateKeyFile?: string;
  nameHint?: string;
  apply: boolean;
}

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

function portValue(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("--port must be an integer from 1-65535");
  }
  return parsed;
}

function absolute(name: string, value: string | undefined): string {
  if (!value || !isAbsolute(value))
    throw new Error(`${name} must be an absolute path`);
  return value;
}

export function parseHubCliArgs(argv: readonly string[]): HubCliOptions {
  const commandValue = argv[0] ?? "help";
  if (commandValue === "--help" || commandValue === "-h") {
    return { command: "help", directTls: false, apply: false };
  }
  if (
    ![
      "init",
      "serve",
      "doctor",
      "backup",
      "migrate",
      "enroll-device",
      "help",
    ].includes(commandValue)
  ) {
    throw new Error(`unknown command: ${commandValue}`);
  }
  const command = commandValue as HubCommand;
  let configPath: string | undefined;
  let dataDirectory: string | undefined;
  let publicBaseUrl: string | undefined;
  let destination: string | undefined;
  let backupPath: string | undefined;
  let directTls = false;
  let host: string | undefined;
  let port: number | undefined;
  let certificateFile: string | undefined;
  let privateKeyFile: string | undefined;
  let nameHint: string | undefined;
  let apply = false;
  const providedFlags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--help" && flag !== "-h") {
      if (providedFlags.has(flag!)) {
        throw new Error(`${flag} may be specified only once`);
      }
      providedFlags.add(flag!);
    }
    switch (flag) {
      case "--config":
        configPath = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--data-dir":
        dataDirectory = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--public-base-url":
        publicBaseUrl = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--destination":
        destination = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--backup":
        backupPath = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--direct-tls":
        directTls = true;
        break;
      case "--host":
        host = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--port":
        port = portValue(valueAfter(argv, index, flag));
        index += 1;
        break;
      case "--tls-cert":
        certificateFile = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--tls-key":
        privateKeyFile = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--name":
        nameHint = valueAfter(argv, index, flag).trim();
        if (!nameHint || nameHint.length > 128) {
          throw new Error("--name must be 1-128 characters");
        }
        index += 1;
        break;
      case "--apply":
        apply = true;
        break;
      case "--help":
      case "-h":
        return { command: "help", directTls: false, apply: false };
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (command === "help") return { command, directTls, apply };
  const allowedByCommand: Record<Exclude<HubCommand, "help">, Set<string>> = {
    init: new Set([
      "--config",
      "--data-dir",
      "--public-base-url",
      "--direct-tls",
      "--host",
      "--port",
      "--tls-cert",
      "--tls-key",
    ]),
    serve: new Set(["--config"]),
    doctor: new Set(["--config"]),
    backup: new Set(["--config", "--destination"]),
    migrate: new Set(["--config", "--apply", "--backup"]),
    "enroll-device": new Set(["--config", "--name"]),
  };
  const unsupported = [...providedFlags].find(
    (flag) => !allowedByCommand[command].has(flag),
  );
  if (unsupported) throw new Error(`${command} does not accept ${unsupported}`);
  configPath = absolute("--config", configPath);
  if (command === "init") {
    dataDirectory = absolute("--data-dir", dataDirectory);
    if (!publicBaseUrl) throw new Error("init requires --public-base-url");
    if (directTls) {
      certificateFile = absolute("--tls-cert", certificateFile);
      privateKeyFile = absolute("--tls-key", privateKeyFile);
      if (!host) throw new Error("direct TLS initialization requires --host");
    } else if (host && host !== "127.0.0.1" && host !== "::1") {
      throw new Error("loopback-proxy --host must be 127.0.0.1 or ::1");
    }
  }
  if (command === "backup")
    destination = absolute("--destination", destination);
  if (command === "migrate") {
    if (!apply && backupPath) {
      throw new Error("--backup is valid only with migrate --apply");
    }
    if (apply) backupPath = absolute("--backup", backupPath);
  }
  if (command === "enroll-device" && !nameHint) {
    throw new Error("enroll-device requires --name");
  }
  return {
    command,
    configPath,
    ...(dataDirectory ? { dataDirectory } : {}),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(destination ? { destination } : {}),
    ...(backupPath ? { backupPath } : {}),
    directTls,
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(certificateFile ? { certificateFile } : {}),
    ...(privateKeyFile ? { privateKeyFile } : {}),
    ...(nameHint ? { nameHint } : {}),
    apply,
  };
}

function usage(): string {
  return [
    "Usage:",
    "  agentconduit-hub init --config <absolute-path> --data-dir <absolute-path> --public-base-url <https-origin> [--port <n>]",
    "  agentconduit-hub init ... --direct-tls --host <numeric-ip> --tls-cert <absolute-path> --tls-key <absolute-path>",
    "  agentconduit-hub serve --config <absolute-path>",
    "  agentconduit-hub doctor --config <absolute-path>",
    "  agentconduit-hub enroll-device --config <absolute-path> --name <device-name>",
    "  agentconduit-hub backup --config <absolute-path> --destination <absolute-path>",
    "  agentconduit-hub migrate --config <absolute-path>",
    "  agentconduit-hub migrate --config <absolute-path> --apply --backup <absolute-path>",
    "",
    "The default production topology binds numeric loopback for an HTTPS reverse proxy. Owner and device secrets are read from protected files and are never printed.",
  ].join("\n");
}

async function run(options: HubCliOptions): Promise<void> {
  if (options.command === "help") {
    console.log(usage());
    return;
  }
  if (process.platform !== "win32") process.umask(0o077);
  if (options.command === "init") {
    const transport = options.directTls
      ? {
          mode: "direct-tls" as const,
          host: options.host!,
          ...(options.port !== undefined ? { port: options.port } : {}),
          certificateFile: options.certificateFile!,
          privateKeyFile: options.privateKeyFile!,
        }
      : {
          mode: "loopback-proxy" as const,
          ...(options.host === "::1" ? { host: "::1" as const } : {}),
          ...(options.port !== undefined ? { port: options.port } : {}),
        };
    console.log(
      JSON.stringify(
        initializeHubConfig({
          configPath: options.configPath!,
          dataDirectory: options.dataDirectory!,
          publicBaseUrl: options.publicBaseUrl!,
          transport,
        }),
        null,
        2,
      ),
    );
    return;
  }
  const config = loadHubConfig(options.configPath!);
  if (options.command === "migrate") {
    if (!options.apply) {
      console.log(
        JSON.stringify(
          {
            command: "migrate",
            mode: "preview",
            ...preflightCoordinationMigration(config.databasePath),
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(
      JSON.stringify(
        {
          command: "migrate",
          mode: "applied",
          ...(await migrateCoordinationDatabase(
            config.databasePath,
            options.backupPath!,
          )),
        },
        null,
        2,
      ),
    );
    return;
  }
  const store = new CoordinationStore(config.databasePath, {
    migrations: "require-current",
  });
  if (options.command === "doctor") {
    try {
      console.log(
        JSON.stringify(
          { config: hubConfigSummary(config), database: store.healthCheck() },
          null,
          2,
        ),
      );
    } finally {
      store.close();
    }
    return;
  }
  if (options.command === "enroll-device") {
    try {
      console.log(
        JSON.stringify(
          {
            command: "enroll-device",
            status: "created",
            enrollment: new HubService(store).createEnrollment(
              options.nameHint,
            ),
          },
          null,
          2,
        ),
      );
    } finally {
      store.close();
    }
    return;
  }
  if (options.command === "backup") {
    try {
      console.log(
        JSON.stringify(await store.backupTo(options.destination!), null, 2),
      );
    } finally {
      store.close();
    }
    return;
  }
  if (options.command !== "serve") {
    store.close();
    throw new Error(`Unsupported command: ${options.command}`);
  }
  // Verify the schema again before constructing the listener-owning runtime.
  preflightCoordinationMigration(config.databasePath);
  const runtime = await startHubRuntime({
    service: new HubService(store),
    config,
    logger: createJsonHubLogger(),
  });
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    void runtime.close(reason);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  await new Promise<void>((resolve) => runtime.listener.once("close", resolve));
}

const direct =
  process.argv[1]?.endsWith("/main.js") ||
  process.argv[1]?.endsWith("\\main.js") ||
  process.argv[1]?.endsWith("/main.ts") ||
  process.argv[1]?.endsWith("\\main.ts");

if (direct) {
  run(parseHubCliArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
