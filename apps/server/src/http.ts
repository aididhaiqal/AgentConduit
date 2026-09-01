import { randomUUID, timingSafeEqual } from "node:crypto";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, type CoordinationBackend } from "./mcp.js";
import {
  safeErrorMessage,
  silentLogger,
  type StructuredLogger,
} from "./logging.js";

export interface HttpLimits {
  bodyLimitBytes: number;
  maxConcurrentRequests: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  requestTimeoutMs: number;
}

const DEFAULT_LIMITS: HttpLimits = {
  bodyLimitBytes: 256 * 1024,
  maxConcurrentRequests: 16,
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 600,
  requestTimeoutMs: 30_000,
};

export interface HttpAppOptions {
  host?: string;
  token?: string;
  allowedHosts?: string[];
  limits?: Partial<HttpLimits>;
  logger?: StructuredLogger;
  readiness?: () => unknown;
  clock?: () => number;
  requestId?: () => string;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function authorized(request: Request, token: string | undefined): boolean {
  if (token === undefined) return true;
  const value = request.header("authorization");
  if (value?.slice(0, "Bearer ".length).toLowerCase() !== "bearer ") {
    return false;
  }
  const provided = Buffer.from(value.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

export function createHttpApp(
  service: CoordinationBackend,
  options: HttpAppOptions = {},
): Express {
  const host = options.host ?? "127.0.0.1";
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? Date.now;
  const requestId = options.requestId ?? randomUUID;
  const limits: HttpLimits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`HTTP limit ${name} must be a positive integer`);
    }
  }
  if (options.token === "") {
    throw new Error(
      "AgentConduit bearer token configuration must be non-empty when provided",
    );
  }
  if (!isLoopbackHost(host)) {
    throw new Error(
      "AgentConduit v1 only supports loopback HTTP binding; a bearer token does not enable remote exposure",
    );
  }
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const id = requestId();
    const startedAt = clock();
    response.setHeader("x-request-id", id);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    let logged = false;
    const log = () => {
      if (logged) return;
      logged = true;
      logger.info("http.request", {
        requestId: id,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.max(0, clock() - startedAt),
      });
    };
    response.once("finish", log);
    response.once("close", log);
    next();
  });
  app.use(
    options.allowedHosts?.length
      ? hostHeaderValidation(options.allowedHosts)
      : localhostHostValidation(),
  );
  app.get("/healthz", (_request, response) => {
    response
      .status(200)
      .json({ name: "agentconduit", version: "0.1.0", status: "ok" });
  });
  app.get("/livez", (_request, response) => {
    response
      .status(200)
      .json({ name: "agentconduit", version: "0.1.0", status: "alive" });
  });
  app.get("/readyz", (_request, response) => {
    try {
      options.readiness?.();
      response.status(200).json({
        name: "agentconduit",
        version: "0.1.0",
        status: "ready",
      });
    } catch (error) {
      logger.warn("http.not_ready", {
        error: safeErrorMessage(error, [options.token ?? ""]),
      });
      response.status(503).json({
        name: "agentconduit",
        version: "0.1.0",
        status: "not_ready",
      });
    }
  });

  let rateWindowStartedAt = clock();
  let rateWindowRequests = 0;
  let activeRequests = 0;
  app.use("/mcp", (request, response, next) => {
    if (!authorized(request, options.token)) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    const now = clock();
    if (
      now < rateWindowStartedAt ||
      now - rateWindowStartedAt >= limits.rateLimitWindowMs
    ) {
      rateWindowStartedAt = now;
      rateWindowRequests = 0;
    }
    if (rateWindowRequests >= limits.rateLimitMaxRequests) {
      response.setHeader(
        "retry-after",
        String(Math.max(1, Math.ceil(limits.rateLimitWindowMs / 1_000))),
      );
      response.status(429).json({ error: "rate_limited" });
      return;
    }
    rateWindowRequests += 1;
    if (activeRequests >= limits.maxConcurrentRequests) {
      response.setHeader("retry-after", "1");
      response.status(503).json({ error: "server_busy" });
      return;
    }
    activeRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  });
  app.use(express.json({ limit: limits.bodyLimitBytes }));
  app.post("/mcp", async (request, response) => {
    const server = createMcpServer(service);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const timeout = setTimeout(() => {
      if (!response.headersSent) {
        response.status(504).json({ error: "request_timeout" });
      }
    }, limits.requestTimeoutMs);
    timeout.unref?.();
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      logger.error("mcp.request_failed", {
        requestId: response.getHeader("x-request-id"),
        error: safeErrorMessage(error, [options.token ?? ""]),
      });
      if (!response.headersSent) {
        response.status(500).json({ error: "internal_error" });
      }
    } finally {
      clearTimeout(timeout);
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  app.all("/mcp", (_request: Request, response: Response) => {
    response.status(405).json({ error: "method_not_allowed" });
  });
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      const bodyError = error as {
        type?: string;
        status?: number;
        statusCode?: number;
      };
      const tooLarge =
        bodyError.type === "entity.too.large" ||
        bodyError.status === 413 ||
        bodyError.statusCode === 413;
      const invalidJson = bodyError.type === "entity.parse.failed";
      const status = tooLarge ? 413 : invalidJson ? 400 : 500;
      const code = tooLarge
        ? "request_too_large"
        : invalidJson
          ? "invalid_json"
          : "internal_error";
      logger.warn("http.request_rejected", {
        requestId: response.getHeader("x-request-id"),
        statusCode: status,
        error: safeErrorMessage(error, [options.token ?? ""]),
      });
      response.status(status).json({ error: code });
    },
  );
  return app;
}
