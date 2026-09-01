import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createHubApp, type HubLogger } from "./app.js";
import type { HubRuntimeConfig } from "./config.js";
import { HubEventNotifier } from "./events.js";
import { HubService } from "./service.js";

export interface HubRuntime {
  listener: Server;
  publicBaseUrl: string;
  close(reason?: string): Promise<void>;
}

export interface StartHubRuntimeOptions {
  service: HubService;
  config: HubRuntimeConfig;
  logger: HubLogger;
  notifier?: HubEventNotifier;
}

export async function startHubRuntime(
  options: StartHubRuntimeOptions,
): Promise<HubRuntime> {
  const { service, config, logger } = options;
  const notifier = options.notifier ?? new HubEventNotifier();
  let draining = false;
  try {
    service.store.healthCheck();
    service.store.recordAuditEvent("hub.starting", "hub", {
      transportMode: config.transport.mode,
    });
    const app = createHubApp({
      service,
      ownerToken: config.ownerToken,
      allowedOrigin: config.publicBaseUrl,
      secureCookies: true,
      notifier,
      logger,
      bodyLimitBytes: config.http.bodyLimitBytes,
      clientIpMode: config.transport.mode,
      readiness: () => {
        if (draining) throw new Error("Hub is draining");
        return service.store.healthCheck();
      },
    });
    const listener: Server =
      config.transport.mode === "direct-tls"
        ? createHttpsServer(
            {
              cert: readFileSync(config.transport.certificateFile),
              key: readFileSync(config.transport.privateKeyFile),
              minVersion: "TLSv1.2",
              honorCipherOrder: true,
            },
            app,
          )
        : createHttpServer(app);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      listener.once("error", onError);
      listener.listen(config.transport.port, config.transport.host, () => {
        listener.off("error", onError);
        resolve();
      });
    });
    listener.requestTimeout = config.http.requestTimeoutMs;
    listener.headersTimeout = Math.min(config.http.requestTimeoutMs, 15_000);
    listener.keepAliveTimeout = 5_000;
    listener.maxRequestsPerSocket = 100;
    listener.maxConnections = config.http.maxConnections;
    listener.maxHeadersCount = 100;
    const cursor = service.store.latestAuditCursor();
    notifier.publish(cursor);
    logger.info("hub.started", {
      profile: config.profile,
      publicBaseUrl: config.publicBaseUrl,
      transportMode: config.transport.mode,
      bindHost: config.transport.host,
      bindPort: config.transport.port,
      databasePath: config.databasePath,
    });

    let closePromise: Promise<void> | undefined;
    return {
      listener,
      publicBaseUrl: config.publicBaseUrl,
      close(reason = "requested") {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          draining = true;
          logger.info("hub.draining", { reason });
          try {
            service.store.recordAuditEvent("hub.draining", "hub", { reason });
            notifier.publish(service.store.latestAuditCursor());
          } catch {
            logger.warn("hub.drain_event_unavailable");
          }
          listener.closeIdleConnections?.();
          let forceTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await new Promise<void>((resolve, reject) => {
              forceTimer = setTimeout(() => {
                logger.warn("hub.force_closing_connections", {
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
            service.store.close();
          }
          logger.info("hub.stopped", { reason });
        })();
        return closePromise;
      },
    };
  } catch (error) {
    service.store.close();
    throw error;
  }
}
