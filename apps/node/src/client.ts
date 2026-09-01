import {
  AGENTCONDUIT_NODE_PROTOCOL,
  CoordinationError,
  type DeviceCredential,
  type DeviceHealth,
  type NodeRpcOperation,
  type NodeRpcOperations,
  type NodeRpcRequest,
} from "@agentconduit/core";

const MAX_RESPONSE_BYTES = 1024 * 1_024;
const ERROR_CODES = new Set([
  "invalid_input",
  "not_found",
  "conflict",
  "forbidden",
  "expired",
  "git_error",
  "storage_error",
]);

export type FetchLike = typeof fetch;

export interface HubClientOptions {
  baseUrl: string;
  deviceToken: string;
  fetch?: FetchLike;
  requestTimeoutMs?: number;
  allowInsecureLoopback?: boolean;
}

export interface DeviceEnrollmentRequest {
  enrollmentCode: string;
  name: string;
  platform: string;
  architecture: string;
  nodeVersion: string;
  capabilities: string[];
  health: DeviceHealth;
}

function hubUrl(value: string, allowInsecureLoopback = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Hub URL must be an absolute URL");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Hub URL must contain only scheme and authority");
  }
  if (parsed.protocol === "https:") return parsed;
  if (
    allowInsecureLoopback &&
    parsed.protocol === "http:" &&
    ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)
  ) {
    return parsed;
  }
  throw new Error("Hub URL must use HTTPS");
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number.parseInt(declared, 10) > MAX_RESPONSE_BYTES) {
    throw new CoordinationError("storage_error", "Hub response is too large");
  }
  if (!response.body) {
    throw new CoordinationError("storage_error", "Hub response is empty");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new CoordinationError(
          "storage_error",
          "Hub response is too large",
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new CoordinationError(
      "storage_error",
      "Hub response is not valid JSON",
    );
  }
}

function remoteError(status: number, body: unknown): CoordinationError {
  if (body && typeof body === "object") {
    const record = body as {
      error?: unknown;
      message?: unknown;
      details?: unknown;
    };
    if (
      typeof record.error === "string" &&
      ERROR_CODES.has(record.error) &&
      typeof record.message === "string"
    ) {
      return new CoordinationError(
        record.error as CoordinationError["code"],
        record.message,
        record.details && typeof record.details === "object"
          ? (record.details as Record<string, unknown>)
          : undefined,
      );
    }
  }
  return new CoordinationError(
    status === 401 || status === 403 ? "forbidden" : "storage_error",
    status === 401 || status === 403
      ? "Hub rejected the device credential"
      : "Hub request failed",
    { status, coordinated: false },
  );
}

export class HubClient {
  readonly baseUrl: URL;
  readonly deviceToken: string;
  readonly requestTimeoutMs: number;
  private readonly fetcher: FetchLike;
  private _lastSuccessAt?: string;
  private _lastFailureAt?: string;

  constructor(options: HubClientOptions) {
    this.baseUrl = hubUrl(
      options.baseUrl,
      options.allowInsecureLoopback ?? false,
    );
    if (!/^acd_[0-9a-f]{64}$/.test(options.deviceToken)) {
      throw new Error("Device token is invalid");
    }
    this.deviceToken = options.deviceToken;
    this.fetcher = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  get lastSuccessAt(): string | undefined {
    return this._lastSuccessAt;
  }

  get lastFailureAt(): string | undefined {
    return this._lastFailureAt;
  }

  async rpc<TOperation extends NodeRpcOperation>(
    operation: TOperation,
    params: NodeRpcOperations[TOperation]["params"],
  ): Promise<NodeRpcOperations[TOperation]["result"]> {
    const request: NodeRpcRequest<TOperation> = {
      protocol: AGENTCONDUIT_NODE_PROTOCOL,
      operation,
      params,
    } as NodeRpcRequest<TOperation>;
    let response: Response;
    try {
      response = await this.fetcher(new URL("/api/v1/node/rpc", this.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.deviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      this._lastFailureAt = new Date().toISOString();
      throw new CoordinationError(
        "storage_error",
        "AgentConduit Hub is unavailable; coordinated authority was not granted",
        { reason: "hub_unavailable", coordinated: false },
      );
    }
    const body = await boundedJson(response);
    if (!response.ok) {
      this._lastFailureAt = new Date().toISOString();
      throw remoteError(response.status, body);
    }
    if (!body || typeof body !== "object" || !("result" in body)) {
      this._lastFailureAt = new Date().toISOString();
      throw new CoordinationError(
        "storage_error",
        "Hub response omitted its result",
      );
    }
    this._lastSuccessAt = new Date().toISOString();
    return (body as { result: NodeRpcOperations[TOperation]["result"] }).result;
  }

  eventsUrl(cursor: number): URL {
    const url = new URL("/api/v1/node/events", this.baseUrl);
    url.searchParams.set("cursor", String(cursor));
    return url;
  }

  eventHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.deviceToken}` };
  }

  async openEventStream(
    cursor: number,
    signal: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(this.eventsUrl(cursor), {
        method: "GET",
        headers: this.eventHeaders(),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      this._lastFailureAt = new Date().toISOString();
      throw new CoordinationError(
        "storage_error",
        "AgentConduit Hub event stream is unavailable",
        { reason: "hub_unavailable", coordinated: false },
      );
    }
    if (!response.ok) {
      const body = await boundedJson(response);
      this._lastFailureAt = new Date().toISOString();
      throw remoteError(response.status, body);
    }
    if (!response.body) {
      throw new CoordinationError(
        "storage_error",
        "Hub event stream omitted its response body",
      );
    }
    this._lastSuccessAt = new Date().toISOString();
    return response;
  }
}

export async function enrollWithHub(
  baseUrl: string,
  input: DeviceEnrollmentRequest,
  options: {
    fetch?: FetchLike;
    requestTimeoutMs?: number;
    allowInsecureLoopback?: boolean;
  } = {},
): Promise<DeviceCredential> {
  const url = hubUrl(baseUrl, options.allowInsecureLoopback ?? false);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(new URL("/api/v1/enroll", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? 30_000),
    });
  } catch {
    throw new CoordinationError(
      "storage_error",
      "AgentConduit Hub enrollment endpoint is unavailable",
      { reason: "hub_unavailable" },
    );
  }
  const body = await boundedJson(response);
  if (!response.ok) throw remoteError(response.status, body);
  const result = (body as { result?: unknown }).result;
  if (
    !result ||
    typeof result !== "object" ||
    typeof (result as { deviceId?: unknown }).deviceId !== "string" ||
    typeof (result as { deviceToken?: unknown }).deviceToken !== "string"
  ) {
    throw new CoordinationError(
      "storage_error",
      "Hub enrollment response is invalid",
    );
  }
  return result as DeviceCredential;
}
