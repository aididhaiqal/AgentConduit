import type { Writable } from "node:stream";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface StructuredLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const SENSITIVE_KEY = /authorization|credential|password|secret|token/i;

function redactValue(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return secrets
      .reduce(
        (result, secret) =>
          secret ? result.split(secret).join("[redacted]") : result,
        value,
      )
      .slice(0, 2_000);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, secrets, depth + 1, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key)
      ? "[redacted]"
      : redactValue(entry, secrets, depth + 1, seen);
  }
  return result;
}

export function safeErrorMessage(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactValue(message, secrets) as string;
}

export interface JsonLoggerOptions {
  stream?: Writable;
  clock?: () => number;
  secrets?: readonly string[];
}

/** A newline-delimited JSON logger that never serializes Error objects. */
export function createJsonLogger(
  options: JsonLoggerOptions = {},
): StructuredLogger {
  const stream = options.stream ?? process.stderr;
  const clock = options.clock ?? Date.now;
  const secrets = options.secrets ?? [];
  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    const record = {
      timestamp: new Date(clock()).toISOString(),
      level,
      event,
      ...((redactValue(fields, secrets) as LogFields) ?? {}),
    };
    stream.write(`${JSON.stringify(record)}\n`);
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

export const silentLogger: StructuredLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
