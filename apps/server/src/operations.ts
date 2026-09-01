import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import {
  CoordinationService,
  CoordinationStore,
  migrateCoordinationDatabase,
  preflightCoordinationMigration,
  type CoordinationBackupResult,
  type CoordinationMaintenanceOptions,
  type CoordinationMaintenancePolicy,
  type CoordinationMaintenanceResult,
  type CoordinationMigrationPreflight,
  type CoordinationMigrationResult,
  type CoordinationStoreHealth,
} from "@agentconduit/core";
import type { ProductionRuntimeConfig } from "./config.js";

export interface ProductionDoctorResult {
  profile: "production";
  database: CoordinationStoreHealth & { path: string };
  allowedRootCount: number;
  host: "127.0.0.1" | "::1";
  port: number;
}

function secureFile(path: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/** Create the current schema only at a new configured database path. */
export function initializeProductionDatabase(
  config: ProductionRuntimeConfig,
): CoordinationStoreHealth {
  if (existsSync(config.databasePath)) {
    throw new Error("Production database file already exists");
  }
  writeFileSync(config.databasePath, "", { flag: "wx", mode: 0o600 });
  let store: CoordinationStore | undefined;
  try {
    store = new CoordinationStore(config.databasePath);
    const health = store.healthCheck();
    store.close();
    store = undefined;
    secureFile(config.databasePath);
    return health;
  } catch (error) {
    store?.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      rmSync(`${config.databasePath}${suffix}`, { force: true });
    }
    throw error;
  }
}

export function openProductionService(
  config: ProductionRuntimeConfig,
): CoordinationService {
  const store = new CoordinationStore(config.databasePath, {
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    migrations: "require-current",
  });
  try {
    store.healthCheck();
    return new CoordinationService({
      store,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs,
      allowedRoots: config.allowedRoots,
    });
  } catch (error) {
    store.close();
    throw error;
  }
}

export function doctorProduction(
  config: ProductionRuntimeConfig,
): ProductionDoctorResult {
  const service = openProductionService(config);
  try {
    return {
      profile: "production",
      database: {
        path: config.databasePath,
        ...service.store.healthCheck(),
      },
      allowedRootCount: config.allowedRoots.length,
      host: config.host,
      port: config.port,
    };
  } finally {
    service.close();
  }
}

export async function backupProduction(
  config: ProductionRuntimeConfig,
  destinationPath: string,
): Promise<CoordinationBackupResult> {
  const service = openProductionService(config);
  try {
    return await service.store.backupTo(destinationPath);
  } finally {
    service.close();
  }
}

export function maintainProduction(
  config: ProductionRuntimeConfig,
  policy: CoordinationMaintenancePolicy,
  options: CoordinationMaintenanceOptions = {},
): CoordinationMaintenanceResult {
  const service = openProductionService(config);
  try {
    return service.store.runMaintenance(policy, options);
  } finally {
    service.close();
  }
}

export function preflightProductionMigration(
  config: ProductionRuntimeConfig,
): CoordinationMigrationPreflight {
  return preflightCoordinationMigration(config.databasePath);
}

export async function migrateProduction(
  config: ProductionRuntimeConfig,
  backupPath: string,
): Promise<CoordinationMigrationResult> {
  return await migrateCoordinationDatabase(config.databasePath, backupPath);
}
