import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentRegistrationInput } from "@agentconduit/core";
import type {
  AgentRecord,
  AgentRegistration,
  MessageRecord,
} from "@agentconduit/core";
import type { BrokerServerInfo, BridgeClientLike } from "./model.js";

type JsonObject = Record<string, unknown>;

/** A structured error returned by an AgentConduit MCP tool. */
export class McpBrokerError extends Error {
  readonly code: string | undefined;
  readonly details: unknown | undefined;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "McpBrokerError";
    this.code = code;
    this.details = details;
  }
}

export type McpBridgeConnectionOptions =
  | {
      transport: "http";
      url: string;
      /** The broker bearer token; never included in an error or event. */
      bearerToken?: string;
      headers?: Readonly<Record<string, string>>;
      reconnectionOptions?: StreamableHTTPClientTransportOptions["reconnectionOptions"];
    }
  | ({
      transport: "stdio";
      command: string;
      args?: readonly string[];
      env?: Readonly<Record<string, string>>;
      cwd?: string;
      stderr?: StdioServerParameters["stderr"];
    } & Record<string, unknown>);

interface RawMcpResult {
  content?: readonly RawContent[];
  structuredContent?: JsonObject;
  isError?: boolean;
}

type RawContent =
  { type: "text"; text: string } | { type: string; [key: string]: unknown };

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (result, secret) =>
      secret ? result.split(secret).join("[redacted]") : result,
    value,
  );
}

/**
 * Keep broker/provider diagnostics useful without allowing a structured error
 * payload to echo a bearer or session token. MCP details are JSON in the
 * normal case, but the bounded/cycle-safe walker also handles defensive
 * in-process callers that pass richer values.
 */
function redactDetails(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactDetails(item, secrets, depth + 1, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const safeKey = redact(key, secrets);
    output[safeKey] = /token|secret|credential|authorization/i.test(key)
      ? "[redacted]"
      : redactDetails(item, secrets, depth + 1, seen);
  }
  return output;
}

function errorMessage(error: unknown, secrets: readonly string[] = []): string {
  const value = error instanceof Error ? error.message : String(error);
  return redact(value, secrets).slice(0, 2_000);
}

function parseText(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function resultValue<T>(
  result: RawMcpResult,
  toolName: string,
  secrets: readonly string[] = [],
): T {
  if (result.isError) {
    const text = result.content?.find(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && typeof item.text === "string",
    )?.text;
    const parsed = text ? parseText(text) : undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const object = parsed as JsonObject;
      const message =
        typeof object.message === "string"
          ? object.message
          : `MCP tool failed: ${toolName}`;
      throw new McpBrokerError(
        redact(message, secrets).slice(0, 2_000),
        typeof object.error === "string"
          ? redact(object.error, secrets).slice(0, 256)
          : undefined,
        redactDetails(object.details, secrets),
      );
    }
    throw new McpBrokerError(
      typeof parsed === "string"
        ? redact(parsed, secrets).slice(0, 2_000)
        : `MCP tool failed: ${toolName}`,
    );
  }

  const structured = result.structuredContent;
  if (
    structured &&
    Object.prototype.hasOwnProperty.call(structured, "result")
  ) {
    return structured.result as T;
  }
  const text = result.content?.find(
    (item): item is { type: "text"; text: string } =>
      item.type === "text" && typeof item.text === "string",
  )?.text;
  if (text === undefined) {
    throw new McpBrokerError(`MCP tool returned no result: ${toolName}`);
  }
  return parseText(text) as T;
}

