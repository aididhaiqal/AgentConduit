import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type OwnershipState = "running" | "stopped" | "unknown";

/**
 * A local diagnostic marker for one bridge instance. It intentionally contains
 * no session token or provider prompt. The broker remains authoritative for
 * liveness and ownership; this file is never a reclaim credential.
 */
export interface BridgeOwnershipRecord {
  schemaVersion: 1;
  ownerId: string;
  state: OwnershipState;
  pid: number;
  runtime: string;
  sessionRefDigest: string;
  workspacePath: string;
  startedAt: string;
  updatedAt: string;
  agentId?: string;
  repositoryId?: string;
  worktreeId?: string;
  adapterName?: string;
  adapterVersion?: string;
  stoppedAt?: string;
}

export type OwnershipProcessState =
  "self" | "alive" | "not_running" | "unknown";

export interface OwnershipObservation {
  record: BridgeOwnershipRecord;
  processState: OwnershipProcessState;
  /** Always false: a marker never authorizes a session takeover. */
  mayAssumeBrokerOwnership: false;
}

export function digestSessionRef(sessionRef: string): string {
  return createHash("sha256").update(sessionRef).digest("hex");
}

export function newBridgeOwnerId(): string {
  return `brg_${randomUUID().replaceAll("-", "")}`;
}

function isRecord(value: unknown): value is BridgeOwnershipRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.ownerId !== "string" ||
    !/^brg_[0-9a-f]{32}$/.test(record.ownerId) ||
    !["running", "stopped", "unknown"].includes(String(record.state)) ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.runtime !== "string" ||
    record.runtime.length < 1 ||
    record.runtime.length > 128 ||
    typeof record.sessionRefDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sessionRefDigest) ||
    typeof record.workspacePath !== "string" ||
    record.workspacePath.length < 1 ||
    typeof record.startedAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return false;
  }
  for (const key of [
    "agentId",
    "repositoryId",
    "worktreeId",
    "adapterName",
    "adapterVersion",
    "stoppedAt",
  ]) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      return false;
    }
  }
  return true;
}

function sanitizeRecord(record: BridgeOwnershipRecord): BridgeOwnershipRecord {
  // Construct a fresh object so an accidental extra property (including a
  // token added by a caller) cannot be written to the marker.
  return {
    schemaVersion: 1,
    ownerId: record.ownerId,
    state: record.state,
    pid: record.pid,
    runtime: record.runtime,
    sessionRefDigest: record.sessionRefDigest,
    workspacePath: record.workspacePath,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.repositoryId ? { repositoryId: record.repositoryId } : {}),
    ...(record.worktreeId ? { worktreeId: record.worktreeId } : {}),
    ...(record.adapterName ? { adapterName: record.adapterName } : {}),
    ...(record.adapterVersion ? { adapterVersion: record.adapterVersion } : {}),
    ...(record.stoppedAt ? { stoppedAt: record.stoppedAt } : {}),
  };
}

/** Atomic, mode-restricted persistence for one bridge ownership marker. */
export class FileOwnershipStore {
  readonly filePath: string;

  constructor(filePath: string) {
    if (!filePath.trim()) throw new Error("ownership file path is required");
    this.filePath = resolve(filePath);
  }

  async read(): Promise<BridgeOwnershipRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("bridge ownership file is not valid JSON");
    }
    if (!isRecord(parsed)) {
      throw new Error("bridge ownership file has an unsupported schema");
    }
    return sanitizeRecord(parsed);
  }

  async write(record: BridgeOwnershipRecord): Promise<void> {
    if (!isRecord(record)) {
      throw new Error("invalid bridge ownership record");
    }
    const safe = sanitizeRecord(record);
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(safe, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function probeProcess(pid: number): OwnershipProcessState {
  if (pid === process.pid) return "self";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "not_running";
    // EPERM and platform-specific errors do not prove either state.
    return "unknown";
  }
}

/**
 * Inspect a marker for operator diagnostics. Even an apparently live PID is
 * not treated as an active broker session; only a fresh broker heartbeat is.
 */
export function inspectOwnership(
  record: BridgeOwnershipRecord,
  processProbe: (pid: number) => OwnershipProcessState = probeProcess,
): OwnershipObservation {
  return {
    record: sanitizeRecord(record),
    processState: processProbe(record.pid),
    mayAssumeBrokerOwnership: false,
  };
}
