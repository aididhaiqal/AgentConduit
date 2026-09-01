#!/usr/bin/env node
import { isAbsolute } from "node:path";
import {
  BridgeSupervisor,
  connectMcpAgentConduitClient,
  type McpBridgeConnectionOptions,
} from "./index.js";

export interface CliOptions {
  url?: string;
  stdioCommand?: string;
  stdioArgs: string[];
  workspace: string;
  runtime: string;
  sessionRef?: string;
  ownershipFile?: string;
  heartbeatMs?: number;
  pollMs?: number;
  once: boolean;
  help: boolean;
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

function numberValue(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export function parseBridgeCliArgs(argv: readonly string[]): CliOptions {
  let url = process.env.AGENTCONDUIT_BRIDGE_URL;
  let stdioCommand: string | undefined;
  const stdioArgs: string[] = [];
  let workspace = process.env.AGENTCONDUIT_BRIDGE_WORKSPACE ?? process.cwd();
  let runtime =
    process.env.AGENTCONDUIT_BRIDGE_RUNTIME ?? "agentconduit-bridge";
  let sessionRef: string | undefined;
  let ownershipFile = process.env.AGENTCONDUIT_BRIDGE_OWNERSHIP_FILE;
  let heartbeatMs: number | undefined;
  let pollMs: number | undefined;
  let once = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--url":
        url = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--stdio-command":
        stdioCommand = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--stdio-arg":
        stdioArgs.push(valueAfter(argv, index, flag));
        index += 1;
        break;
      case "--workspace":
        workspace = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--runtime":
        runtime = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--session-ref":
        sessionRef = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--ownership-file":
        ownershipFile = valueAfter(argv, index, flag);
        index += 1;
        break;
      case "--heartbeat-ms":
        heartbeatMs = numberValue(valueAfter(argv, index, flag), flag);
        index += 1;
        break;
      case "--poll-ms":
        pollMs = numberValue(valueAfter(argv, index, flag), flag);
        index += 1;
        break;
      case "--once":
        once = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (help) {
    return {
      stdioArgs,
      workspace,
      runtime,
      once,
      help,
      ...(url ? { url } : {}),
      ...(stdioCommand ? { stdioCommand } : {}),
      ...(sessionRef ? { sessionRef } : {}),
      ...(ownershipFile ? { ownershipFile } : {}),
      ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
      ...(pollMs !== undefined ? { pollMs } : {}),
    };
  }
  if (!isAbsolute(workspace)) {
    throw new Error("--workspace must be an absolute path");
  }
  if ((url ? 1 : 0) + (stdioCommand ? 1 : 0) !== 1) {
    throw new Error("provide exactly one of --url or --stdio-command");
  }
  return {
    ...(url ? { url } : {}),
    ...(stdioCommand ? { stdioCommand } : {}),
    stdioArgs,
    workspace,
    runtime,
    ...(sessionRef ? { sessionRef } : {}),
    ...(ownershipFile ? { ownershipFile } : {}),
    ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
    ...(pollMs !== undefined ? { pollMs } : {}),
    once,
    help,
  };
}

function cliOptions(): CliOptions {
  return parseBridgeCliArgs(process.argv.slice(2));
}

async function main(): Promise<void> {
  const options = cliOptions();
  if (options.help) {
    console.log(
      "Usage: agentconduit-bridge --url <mcp-url> [--workspace <absolute-path>] [--runtime <name>] [--session-ref <label>] [--once]\n" +
        "   or: agentconduit-bridge --stdio-command <command> [--stdio-arg <arg>]...\n" +
        "The broker bearer token is read from AGENTCONDUIT_TOKEN; session tokens are never accepted as CLI arguments.",
    );
    return;
  }
  const connection: McpBridgeConnectionOptions = options.url
    ? {
        transport: "http",
        url: options.url,
        ...(process.env.AGENTCONDUIT_TOKEN
          ? { bearerToken: process.env.AGENTCONDUIT_TOKEN }
          : {}),
      }
    : {
        transport: "stdio",
        command: options.stdioCommand!,
        ...(options.stdioArgs.length > 0 ? { args: options.stdioArgs } : {}),
      };
  const client = await connectMcpAgentConduitClient(connection);
  const bridge = new BridgeSupervisor({
    client,
    ownsClient: true,
    registration: {
      runtime: options.runtime,
      workspacePath: options.workspace,
      ...(options.sessionRef ? { sessionRef: options.sessionRef } : {}),
    },
    ...(options.heartbeatMs !== undefined
      ? { heartbeatIntervalMs: options.heartbeatMs }
      : {}),
    ...(options.pollMs !== undefined ? { pollIntervalMs: options.pollMs } : {}),
    ...(options.ownershipFile ? { ownershipFile: options.ownershipFile } : {}),
    onEvent: (event) => {
      // Events intentionally exclude message bodies and all session secrets.
      console.error(JSON.stringify(event));
    },
  });
  const stop = async () => {
    await bridge.stop();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  const snapshot = await bridge.start();
  console.error(
    JSON.stringify({
      type: "bridge.ready",
      ownerId: snapshot.ownerId,
      agentId: snapshot.agentId,
      repositoryId: snapshot.repositoryId,
      worktreeId: snapshot.worktreeId,
      active: snapshot.active,
    }),
  );
  if (options.once) {
    await bridge.stop();
  } else {
    await new Promise<void>(() => undefined);
  }
}

const direct =
  process.argv[1]?.endsWith("/main.js") ||
  process.argv[1]?.endsWith("\\main.js");
if (direct) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
