import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  AGENTCONDUIT_NODE_PROTOCOL,
  CoordinationError,
  asCoordinationError,
  type AuditEventRecord,
  type NodeEventEnvelope,
  type NodeRpcOperation,
  type NodeRpcOperations,
} from "@agentconduit/core";
import { ZodError } from "zod/v4";
import { OwnerSessionManager } from "./auth.js";
import { HubEventNotifier } from "./events.js";
import {
  cancelIntegrationSchema,
  createEnrollmentSchema,
  enrollmentRequestSchema,
  operatorMessageSchema,
  ownerLoginSchema,
  parseNodeRpcRequest,
  reconciliationSchema,
  revokeDeviceSchema,
} from "./protocol.js";
import { HubService } from "./service.js";

export interface HubLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const silentLogger: HubLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface HubAppOptions {
  service: HubService;
  ownerToken: string;
  allowedOrigin: string;
  secureCookies: boolean;
  notifier?: HubEventNotifier;
  logger?: HubLogger;
  clock?: () => number;
  publicDirectory?: string;
  bodyLimitBytes?: number;
  requestId?: () => string;
  readiness?: () => unknown;
  clientIpMode?: "loopback-proxy" | "direct-tls";
  attemptBucketCapacity?: number;
}

interface AttemptWindow {
  startedAt: number;
  attempts: number;
}

const ATTEMPT_WINDOW_MS = 60_000;
const DEFAULT_ATTEMPT_BUCKET_CAPACITY = 4_096;
const SSE_REPLAY_MAX_EVENTS = 500;
const SSE_REPLAY_MAX_BYTES = 256 * 1_024;

function parseOrigin(value: string, secureCookies: boolean): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("Hub allowedOrigin must be an absolute URL");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Hub allowedOrigin must contain only scheme and authority");
  }
  if (secureCookies && origin.protocol !== "https:") {
    throw new Error("Production Hub allowedOrigin must use HTTPS");
  }
  if (!secureCookies && !["http:", "https:"].includes(origin.protocol)) {
    throw new Error("Development Hub allowedOrigin must use HTTP or HTTPS");
  }
  return origin;
}

function normalizedIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const mapped = trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  return isIP(mapped) === 0 ? undefined : mapped.toLowerCase();
}

function isLoopbackIp(value: string | undefined): boolean {
  const address = normalizedIp(value);
  return address === "127.0.0.1" || address === "::1";
}

function requestClientIp(
  request: Request,
  mode: "loopback-proxy" | "direct-tls",
): string {
  const peer = normalizedIp(request.socket.remoteAddress);
  if (mode === "direct-tls") return peer ?? "unknown";
  if (!isLoopbackIp(peer)) {
    throw new CoordinationError(
      "forbidden",
      "Loopback proxy requests must arrive from numeric loopback",
    );
  }
  const forwarded = request.header("x-forwarded-for");
  if (!forwarded || forwarded.includes(",")) {
    throw new CoordinationError(
      "invalid_input",
      "Loopback proxy omitted a valid client address",
    );
  }
  const client = normalizedIp(forwarded);
  if (!client) {
    throw new CoordinationError(
      "invalid_input",
      "Loopback proxy supplied an invalid client address",
    );
  }
  return client;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.header("authorization");
  if (authorization?.slice(0, 7).toLowerCase() !== "bearer ") return undefined;
  const token = authorization.slice(7);
  return token || undefined;
}

function statusFor(error: CoordinationError): number {
  switch (error.code) {
    case "invalid_input":
      return 400;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "expired":
      return 410;
    case "git_error":
    case "storage_error":
      return 503;
    default:
      return 500;
  }
}

function publicError(error: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: "invalid_input",
        message: "Request payload is invalid",
      },
    };
  }
  const bodyError = error as {
    type?: string;
    status?: number;
    statusCode?: number;
  };
  if (
    bodyError.type === "entity.too.large" ||
    bodyError.status === 413 ||
    bodyError.statusCode === 413
  ) {
    return {
      status: 413,
      body: {
        error: "request_too_large",
        message: "Request body is too large",
      },
    };
  }
  if (bodyError.type === "entity.parse.failed") {
    return {
      status: 400,
      body: {
        error: "invalid_json",
        message: "Request body is not valid JSON",
      },
    };
  }
  const normalized = asCoordinationError(error);
  const internalFailure =
    normalized.code === "storage_error" || normalized.code === "git_error";
  return {
    status: statusFor(normalized),
    body: {
      error: normalized.code,
      message: internalFailure ? "Hub operation failed" : normalized.message,
      ...(!internalFailure && normalized.details
        ? { details: normalized.details }
        : {}),
    },
  };
}

function route(
  handler: (request: Request, response: Response) => void | Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    Promise.resolve(handler(request, response)).catch(next);
  };
}

