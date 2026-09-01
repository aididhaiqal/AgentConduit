import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const marker = "AGENTCONDUIT_CODEX_PUSH_PROBE_7F3A";
const notify = process.env.PUSH_PROBE_NOTIFY !== "0";
const notificationDelayMs = Number.parseInt(
  process.env.PUSH_PROBE_DELAY_MS ?? "500",
  10,
);
const toolDelayMs = Number.parseInt(
  process.env.PUSH_PROBE_TOOL_DELAY_MS ?? "2000",
  10,
);
const logPath = process.env.PUSH_PROBE_LOG;

function record(event) {
  if (!logPath) return;
  appendFileSync(
    logPath,
    `${JSON.stringify({ event, at: new Date().toISOString() })}\n`,
  );
}
const server = new McpServer(
  { name: "agentconduit-codex-push-probe", version: "0.0.1" },
  {
    capabilities: { logging: {} },
    instructions:
      "This is a transport experiment. Call push_probe_wait and report whether you received the unsolicited MCP logging notification.",
  },
);

server.registerTool(
  "push_probe_wait",
  {
    description:
      "Wait while the server emits one unsolicited notification, then return a control marker.",
  },
  async () => {
    await new Promise((resolve) => setTimeout(resolve, toolDelayMs));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ toolReturn: "TOOL_RETURNED" }),
        },
      ],
    };
  },
);

server.server.oninitialized = () => {
  record("initialized");
  if (!notify) return;
  setTimeout(async () => {
    try {
      await server.sendLoggingMessage({
        level: "info",
        logger: "agentconduit-codex-push-probe",
        data: { notification: "UNSOLICITED_PUSH", marker },
      });
      record("notification_sent");
      console.error(`push-probe: sent ${marker}`);
    } catch (error) {
      record("notification_failed");
      console.error(
        "push-probe: notification failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }, notificationDelayMs);
};

await server.connect(new StdioServerTransport());
