#!/usr/bin/env node
import { mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { CoordinationService, CoordinationStore } from "@agentconduit/core";
import { initializeProductionConfig, loadProductionConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { createJsonLogger, safeErrorMessage } from "./logging.js";
import {
  backupProduction,
  doctorProduction,
  initializeProductionDatabase,
  maintainProduction,
  migrateProduction,
  openProductionService,
  preflightProductionMigration,
} from "./operations.js";
import { startProductionHttpBroker } from "./runtime.js";
import { runStdio } from "./stdio.js";

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

const processIo: CliIo = {
  stdout: (value) => process.stdout.write(`${value}\n`),
  stderr: (value) => process.stderr.write(`${value}\n`),
};

function envPort(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return parsed;
}

function optionValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    values.push(value);
    index += 1;
  }
  return values;
}

function optionValue(
  argv: readonly string[],
  name: string,
): string | undefined {
  const values = optionValues(argv, name);
  if (values.length > 1) throw new Error(`${name} may be specified only once`);
  return values[0];
}

function assertKnownArguments(
  argv: readonly string[],
  allowedFlags: readonly string[],
  booleanFlags: readonly string[] = ["--stdio"],
): void {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      throw new Error(`Unexpected argument: ${value}`);
    }
    if (!allowedFlags.includes(value)) {
      throw new Error(`Unsupported option: ${value}`);
    }
    if (booleanFlags.includes(value)) continue;
    const option = argv[index + 1];
    if (!option || option.startsWith("--")) {
      throw new Error(`${value} requires a value`);
    }
    index += 1;
  }
}

export function resolveDatabasePath(
  configuredDatabasePath: string | undefined,
  stdio: boolean,
  cwd = process.cwd(),
): string {
  if (stdio) {
    if (!configuredDatabasePath || !isAbsolute(configuredDatabasePath)) {
      throw new Error(
        "--stdio requires an explicit absolute --db path or AGENTCONDUIT_DB so clients share one broker database",
      );
    }
    return configuredDatabasePath;
  }
  return (
    configuredDatabasePath ?? resolve(cwd, ".agentconduit/coordination.db")
  );
}

function printHelp(io: CliIo): void {
  io.stdout(
    `AgentConduit MCP broker\n\n` +
      `Production workstation commands:\n` +
      `  init --config <path> --data-dir <path> --allowed-root <path> [...]\n` +
      `  doctor --config <path>\n` +
      `  backup --config <path> --output <new-path>\n` +
      `  migrate --config <path> [--apply --backup <new-path>]\n` +
      `  maintenance --config <path> --stale-before <ISO> --messages-before <ISO>\n` +
      `    --integrations-before <ISO> --jobs-before <ISO> --audit-before <ISO> [--apply]\n` +
      `  serve --config <path>\n\n` +
      `Development/compatibility:\n` +
      `  serve [--db <path>] [--host <loopback>] [--port <port>] [--token <token>]\n` +
      `  serve --stdio --db <absolute-path> [--allowed-root <path> ...]\n\n` +
      `AGENTCONDUIT_CONFIG may provide the production configuration path.`,
  );
}

function commandAndArguments(argv: readonly string[]): {
  command: "init" | "doctor" | "backup" | "migrate" | "maintenance" | "serve";
  args: string[];
} {
  const first = argv[0];
  if (first && !first.startsWith("--")) {
    if (
      !["init", "doctor", "backup", "migrate", "maintenance", "serve"].includes(
        first,
      )
    ) {
      throw new Error(`Unknown command: ${first}`);
    }
    return {
      command: first as
        "init" | "doctor" | "backup" | "migrate" | "maintenance" | "serve",
      args: argv.slice(1),
    };
  }
  return { command: "serve", args: [...argv] };
}

function productionConfigPath(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return optionValue(args, "--config") ?? environment.AGENTCONDUIT_CONFIG;
}

