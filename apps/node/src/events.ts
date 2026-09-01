import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
  AGENTCONDUIT_NODE_PROTOCOL,
  CoordinationError,
  type AuditEventRecord,
} from "@agentconduit/core";
import { HubClient } from "./client.js";

export interface EventCursorStore {
  load(): number;
  save(cursor: number): void;
}

export class MemoryEventCursorStore implements EventCursorStore {
  constructor(public cursor = 0) {}
  load(): number {
    return this.cursor;
  }
  save(cursor: number): void {
    this.cursor = cursor;
  }
}

export class FileEventCursorStore implements EventCursorStore {
  constructor(readonly path: string) {
    if (!isAbsolute(path))
      throw new Error("Event cursor path must be absolute");
  }

  load(): number {
    try {
      const stats = lstatSync(this.path);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 64) {
        throw new Error("Event cursor must be a bounded regular file");
      }
      if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
        throw new Error("Event cursor file permissions must be private");
      }
      const value = readFileSync(this.path, "utf8").trim();
      if (!/^[0-9]{1,16}$/.test(value))
        throw new Error("Event cursor is invalid");
      const cursor = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(cursor))
        throw new Error("Event cursor is invalid");
      return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  save(cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error("Event cursor must be a non-negative safe integer");
    }
    const parent = dirname(this.path);
    const parentStats = statSync(parent);
    if (!parentStats.isDirectory())
      throw new Error("Event cursor parent is invalid");
    if (process.platform !== "win32" && (parentStats.mode & 0o077) !== 0) {
      throw new Error("Event cursor directory permissions must be private");
    }
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${cursor}\n`, { flag: "wx", mode: 0o600 });
      if (process.platform !== "win32") chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

interface ParsedEvent {
  id?: number;
  event: string;
  data: unknown;
}

function parseBlock(block: string): ParsedEvent | undefined {
  let event = "message";
  let id: number | undefined;
  const data: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value =
      separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id" && /^[0-9]{1,16}$/.test(value)) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isSafeInteger(parsed)) id = parsed;
    } else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(data.join("\n")) as unknown;
  } catch {
    throw new CoordinationError(
      "storage_error",
      "Hub event stream contained invalid JSON",
    );
  }
  return { ...(id !== undefined ? { id } : {}), event, data: decoded };
}

function coordinationEvent(parsed: ParsedEvent): AuditEventRecord | undefined {
  if (parsed.event !== "coordination") return undefined;
  if (!parsed.data || typeof parsed.data !== "object") {
    throw new CoordinationError(
      "storage_error",
      "Hub event envelope is invalid",
    );
  }
  const envelope = parsed.data as {
    protocol?: unknown;
    event?: Partial<AuditEventRecord>;
  };
  if (
    envelope.protocol !== AGENTCONDUIT_NODE_PROTOCOL ||
    !envelope.event ||
    !Number.isSafeInteger(envelope.event.cursor) ||
    envelope.event.cursor! < 1 ||
    typeof envelope.event.eventId !== "string" ||
    typeof envelope.event.eventType !== "string" ||
    typeof envelope.event.createdAt !== "string" ||
    !envelope.event.metadata ||
    typeof envelope.event.metadata !== "object"
  ) {
    throw new CoordinationError(
      "storage_error",
      "Hub event envelope is invalid",
    );
  }
  if (parsed.id !== envelope.event.cursor) {
    throw new CoordinationError(
      "storage_error",
      "Hub event ID does not match its durable cursor",
    );
  }
  return envelope.event as AuditEventRecord;
}

export interface NodeEventSupervisorOptions {
  client: HubClient;
  cursorStore: EventCursorStore;
  onEvent?: (event: AuditEventRecord) => void | Promise<void>;
  onWarning?: (message: string) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

export class NodeEventSupervisor {
  private readonly options: NodeEventSupervisorOptions;
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(options: NodeEventSupervisorOptions) {
    this.options = options;
  }

  start(): void {
    if (this.running) return;
    this.controller = new AbortController();
    this.running = this.loop(this.controller.signal).finally(() => {
      this.running = undefined;
      this.controller = undefined;
    });
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.running;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const minBackoff = this.options.minBackoffMs ?? 1_000;
    const maxBackoff = this.options.maxBackoffMs ?? 30_000;
    const sleep = this.options.sleep ?? defaultSleep;
    let backoff = minBackoff;
    while (!signal.aborted) {
      try {
        await this.consume(signal);
        backoff = minBackoff;
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof CoordinationError && error.code === "forbidden") {
          this.options.onWarning?.(
            "Hub rejected the device credential; event streaming stopped",
          );
          break;
        }
        this.options.onWarning?.(
          error instanceof Error ? error.message : "Hub event stream failed",
        );
      }
      if (signal.aborted) break;
      await sleep(backoff, signal);
      backoff = Math.min(maxBackoff, Math.max(minBackoff, backoff * 2));
    }
  }

  private async consume(signal: AbortSignal): Promise<void> {
    let cursor = this.options.cursorStore.load();
    const response = await this.options.client.openEventStream(cursor, signal);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder
          .decode(part.value, { stream: true })
          .replaceAll("\r\n", "\n");
        if (buffer.length > 1024 * 1_024) {
          throw new CoordinationError(
            "storage_error",
            "Hub event frame exceeded the Node buffer limit",
          );
        }
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseBlock(block);
          if (!parsed) continue;
          if (parsed.event === "reset") {
            const latest =
              parsed.data && typeof parsed.data === "object"
                ? (parsed.data as { latestCursor?: unknown }).latestCursor
                : undefined;
            if (!Number.isSafeInteger(latest) || (latest as number) < 0) {
              throw new CoordinationError(
                "storage_error",
                "Hub reset event omitted a valid latest cursor",
              );
            }
            cursor = latest as number;
            this.options.cursorStore.save(cursor);
            continue;
          }
          const event = coordinationEvent(parsed);
          if (!event || event.cursor <= cursor) continue;
          await this.options.onEvent?.(event);
          cursor = event.cursor;
          this.options.cursorStore.save(cursor);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
