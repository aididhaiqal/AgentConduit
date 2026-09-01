import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createHttpApp,
  runStdio,
  type StructuredLogger,
} from "@agentconduit/server";
import { CoordinationError } from "@agentconduit/core";
import { NodeCoordinationBackend } from "./backend.js";
import { HubClient } from "./client.js";
import type { NodeRuntimeConfig } from "./config.js";
import { FileEventCursorStore, NodeEventSupervisor } from "./events.js";
import { observeDeviceHealth } from "./health.js";

export const NODE_VERSION = "0.1.0";
export const NODE_CAPABILITIES = [
  "mcp",
  "git-discovery",
  "event-stream",
] as const;

export interface NodeRuntime {
  listener: Server;
  endpoint: string;
  close(reason?: string): Promise<void>;
}

export interface StartNodeRuntimeOptions {
  config: NodeRuntimeConfig;
  logger: StructuredLogger;
  client?: HubClient;
}

interface NodeParts {
  client: HubClient;
  backend: NodeCoordinationBackend;
  events: NodeEventSupervisor;
}

interface DeviceHeartbeatState {
  readonly lastHeartbeatAt: number;
  readonly revoked: boolean;
  start(): void;
  stop(): Promise<void>;
}

async function createParts(
  config: NodeRuntimeConfig,
  logger: StructuredLogger,
  providedClient?: HubClient,
): Promise<NodeParts> {
  const client =
    providedClient ??
    new HubClient({
      baseUrl: config.hubUrl,
      deviceToken: config.deviceToken,
      requestTimeoutMs: config.hubRequestTimeoutMs,
    });
  const device = await client.rpc("device.heartbeat", {
    nodeVersion: NODE_VERSION,
    capabilities: [...NODE_CAPABILITIES],
    health: observeDeviceHealth(),
  });
  if (device.deviceId !== config.deviceId) {
    throw new CoordinationError(
      "forbidden",
      "Hub device credential does not match the configured device identity",
    );
  }
  const backend = new NodeCoordinationBackend({
    client,
    deviceId: config.deviceId,
    allowedRoots: config.allowedRoots,
    pathLabels: config.pathLabels,
  });
  const events = new NodeEventSupervisor({
    client,
    cursorStore: new FileEventCursorStore(config.eventCursorFile),
    onEvent: (event) => {
      // Push is a wake-up hint only. Never log message bodies or acknowledge
      // recipient state from this callback.
      logger.info("node.coordination_event", {
        cursor: event.cursor,
        eventType: event.eventType,
        resourceId: event.resourceId,
      });
    },
    onWarning: (message) =>
      logger.warn("node.event_stream_degraded", { message }),
  });
  return { client, backend, events };
}

function deviceHeartbeat(
  client: HubClient,
  config: NodeRuntimeConfig,
  logger: StructuredLogger,
): DeviceHeartbeatState {
  let stopped = false;
  let revoked = false;
  let lastHeartbeatAt = Date.now();
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const pulse = (): Promise<void> => {
    if (stopped || revoked || inFlight) return inFlight ?? Promise.resolve();
    inFlight = (async () => {
      try {
        const device = await client.rpc("device.heartbeat", {
          nodeVersion: NODE_VERSION,
          capabilities: [...NODE_CAPABILITIES],
          health: observeDeviceHealth(),
        });
        if (device.deviceId !== config.deviceId) {
          throw new CoordinationError(
            "forbidden",
            "Hub device identity changed",
          );
        }
        lastHeartbeatAt = Date.now();
      } catch (error) {
        if (error instanceof CoordinationError && error.code === "forbidden") {
          revoked = true;
        }
        logger.warn("node.heartbeat_failed", {
          reason:
            error instanceof CoordinationError
              ? (error.details?.reason ?? error.code)
              : "hub_unavailable",
          coordinated: false,
        });
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return {
    get lastHeartbeatAt() {
      return lastHeartbeatAt;
    },
    get revoked() {
      return revoked;
    },
    start() {
      if (stopped) throw new Error("Device heartbeat cannot be restarted");
      if (timer) return;
      timer = setInterval(() => void pulse(), config.deviceHeartbeatIntervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight;
    },
  };
}

export async function startNodeRuntime(
  options: StartNodeRuntimeOptions,
): Promise<NodeRuntime> {
  const { config, logger } = options;
  const parts = await createParts(config, logger, options.client);
  let draining = false;
  const heartbeat = deviceHeartbeat(parts.client, config, logger);
  const app = createHttpApp(parts.backend, {
    host: config.host,
    token: config.localToken,
    logger,
    readiness: () => {
      if (draining) throw new Error("Node is draining");
      if (heartbeat.revoked) throw new Error("Device is revoked");
      if (
        Date.now() - heartbeat.lastHeartbeatAt >
        Math.max(config.deviceHeartbeatIntervalMs * 3, 90_000)
      ) {
        throw new Error("Hub heartbeat is stale");
      }
      return true;
    },
  });
  const listener = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(config.port, config.host);
    const onError = (error: Error) => reject(error);
    candidate.once("error", onError);
    candidate.once("listening", () => {
      candidate.off("error", onError);
      resolve(candidate);
    });
  });
  listener.requestTimeout = config.hubRequestTimeoutMs;
  listener.headersTimeout = Math.min(config.hubRequestTimeoutMs, 15_000);
  listener.keepAliveTimeout = 5_000;
  listener.maxRequestsPerSocket = 100;
  listener.maxConnections = 64;
  listener.maxHeadersCount = 100;
  heartbeat.start();
  parts.events.start();
  const address = listener.address() as AddressInfo;
  const hostForUrl = config.host === "::1" ? "[::1]" : config.host;
  const endpoint = `http://${hostForUrl}:${address.port}/mcp`;
  logger.info("node.started", {
    deviceId: config.deviceId,
    endpoint,
    allowedRootCount: config.allowedRoots.length,
  });

  let closePromise: Promise<void> | undefined;
  return {
    listener,
    endpoint,
    close(reason = "requested") {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        draining = true;
        logger.info("node.draining", { reason });
        listener.closeIdleConnections?.();
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            forceTimer = setTimeout(() => {
              listener.closeAllConnections?.();
            }, 15_000);
            forceTimer.unref?.();
            listener.close((error) => {
              if (
                error &&
                (error as NodeJS.ErrnoException).code !==
                  "ERR_SERVER_NOT_RUNNING"
              ) {
                reject(error);
              } else {
                resolve();
              }
            });
          });
        } finally {
          if (forceTimer) clearTimeout(forceTimer);
          await Promise.all([heartbeat.stop(), parts.events.stop()]);
        }
        logger.info("node.stopped", { reason });
      })();
      return closePromise;
    },
  };
}

export async function runNodeStdio(
  config: NodeRuntimeConfig,
  logger: StructuredLogger,
  client?: HubClient,
  stdioRunner: (backend: NodeCoordinationBackend) => Promise<void> = runStdio,
): Promise<void> {
  const parts = await createParts(config, logger, client);
  const heartbeat = deviceHeartbeat(parts.client, config, logger);
  heartbeat.start();
  parts.events.start();
  try {
    await stdioRunner(parts.backend);
  } finally {
    await Promise.all([heartbeat.stop(), parts.events.stop()]);
  }
}