async function waitForTermination(): Promise<"SIGINT" | "SIGTERM"> {
  return await new Promise((resolve) => {
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

function withPrivateUmask<T>(operation: () => T): T {
  if (process.platform === "win32") return operation();
  const previous = process.umask(0o077);
  try {
    return operation();
  } finally {
    process.umask(previous);
  }
}

async function withPrivateUmaskAsync<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (process.platform === "win32") return await operation();
  const previous = process.umask(0o077);
  try {
    return await operation();
  } finally {
    process.umask(previous);
  }
}

async function runProductionCommand(
  command: "init" | "doctor" | "backup" | "migrate" | "maintenance" | "serve",
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const configPath = productionConfigPath(args, environment);
  if (!configPath) {
    throw new Error(`${command} requires --config or AGENTCONDUIT_CONFIG`);
  }
  if (command === "init") {
    assertKnownArguments(args, ["--config", "--data-dir", "--allowed-root"]);
    const dataDirectory = optionValue(args, "--data-dir");
    if (!dataDirectory) throw new Error("init requires --data-dir");
    const allowedRoots = optionValues(args, "--allowed-root");
    if (allowedRoots.length === 0) {
      throw new Error("init requires at least one --allowed-root");
    }
    const result = withPrivateUmask(() => {
      const summary = initializeProductionConfig({
        configPath,
        dataDirectory,
        allowedRoots,
      });
      const loaded = loadProductionConfig(configPath);
      const database = initializeProductionDatabase(loaded);
      return {
        command: "init",
        status: "initialized",
        config: summary,
        database,
      };
    });
    io.stdout(JSON.stringify(result, null, 2));
    return 0;
  }
  if (command === "doctor") {
    assertKnownArguments(args, ["--config"]);
    const result = doctorProduction(loadProductionConfig(configPath));
    io.stdout(JSON.stringify({ command: "doctor", ...result }, null, 2));
    return 0;
  }
  if (command === "backup") {
    assertKnownArguments(args, ["--config", "--output"]);
    const output = optionValue(args, "--output");
    if (!output) throw new Error("backup requires --output");
    const result = await backupProduction(
      loadProductionConfig(configPath),
      output,
    );
    io.stdout(
      JSON.stringify(
        { command: "backup", status: "verified", ...result },
        null,
        2,
      ),
    );
    return 0;
  }
  if (command === "migrate") {
    assertKnownArguments(
      args,
      ["--config", "--apply", "--backup"],
      ["--apply"],
    );
    if (args.filter((value) => value === "--apply").length > 1) {
      throw new Error("--apply may be specified only once");
    }
    const config = loadProductionConfig(configPath);
    if (!args.includes("--apply")) {
      if (optionValue(args, "--backup")) {
        throw new Error("--backup is valid only with --apply");
      }
      const result = preflightProductionMigration(config);
      io.stdout(
        JSON.stringify(
          { command: "migrate", mode: "preview", ...result },
          null,
          2,
        ),
      );
      return 0;
    }
    const backup = optionValue(args, "--backup");
    if (!backup) throw new Error("migrate --apply requires --backup");
    const result = await migrateProduction(config, backup);
    io.stdout(
      JSON.stringify(
        { command: "migrate", mode: "applied", ...result },
        null,
        2,
      ),
    );
    return 0;
  }
  if (command === "maintenance") {
    assertKnownArguments(
      args,
      [
        "--config",
        "--stale-before",
        "--messages-before",
        "--integrations-before",
        "--jobs-before",
        "--audit-before",
        "--apply",
      ],
      ["--apply"],
    );
    if (args.filter((value) => value === "--apply").length > 1) {
      throw new Error("--apply may be specified only once");
    }
    const staleBefore = optionValue(args, "--stale-before");
    const acknowledgedMessagesBefore = optionValue(args, "--messages-before");
    const terminalIntegrationsBefore = optionValue(
      args,
      "--integrations-before",
    );
    const terminalJobsBefore = optionValue(args, "--jobs-before");
    const auditEventsBefore = optionValue(args, "--audit-before");
    if (
      !staleBefore ||
      !acknowledgedMessagesBefore ||
      !terminalIntegrationsBefore ||
      !terminalJobsBefore ||
      !auditEventsBefore
    ) {
      throw new Error(
        "maintenance requires --stale-before, --messages-before, --integrations-before, --jobs-before, and --audit-before",
      );
    }
    const result = maintainProduction(
      loadProductionConfig(configPath),
      {
        staleBefore,
        acknowledgedMessagesBefore,
        terminalIntegrationsBefore,
        terminalJobsBefore,
        auditEventsBefore,
      },
      { apply: args.includes("--apply") },
    );
    io.stdout(JSON.stringify({ command: "maintenance", ...result }, null, 2));
    return 0;
  }

  assertKnownArguments(args, ["--config", "--stdio"]);
  const config = loadProductionConfig(configPath);
  const service = openProductionService(config);
  if (args.includes("--stdio")) {
    try {
      await runStdio(service);
    } finally {
      service.close();
    }
    return 0;
  }
  const logger = createJsonLogger({ secrets: [config.token] });
  const runtime = await startProductionHttpBroker({ service, config, logger });
  const signal = await waitForTermination();
  await runtime.close(signal);
  return 0;
}

async function runDevelopmentServe(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  assertKnownArguments(args, [
    "--stdio",
    "--db",
    "--host",
    "--port",
    "--token",
    "--allowed-root",
  ]);
  const stdio = args.includes("--stdio");
  const databasePath = resolveDatabasePath(
    optionValue(args, "--db") ?? environment.AGENTCONDUIT_DB,
    stdio,
  );
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const configuredRoots = [
    ...(environment.AGENTCONDUIT_ALLOWED_ROOTS?.split(delimiter).filter(
      Boolean,
    ) ?? []),
    ...optionValues(args, "--allowed-root"),
  ];
  const service = new CoordinationService({
    store: new CoordinationStore(databasePath),
    allowedRoots: configuredRoots,
  });
  if (stdio) {
    try {
      await runStdio(service);
    } finally {
      service.close();
    }
    return 0;
  }
  const host =
    optionValue(args, "--host") ?? environment.AGENTCONDUIT_HOST ?? "127.0.0.1";
  const port = envPort(
    "AGENTCONDUIT_PORT/--port",
    optionValue(args, "--port") ?? environment.AGENTCONDUIT_PORT,
    8787,
  );
  const token = optionValue(args, "--token") ?? environment.AGENTCONDUIT_TOKEN;
  if (token === "") {
    throw new Error(
      "AGENTCONDUIT_TOKEN/--token must be non-empty when configured",
    );
  }
  const logger = createJsonLogger({ secrets: token ? [token] : [] });
  const app = createHttpApp(service, {
    host,
    ...(token !== undefined ? { token } : {}),
    logger,
    readiness: () => service.store.healthCheck(),
  });
  const listener = app.listen(port, host, () => {
    logger.info("broker.started", {
      profile: "development",
      endpoint: `http://${host}:${port}/mcp`,
    });
  });
  const signal = await waitForTermination();
  await new Promise<void>((resolveClose, rejectClose) => {
    listener.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  service.close();
  logger.info("broker.stopped", { signal });
  return 0;
}

export async function runCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  io: CliIo = processIo,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp(io);
    return 0;
  }
  const { command, args } = commandAndArguments(argv);
  if (command !== "serve" || productionConfigPath(args, environment)) {
    return await withPrivateUmaskAsync(() =>
      runProductionCommand(command, args, environment, io),
    );
  }
  return await runDevelopmentServe(args, environment);
}

function isDirectExecution(argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return (
      realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isDirectExecution(process.argv[1])) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      processIo.stderr(safeErrorMessage(error));
      process.exitCode = 1;
    },
  );
}
