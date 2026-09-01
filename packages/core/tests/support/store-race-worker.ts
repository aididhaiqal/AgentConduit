import { CoordinationStore } from "../../src/store.js";

type RaceOperation =
  | {
      kind: "lease";
      databasePath: string;
      agentId: string;
      sessionToken: string;
      resource: string;
      ttlSeconds: number;
    }
  | {
      kind: "claim";
      databasePath: string;
      agentId: string;
      sessionToken: string;
      requestId: string;
      currentSourceOid: string;
      currentTargetOid: string;
    }
  | {
      kind: "job-event";
      databasePath: string;
      agentId: string;
      sessionToken: string;
      jobId: string;
      idempotencyKey: string;
      summary: string;
    }
  | {
      kind: "stale-send";
      databasePath: string;
      senderAgentId: string;
      senderSessionToken: string;
      recipientAgentId: string;
      body: string;
    };

interface SerializedError {
  name: string;
  code?: string;
  message: string;
}

interface SerializedResult {
  ok: boolean;
  value?: unknown;
  error?: SerializedError;
}

function decodeOperation(value: string | undefined): RaceOperation {
  if (!value) throw new Error("Missing race operation");
  return JSON.parse(
    Buffer.from(value, "base64url").toString("utf8"),
  ) as RaceOperation;
}

function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error))
    return { name: "Error", message: String(error) };
  const code = (error as Error & { code?: unknown }).code;
  return {
    name: error.name,
    ...(typeof code === "string" ? { code } : {}),
    message: error.message,
  };
}

const operation = decodeOperation(process.argv[2]);
const store = new CoordinationStore(operation.databasePath);

process.stdout.write("ready\n");
await new Promise<void>((resolve) =>
  process.stdin.once("data", () => resolve()),
);

if (operation.kind === "stale-send") {
  const preflight = (() => {
    try {
      store.verifyAgentSession(
        operation.senderAgentId,
        operation.senderSessionToken,
      );
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  if (preflight) {
    const result: SerializedResult = {
      ok: false,
      error: serializeError(preflight),
    };
    store.close();
    process.stdout.write(`result:${JSON.stringify(result)}\n`);
    process.exit(0);
  }
  process.stdout.write("verified\n");
  await new Promise<void>((resolve) =>
    process.stdin.once("data", () => resolve()),
  );
}

let result: SerializedResult;
try {
  const value =
    operation.kind === "lease"
      ? store.acquireLease(
          operation.resource,
          operation.agentId,
          operation.sessionToken,
          operation.ttlSeconds,
        )
      : operation.kind === "claim"
        ? store.claimIntegration(
            operation.requestId,
            operation.agentId,
            operation.sessionToken,
            operation.currentSourceOid,
            operation.currentTargetOid,
          )
        : operation.kind === "job-event"
          ? store.appendJobEvent(
              operation.agentId,
              operation.sessionToken,
              operation.jobId,
              {
                idempotencyKey: operation.idempotencyKey,
                type: "working",
                summary: operation.summary,
              },
            )
          : store.sendMessage(
              {
                senderAgentId: operation.senderAgentId,
                recipientAgentId: operation.recipientAgentId,
                body: operation.body,
              },
              operation.senderSessionToken,
            );
  result = { ok: true, value };
} catch (error) {
  result = { ok: false, error: serializeError(error) };
} finally {
  store.close();
}

process.stdout.write(`result:${JSON.stringify(result)}\n`);