function cursorFrom(request: Request): number {
  const value =
    (typeof request.query.cursor === "string"
      ? request.query.cursor
      : undefined) ??
    request.header("last-event-id") ??
    "0";
  if (!/^[0-9]{1,16}$/.test(value)) {
    throw new CoordinationError(
      "invalid_input",
      "Event cursor must be a non-negative integer",
    );
  }
  const cursor = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(cursor)) {
    throw new CoordinationError(
      "invalid_input",
      "Event cursor is outside the supported range",
    );
  }
  return cursor;
}

function sseEvent(event: string, data: unknown, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function waitForDrain(response: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onClose = () => finish(new Error("SSE response closed"));
    const onError = (error: Error) => finish(error);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    if (response.destroyed || response.writableEnded) onClose();
  });
}

async function writeSse(response: Response, chunk: string): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new Error("SSE response closed");
  }
  if (!response.write(chunk)) await waitForDrain(response);
}

function streamEvents(
  request: Request,
  response: Response,
  service: HubService,
  notifier: HubEventNotifier,
): void {
  let cursor = cursorFrom(request);
  response.status(200);
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders();
  let closed = false;
  let running = false;
  let replayPending = true;
  let keepalivePending = false;
  let unsubscribe: () => void = () => undefined;

  const replay = async () => {
    const bounds = service.store.auditCursorBounds();
    if (cursor < bounds.earliest - 1 || cursor > bounds.latest) {
      const reason =
        cursor < bounds.earliest - 1 ? "cursor_pruned" : "cursor_ahead";
      await writeSse(
        response,
        sseEvent("reset", {
          reason,
          earliestCursor: bounds.earliest,
          latestCursor: bounds.latest,
        }),
      );
      cursor = bounds.latest;
      return;
    }
    const events: AuditEventRecord[] = service.store.listAuditEvents(
      cursor,
      SSE_REPLAY_MAX_EVENTS,
    );
    const chunks = events.map((event) => {
      const envelope: NodeEventEnvelope = {
        protocol: AGENTCONDUIT_NODE_PROTOCOL,
        event,
      };
      return sseEvent("coordination", envelope, event.cursor);
    });
    const replayBytes = chunks.reduce(
      (total, chunk) => total + Buffer.byteLength(chunk, "utf8"),
      0,
    );
    const lastCursor = events.at(-1)?.cursor ?? cursor;
    if (
      replayBytes > SSE_REPLAY_MAX_BYTES ||
      (events.length === SSE_REPLAY_MAX_EVENTS && lastCursor < bounds.latest)
    ) {
      await writeSse(
        response,
        sseEvent("reset", {
          reason: "replay_limit",
          earliestCursor: bounds.earliest,
          latestCursor: bounds.latest,
          snapshotRequired: true,
        }),
      );
      cursor = bounds.latest;
      return;
    }
    for (let index = 0; index < events.length; index += 1) {
      await writeSse(response, chunks[index]!);
      cursor = events[index]!.cursor;
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    unsubscribe();
  };

  const pump = async () => {
    if (running || closed) return;
    running = true;
    try {
      while (!closed && (replayPending || keepalivePending)) {
        if (replayPending) {
          replayPending = false;
          await replay();
        } else {
          keepalivePending = false;
          await writeSse(response, ": keepalive\n\n");
        }
      }
    } catch {
      cleanup();
      if (!response.writableEnded) response.end();
    } finally {
      running = false;
      if (!closed && (replayPending || keepalivePending)) void pump();
    }
  };

  // Subscribe before replay so a commit racing the initial page cannot fall
  // into a replay-to-live notification gap.
  unsubscribe = notifier.subscribe(() => {
    replayPending = true;
    void pump();
  });
  const keepalive = setInterval(() => {
    keepalivePending = true;
    void pump();
  }, 15_000);
  keepalive.unref?.();
  request.once("close", cleanup);
  response.once("close", cleanup);
  void pump();
}

export function createHubApp(options: HubAppOptions): Express {
  const origin = parseOrigin(options.allowedOrigin, options.secureCookies);
  const service = options.service;
  const notifier = options.notifier ?? new HubEventNotifier();
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? Date.now;
  const requestId = options.requestId ?? randomUUID;
  const sessions = new OwnerSessionManager({
    ownerToken: options.ownerToken,
    secureCookies: options.secureCookies,
    clock,
  });
  const publicDirectory =
    options.publicDirectory ??
    fileURLToPath(new URL("../public", import.meta.url));
  const bodyLimitBytes = options.bodyLimitBytes ?? 256 * 1_024;
  const clientIpMode = options.clientIpMode ?? "direct-tls";
  const attemptBucketCapacity =
    options.attemptBucketCapacity ?? DEFAULT_ATTEMPT_BUCKET_CAPACITY;
  if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes < 16 * 1_024) {
    throw new Error("Hub bodyLimitBytes must be at least 16384");
  }
  if (
    !Number.isSafeInteger(attemptBucketCapacity) ||
    attemptBucketCapacity < 1 ||
    attemptBucketCapacity > 65_536
  ) {
    throw new Error("Hub attemptBucketCapacity must be from 1-65536");
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
    response.setHeader(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=()",
    );
    response.setHeader("cross-origin-opener-policy", "same-origin");
    if (options.secureCookies) {
      response.setHeader(
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
      );
    }
    response.setHeader(
      "content-security-policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "font-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join("; "),
    );
    let logged = false;
    const log = () => {
      if (logged) return;
      logged = true;
      logger.info("hub.http_request", {
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
  app.use((request, response, next) => {
    if (request.header("host") !== origin.host) {
      response.status(400).json({ error: "invalid_host" });
      return;
    }
    next();
  });

  app.get("/livez", (_request, response) => {
    response.json({
      name: "agentconduit-hub",
      version: "0.1.0",
      status: "alive",
    });
  });
  app.get("/readyz", (_request, response) => {
    try {
      options.readiness?.() ?? service.store.healthCheck();
      response.json({
        name: "agentconduit-hub",
        version: "0.1.0",
        status: "ready",
      });
    } catch {
      response.status(503).json({
        name: "agentconduit-hub",
        version: "0.1.0",
        status: "not_ready",
      });
    }
  });

  app.use(
    "/api",
    express.json({ limit: bodyLimitBytes, type: "application/json" }),
  );

  const attempts = new Map<string, AttemptWindow>();
  const permitAttempt = (key: string, maximum: number): boolean => {
    const now = clock();
    const current = attempts.get(key);
    if (
      current &&
      (now < current.startedAt || now - current.startedAt >= ATTEMPT_WINDOW_MS)
    ) {
      attempts.delete(key);
    }
    const active = attempts.get(key);
    if (active) {
      attempts.delete(key);
      attempts.set(key, active);
      if (active.attempts >= maximum) return false;
      active.attempts += 1;
      return true;
    }
    if (attempts.size >= attemptBucketCapacity) {
      for (const [candidate, window] of attempts) {
        if (
          now < window.startedAt ||
          now - window.startedAt >= ATTEMPT_WINDOW_MS
        ) {
          attempts.delete(candidate);
        }
      }
    }
    while (attempts.size >= attemptBucketCapacity) {
      const oldest = attempts.keys().next().value as string | undefined;
      if (!oldest) break;
      attempts.delete(oldest);
    }
    attempts.set(key, { startedAt: now, attempts: 1 });
    return true;
  };
  const clearAttempts = (key: string) => attempts.delete(key);

  const exactOrigin = (request: Request): boolean =>
    request.header("origin") === origin.origin;

  app.post(
    "/api/v1/auth/login",
    route((request, response) => {
      if (!exactOrigin(request)) {
        response.status(403).json({ error: "origin_forbidden" });
        return;
      }
      const key = `login:${requestClientIp(request, clientIpMode)}`;
      if (!permitAttempt(key, 8)) {
        response.setHeader("retry-after", "60");
        response.status(429).json({ error: "rate_limited" });
        return;
      }
      const input = ownerLoginSchema.parse(request.body);
      const login = sessions.login(input.token);
      if (!login) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      clearAttempts(key);
      response.setHeader("set-cookie", login.cookie);
      response.json({
        result: { csrfToken: login.csrfToken, expiresAt: login.expiresAt },
      });
    }),
  );

  app.get("/api/v1/auth/session", (request, response) => {
    const session = sessions.session(request.header("cookie"));
    if (!session) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    response.json({ result: session });
  });

  const ownerRead = (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    if (
      sessions.authorizeBearer(request.header("authorization")) ||
      sessions.session(request.header("cookie"))
    ) {
      next();
      return;
    }
    response.status(401).json({ error: "unauthorized" });
  };

  const ownerMutation = (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    if (sessions.authorizeBearer(request.header("authorization"))) {
      next();
      return;
    }
    if (
      exactOrigin(request) &&
      sessions.authorize(
        request.header("cookie"),
        request.header("x-agentconduit-csrf"),
      )
    ) {
      next();
      return;
    }
    response.status(403).json({ error: "forbidden" });
  };

  app.post("/api/v1/auth/logout", ownerMutation, (request, response) => {
    response.setHeader("set-cookie", sessions.logout(request.header("cookie")));
    response.json({ result: { loggedOut: true } });
  });

  app.post(
    "/api/v1/enroll",
    route((request, response) => {
      const key = `enroll:${requestClientIp(request, clientIpMode)}`;
      if (!permitAttempt(key, 20)) {
        response.setHeader("retry-after", "60");
        response.status(429).json({ error: "rate_limited" });
        return;
      }
      const input = enrollmentRequestSchema.parse(request.body);
      const before = service.store.latestAuditCursor();
      const credential = service.store.enrollDevice(input.enrollmentCode, {
        name: input.name,
        platform: input.platform,
        architecture: input.architecture,
        nodeVersion: input.nodeVersion,
        capabilities: input.capabilities,
        health: {
          status: input.health.status,
          uptimeSeconds: input.health.uptimeSeconds,
          memoryUsedPercent: input.health.memoryUsedPercent,
          ...(input.health.loadAverage1 !== undefined
            ? { loadAverage1: input.health.loadAverage1 }
            : {}),
        },
      });
      const after = service.store.latestAuditCursor();
      if (after > before) notifier.publish(after);
      clearAttempts(key);
      response.status(201).json({ result: credential });
    }),
  );

  const deviceAuth = (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    const token = bearerToken(request);
    try {
      if (!token)
        throw new CoordinationError(
          "forbidden",
          "Device credential is invalid",
        );
      service.store.authenticateDevice(token);
      response.locals.deviceToken = token;
      next();
    } catch {
      response.status(401).json({ error: "unauthorized" });
    }
  };

  app.post(
    "/api/v1/node/rpc",
    deviceAuth,
    route((request, response) => {
      const parsed = parseNodeRpcRequest(request.body);
      const before = service.store.latestAuditCursor();
      const result = service.execute(
        response.locals.deviceToken as string,
        parsed.operation as NodeRpcOperation,
        parsed.params as NodeRpcOperations[NodeRpcOperation]["params"],
      );
      const after = service.store.latestAuditCursor();
      if (after > before) notifier.publish(after);
      response.json({ result });
    }),
  );

  app.get("/api/v1/node/events", deviceAuth, (request, response, next) => {
    try {
      streamEvents(request, response, service, notifier);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/admin/snapshot", ownerRead, (request, response, next) => {
    try {
      const cursor =
        typeof request.query.cursor === "string"
          ? request.query.cursor
          : undefined;
      if (request.query.cursor !== undefined && cursor === undefined) {
        throw new CoordinationError(
          "invalid_input",
          "Snapshot cursor must be a single string",
        );
      }
      const before = service.store.latestAuditCursor();
      const snapshot = service.snapshot(cursor);
      const after = service.store.latestAuditCursor();
      if (after > before) notifier.publish(after);
      response.json({ result: snapshot });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/admin/events", ownerRead, (request, response, next) => {
    try {
      streamEvents(request, response, service, notifier);
    } catch (error) {
      next(error);
    }
  });

  const adminMutation = <T>(
    schema: { parse(value: unknown): T },
    action: (input: T) => unknown,
  ) =>
    route((request, response) => {
      const input = schema.parse(request.body);
      const before = service.store.latestAuditCursor();
      const result = action(input);
      const after = service.store.latestAuditCursor();
      if (after > before) notifier.publish(after);
      response.json({ result });
    });

  app.post(
    "/api/v1/admin/enrollments",
    ownerMutation,
    adminMutation(createEnrollmentSchema, (input) =>
      service.createEnrollment(input.nameHint),
    ),
  );
  app.post(
    "/api/v1/admin/devices/revoke",
    ownerMutation,
    adminMutation(revokeDeviceSchema, (input) =>
      service.revokeDevice(input.deviceId),
    ),
  );
  app.post(
    "/api/v1/admin/messages",
    ownerMutation,
    adminMutation(operatorMessageSchema, (input) =>
      service.sendOperatorMessage(input.recipientAgentId, input.body),
    ),
  );
  app.post(
    "/api/v1/admin/integrations/cancel",
    ownerMutation,
    adminMutation(cancelIntegrationSchema, (input) =>
      service.cancelUnclaimedIntegration(input.requestId),
    ),
  );
  app.post(
    "/api/v1/admin/reconciliations",
    ownerMutation,
    adminMutation(reconciliationSchema, (input) =>
      service.openReconciliation(input.agentId, input.reason),
    ),
  );

  app.use(express.static(publicDirectory, { index: false, fallthrough: true }));
  app.use((request, response, next) => {
    if (request.method === "GET" && !request.path.startsWith("/api/")) {
      response.setHeader("cache-control", "no-cache");
      response.sendFile("index.html", { root: publicDirectory });
      return;
    }
    next();
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      const converted = publicError(error);
      logger.warn("hub.request_rejected", {
        requestId: response.getHeader("x-request-id"),
        statusCode: converted.status,
        error: converted.body.error,
      });
      if (!response.headersSent)
        response.status(converted.status).json(converted.body);
    },
  );

  return app;
}
