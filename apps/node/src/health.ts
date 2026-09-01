import { freemem, loadavg, totalmem, uptime } from "node:os";
import type { DeviceHealth } from "@agentconduit/core";

export function observeDeviceHealth(): DeviceHealth {
  const total = totalmem();
  const free = freemem();
  const memoryUsedPercent =
    total > 0 ? Math.max(0, Math.min(100, ((total - free) / total) * 100)) : 0;
  const loadAverage1 = loadavg()[0];
  return {
    status: "healthy",
    uptimeSeconds: Math.max(0, Math.round(uptime())),
    memoryUsedPercent: Math.round(memoryUsedPercent * 10) / 10,
    ...(Number.isFinite(loadAverage1) && loadAverage1! >= 0
      ? { loadAverage1: Math.round(loadAverage1! * 100) / 100 }
      : {}),
  };
}