function definedArguments(
  values: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

/**
 * A small typed facade over the AgentConduit MCP tool names. Keeping this
 * facade provider-neutral lets the supervisor be tested without a live MCP
 * transport and keeps transport details out of its lifecycle logic.
 */
export class McpAgentConduitClient implements BridgeClientLike {
  private closed = false;

  constructor(
    private readonly client: Client,
    private readonly secrets: readonly string[] = [],
  ) {}

  private async call<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (this.closed) throw new McpBrokerError("MCP client is closed");
    const callSecrets = [
      ...this.secrets,
      ...Object.entries(args)
        .filter(
          ([key, value]) =>
            /token|secret|credential/i.test(key) && typeof value === "string",
        )
        .map(([, value]) => value as string),
    ];
    try {
      const result = (await this.client.callTool({
        name,
        arguments: args,
      })) as RawMcpResult;
      return resultValue<T>(result, name, callSecrets);
    } catch (error) {
      if (error instanceof McpBrokerError) {
        const safeMessage = redact(error.message, callSecrets);
        throw new McpBrokerError(
          safeMessage,
          error.code ? redact(error.code, callSecrets) : undefined,
          redactDetails(error.details, callSecrets),
        );
      }
      throw new McpBrokerError(errorMessage(error, callSecrets));
    }
  }

  register(input: AgentRegistrationInput): Promise<AgentRegistration> {
    return this.call<AgentRegistration>(
      "agent.register",
      definedArguments({
        runtime: input.runtime,
        workspacePath: input.workspacePath,
        sessionRef: input.sessionRef,
        sessionToken: input.sessionToken,
        displayName: input.displayName,
        capabilities: input.capabilities,
      }),
    );
  }

  async serverInfo(): Promise<BrokerServerInfo> {
    const value = await this.call<unknown>("server.info", {});
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Number.isSafeInteger(
        (value as { heartbeatTimeoutMs?: unknown }).heartbeatTimeoutMs,
      ) ||
      ((value as { heartbeatTimeoutMs: number }).heartbeatTimeoutMs ?? 0) < 1
    ) {
      throw new McpBrokerError(
        "MCP server.info returned an invalid heartbeat timeout",
      );
    }
    return {
      heartbeatTimeoutMs: (value as { heartbeatTimeoutMs: number })
        .heartbeatTimeoutMs,
    };
  }

  heartbeat(
    agentId: string,
    sessionToken: string,
    workspacePath: string,
  ): Promise<AgentRecord> {
    return this.call<AgentRecord>("agent.heartbeat", {
      agentId,
      sessionToken,
      workspacePath,
    });
  }

  async unregister(agentId: string, sessionToken: string): Promise<void> {
    await this.call<unknown>("agent.unregister", { agentId, sessionToken });
  }

  listAgents(
    repositoryId?: string,
    activeOnly?: boolean,
  ): Promise<AgentRecord[]> {
    return this.call<AgentRecord[]>(
      "agent.list",
      definedArguments({ repositoryId, activeOnly }),
    );
  }

  inbox(
    agentId: string,
    sessionToken: string,
    includeAcknowledged = false,
  ): Promise<MessageRecord[]> {
    return this.call<MessageRecord[]>(
      "message.inbox",
      definedArguments({ agentId, sessionToken, includeAcknowledged }),
    );
  }

  async acknowledgeMessage(
    agentId: string,
    sessionToken: string,
    messageId: string,
  ): Promise<void> {
    await this.call<unknown>("message.ack", {
      agentId,
      sessionToken,
      messageId,
    });
  }

  sendMessage(
    senderAgentId: string,
    senderSessionToken: string,
    recipientAgentId: string,
    body: string,
    correlationId?: string,
  ): Promise<MessageRecord> {
    return this.call<MessageRecord>(
      "message.send",
      definedArguments({
        senderAgentId,
        senderSessionToken,
        recipientAgentId,
        body,
        correlationId,
      }),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close().catch(() => undefined);
  }
}

function validateHttpOptions(
  options: Extract<McpBridgeConnectionOptions, { transport: "http" }>,
): URL {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new McpBrokerError("Bridge MCP URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpBrokerError("Bridge MCP URL must use http or https");
  }
  if (url.username || url.password) {
    throw new McpBrokerError(
      "Bridge MCP URL must not contain username or password credentials",
    );
  }
  if (options.bearerToken === "") {
    throw new McpBrokerError("Bridge bearer token must be non-empty when set");
  }
  if (options.headers) {
    for (const key of Object.keys(options.headers)) {
      if (key.toLowerCase() === "authorization") {
        throw new McpBrokerError(
          "Use bearerToken instead of a raw Authorization header",
        );
      }
    }
  }
  return url;
}

/** Connect to a Streamable HTTP or stdio AgentConduit MCP server. */
export async function connectMcpAgentConduitClient(
  options: McpBridgeConnectionOptions,
): Promise<McpAgentConduitClient> {
  const client = new Client({
    name: "agentconduit-bridge",
    version: "0.1.0",
  });
  let secrets: string[] = [];
  try {
    if (options.transport === "http") {
      const url = validateHttpOptions(options);
      const headers: Record<string, string> = {
        ...(options.headers ?? {}),
      };
      if (options.bearerToken !== undefined) {
        headers.authorization = `Bearer ${options.bearerToken}`;
        secrets = [options.bearerToken];
      }
      const requestInit: RequestInit =
        Object.keys(headers).length > 0 ? { headers } : {};
      const transportOptions: StreamableHTTPClientTransportOptions = {
        ...(Object.keys(headers).length > 0 ? { requestInit } : {}),
        ...(options.reconnectionOptions
          ? { reconnectionOptions: options.reconnectionOptions }
          : {}),
      };
      const transport = new StreamableHTTPClientTransport(
        new URL(url.toString()),
        transportOptions,
      );
      await client.connect(transport);
    } else {
      if (!options.command.trim()) {
        throw new McpBrokerError("Bridge stdio command must be non-empty");
      }
      const server: StdioServerParameters = {
        command: options.command,
        ...(options.args ? { args: [...options.args] } : {}),
        ...(options.env ? { env: { ...options.env } } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
      };
      const transport = new StdioClientTransport(server);
      await client.connect(transport);
    }
  } catch (error) {
    await client.close().catch(() => undefined);
    if (error instanceof McpBrokerError) throw error;
    throw new McpBrokerError(errorMessage(error, secrets));
  }
  return new McpAgentConduitClient(client, secrets);
}

/** Exported for focused parser/result tests without exposing provider state. */
export function parseMcpToolResult<T>(
  result: unknown,
  toolName = "unknown",
  secrets: readonly string[] = [],
): T {
  if (!result || typeof result !== "object") {
    throw new McpBrokerError(
      `MCP tool returned an invalid result: ${toolName}`,
    );
  }
  return resultValue<T>(result as RawMcpResult, toolName, secrets);
}
