import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CoordinationService } from "@agentconduit/core";
import type { ProductionRuntimeConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import type { StructuredLogger } from "./logging.js";

export interface HttpBrokerRuntime {
  listener: Server;
  endpoint: string;
  close(reason?: string): Promise<void>;
}

export interface HttpBrokerRuntimeOptions {
  service: CoordinationService;
  config: ProductionRuntimeConfig;
  logger: StructuredLogger;
}

/** Start one owned production listener and drain it before closing SQLite. */
export async function startProductionHttpBroker(
  options: HttpBrokerRuntimeOptions,
): Promise<HttpBrokerRuntime> {
  const { service, config, logger } = options;
  let draining = false;
  const listener = await (async () => {
    try {
      service.store.healthCheck();
      const app = createHttpApp(service, {
        host: config.host,
        token: config.token,
        limits: {
          bodyLimitBytes: config.http.bodyLimitBytes,
          maxConcurrentRequests: config.http.maxConcurrentRequests,
          rateLimitWindowMs: config.http.rateLimitWindowMs,
          rateLimitMaxRequests: config.http.rateLimitMaxRequests,
          requestTimeoutMs: config.http.requestTimeoutMs,
        },
        logger,
        readiness: () => {
          if (draining) throw new Error("broker is draining");
          return service.store.healthCheck();
        },
      });
      return await new Promise<Server>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        const candidate = app.listen(config.port, config.host, (error) => {
          candidate.off("error", onError);
          if (error) {
            reject(error);
          } else {
            resolve(candidate);
          }
        });
        candidate.once("error", onError);
      });
    } catch (error) {
      service.close();
      throw error;
    }
  })();
  listener.requestTimeout = config.http.requestTimeoutMs;
  listener.headersTimeout = Math.min(config.http.requestTimeoutMs, 15_000);
  listener.keepAliveTimeout = 5_000;
  listener.maxRequestsPerSocket = 100;
  listener.maxConnections = config.http.maxConnections;
  listener.maxHeadersCount = 100;
  const address = listener.address() as AddressInfo;
  const hostForUrl = config.host === "::1" ? "[::1]" : config.host;
  const endpoint = `http://${hostForUrl}:${address.port}/mcp`;
  logger.info("broker.started", {
    profile: "production",
    endpoint,
    allowedRootCount: config.allowedRoots.length,
    databasePath: config.databasePath,
  });

  let closePromise: Promise<void> | undefined;
  return {
    listener,
    endpoint,
    close(reason = "requested") {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        draining = true;
        logger.info("broker.draining", { reason });
        listener.closeIdleConnections?.();
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            forceTimer = setTimeout(() => {
              logger.warn("broker.force_closing_connections", {
                timeoutMs: config.http.shutdownTimeoutMs,
              });
              listener.closeAllConnections?.();
            }, config.http.shutdownTimeoutMs);
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
          service.close();
        }
        logger.info("broker.stopped", { reason });
      })();
      return closePromise;
    },
  };
}
