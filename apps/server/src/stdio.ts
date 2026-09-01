import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, type CoordinationBackend } from "./mcp.js";

export interface StdioShutdownEvents {
  processEvents: Pick<NodeJS.Process, "once" | "off">;
  stdin: Pick<NodeJS.ReadStream, "once" | "off">;
}

/** Wait for the MCP host to close stdin or for the process to be terminated. */
export function waitForStdioShutdown(
  events: StdioShutdownEvents = {
    processEvents: process,
    stdin: process.stdin,
  },
): Promise<void> {
  return new Promise<void>((resolve) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      events.processEvents.off("SIGINT", stop);
      events.processEvents.off("SIGTERM", stop);
      events.stdin.off("end", stop);
      events.stdin.off("close", stop);
      resolve();
    };
    events.processEvents.once("SIGINT", stop);
    events.processEvents.once("SIGTERM", stop);
    events.stdin.once("end", stop);
    events.stdin.once("close", stop);
  });
}

export async function runStdio(service: CoordinationBackend): Promise<void> {
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await waitForStdioShutdown();
  await transport.close().catch(() => undefined);
  await server.close().catch(() => undefined);
}
