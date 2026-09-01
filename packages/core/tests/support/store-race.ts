import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RaceOperation =
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
    };

export interface StaleMessageOperation {
  kind: "stale-send";
  databasePath: string;
  senderAgentId: string;
  senderSessionToken: string;
  recipientAgentId: string;
  body: string;
}

export interface RaceResult {
  ok: boolean;
  value?: unknown;
  error?: {
    name: string;
    code?: string;
    message: string;
  };
}

interface Contender {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  completed: Promise<RaceResult>;
}

const supportDirectory = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(supportDirectory, "store-race-worker.ts");
const packageRoot = resolve(supportDirectory, "../..");
const childTemporaryDirectory =
  process.platform === "win32" ? tmpdir() : "/tmp";

function startContender(operation: RaceOperation): Contender {
  const encoded = Buffer.from(JSON.stringify(operation), "utf8").toString(
    "base64url",
  );
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(
    command,
    ["--silent", "exec", "tsx", workerPath, encoded],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        TMPDIR: childTemporaryDirectory,
        TEMP: childTemporaryDirectory,
        TMP: childTemporaryDirectory,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!readySettled && stdout.split("\n").includes("ready")) {
      readySettled = true;
      resolveReady();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completed = new Promise<RaceResult>((resolvePromise, rejectPromise) => {
    child.once("error", (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        const error = new Error(
          `Race worker exited with ${signal ?? `code ${String(code)}`}: ${stderr || stdout}`,
        );
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
        }
        rejectPromise(error);
        return;
      }
      const resultLine = stdout
        .split("\n")
        .find((line) => line.startsWith("result:"));
      if (!resultLine) {
        rejectPromise(
          new Error(`Race worker did not return a result: ${stderr || stdout}`),
        );
        return;
      }
      resolvePromise(
        JSON.parse(resultLine.slice("result:".length)) as RaceResult,
      );
    });
  });
  void completed.catch(() => undefined);

  return { child, ready, completed };
}

export async function runConcurrentStoreOperations(
  operations: [RaceOperation, RaceOperation],
): Promise<[RaceResult, RaceResult]> {
  const contenders = operations.map(startContender) as [Contender, Contender];
  try {
    await Promise.all(contenders.map((contender) => contender.ready));
    for (const contender of contenders) contender.child.stdin.end("start\n");
    return (await Promise.all(
      contenders.map((contender) => contender.completed),
    )) as [RaceResult, RaceResult];
  } finally {
    for (const contender of contenders) {
      contender.child.stdin.destroy();
      if (
        contender.child.exitCode === null &&
        contender.child.signalCode === null
      ) {
        contender.child.kill();
      }
    }
  }
}

export interface ControlledStaleOperation {
  verified: Promise<void>;
  completed: Promise<RaceResult>;
  proceed(): void;
  dispose(): void;
}

/**
 * Start a worker that performs its first token check, pause it, and expose a
 * gate so a test can rotate the token in another process before the worker
 * attempts the protected transition.
 */
export function startStaleMessageOperation(
  operation: StaleMessageOperation,
): ControlledStaleOperation {
  const encoded = Buffer.from(JSON.stringify(operation), "utf8").toString(
    "base64url",
  );
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(
    command,
    ["--silent", "exec", "tsx", workerPath, encoded],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        TMPDIR: childTemporaryDirectory,
        TEMP: childTemporaryDirectory,
        TMP: childTemporaryDirectory,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let outputBuffer = "";
  let stderr = "";
  let verifiedResolve!: () => void;
  let verifiedReject!: (error: Error) => void;
  const verified = new Promise<void>((resolve, reject) => {
    verifiedResolve = resolve;
    verifiedReject = reject;
  });
  let completedResolve!: (result: RaceResult) => void;
  let completedReject!: (error: Error) => void;
  const completed = new Promise<RaceResult>((resolve, reject) => {
    completedResolve = resolve;
    completedReject = reject;
  });
  let settled = false;
  let gatesOpened = 0;
  const processOutput = (chunk: string) => {
    stdout += chunk;
    outputBuffer += chunk;
    const lines = outputBuffer.split("\n");
    // Keep the final partial line for the next chunk.
    outputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "verified") verifiedResolve();
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", processOutput);
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    if (!settled) {
      settled = true;
      verifiedReject(error);
      completedReject(error);
    }
  });
  child.once("exit", (code, signal) => {
    if (code !== 0) {
      const error = new Error(
        `Stale race worker exited with ${signal ?? `code ${String(code)}`}: ${stderr || stdout}`,
      );
      verifiedReject(error);
      completedReject(error);
      return;
    }
    const resultLine = `${stdout}`
      .split("\n")
      .find((line) => line.startsWith("result:"));
    if (!resultLine) {
      completedReject(
        new Error(
          `Stale race worker did not return a result: ${stderr || stdout}`,
        ),
      );
      return;
    }
    completedResolve(
      JSON.parse(resultLine.slice("result:".length)) as RaceResult,
    );
  });

  return {
    verified,
    completed,
    proceed() {
      gatesOpened += 1;
      if (gatesOpened === 1) child.stdin.write("continue\n");
      else child.stdin.end("continue\n");
    },
    dispose() {
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}
