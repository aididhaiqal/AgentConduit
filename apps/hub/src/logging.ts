import type { HubLogger } from "./app.js";

const SENSITIVE_KEY =
  /(?:authorization|cookie|token|secret|credential|password|body)/i;

function safeFields(
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!fields) return {};
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      SENSITIVE_KEY.test(key)
        ? "[redacted]"
        : typeof value === "string"
          ? value.slice(0, 2_048)
          : value,
    ]),
  );
}

export function createJsonHubLogger(
  output: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): HubLogger {
  const write = (
    level: "info" | "warn" | "error",
    event: string,
    fields?: Record<string, unknown>,
  ) => {
    output.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...safeFields(fields),
      })}\n`,
    );
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
