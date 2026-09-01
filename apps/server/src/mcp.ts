import {
  CoordinationError,
  CoordinationService,
  asCoordinationError,
  type JobActivity,
  type JobEventInput,
  type JobStatus,
} from "@agentconduit/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

const SERVER_INSTRUCTIONS = `AgentConduit coordinates independent coding agents through durable, server-owned state.
Register the actual Git workspace before doing shared work, keep the returned sessionToken private, heartbeat while active, poll your inbox at task boundaries, and use integration.enqueue/claim/renew/refresh/complete for shared target refs. Create a durable job for delegated or long-running work, emit heartbeat only for liveness, emit checkpoint only for meaningful bounded progress, and replay job.events from the last cursor. A stale job is inspectable and recoverable; it is never proof of completion, cancellation, abandonment, or cleanup authority. Job fields may contain concise operator-safe summaries only—never prompts, credentials, raw provider streams, or hidden reasoning. Use agent.list with activeOnly=true when making a fresh-presence routing decision; stale rows remain visible for reconciliation and are not proof that a process is gone. Never infer another agent's branch or HEAD from memory: re-read the returned Git snapshot. Claims revalidate both source and target OIDs. An integration lease serializes compliant agents but does not make raw Git commands safe; follow the repository's protected-branch policy.`;

const TOOL_OUTPUT_SCHEMA = {
  result: z.unknown().describe("The provider-neutral AgentConduit result"),
};

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: { result: unknown };
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function fail(error: unknown): ToolResult {
  const normalized = asCoordinationError(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: normalized.code,
            message: normalized.message,
            ...(normalized.details ? { details: normalized.details } : {}),
          },
          null,
          2,
        ),
      },
    ],
  };
}

function guarded<TArgs extends unknown[]>(
  handler: (...args: TArgs) => unknown | Promise<unknown>,
) {
  return async (...args: TArgs): Promise<ToolResult> => {
    try {
      return ok(await handler(...args));
    } catch (error) {
      return fail(error);
    }
  };
}

const runtimeSchema = z.string().trim().min(1).max(128);
const agentIdSchema = z.string().regex(/^agt_[0-9a-f]{32}$/);
const sessionTokenSchema = z.string().regex(/^acs_[0-9a-f]{64}$/);
const workspacePathSchema = z.string().trim().min(1).max(4096);
const refSchema = z.string().trim().min(1).max(512);
const repositoryIdSchema = z.string().regex(/^repo_[0-9a-f]{32}$/);
const jobIdSchema = z.string().regex(/^job_[0-9a-f]{32}$/);
const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const safeLineSchema = (maximumBytes: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) =>
        Buffer.byteLength(value, "utf8") <= maximumBytes &&
        !/[\u0000-\u001f\u007f]/u.test(value),
      `Must be one line of at most ${maximumBytes} UTF-8 bytes`,
    );
const jobStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);
const jobActivitySchema = z.enum(["active", "stale", "terminal"]);
const jobEventTypeSchema = z.enum([
  "started",
  "provider_ready",
  "working",
  "heartbeat",
  "checkpoint",
  "waiting_for_input",
  "operation_started",
  "operation_finished",
  "completed",
  "failed",
  "cancelled",
]);

type CoordinationBackendMethod =
  | "discover"
  | "registerWorkspace"
  | "listWorkspaces"
  | "register"
  | "heartbeat"
  | "unregister"
  | "listAgents"
  | "sendMessage"
  | "inbox"
  | "acknowledgeMessage"
  | "createJob"
  | "emitJobEvent"
  | "getJob"
  | "listJobs"
  | "jobEvents"
  | "acquireLease"
  | "renewLease"
  | "releaseLease"
  | "enqueueIntegration"
  | "claimIntegration"
  | "renewIntegration"
  | "completeIntegration"
  | "refreshIntegration"
  | "cancelIntegration"
  | "getIntegration"
  | "listIntegrations";

type AsyncCapable<T> = T extends (...args: infer TArgs) => infer TResult
  ? (...args: TArgs) => TResult | Promise<Awaited<TResult>>
  : never;

/** One MCP contract over either the local store or an authenticated Hub Node. */
export type CoordinationBackend = {
  readonly heartbeatTimeoutMs: number;
} & {
  [TMethod in CoordinationBackendMethod]: AsyncCapable<
    CoordinationService[TMethod]
  >;
};

export function createMcpServer(service: CoordinationBackend): McpServer {
  const server = new McpServer(
    {
      name: "agentconduit",
      version: "0.1.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "server.info",
    {
      title: "AgentConduit server information",
      description: "Return the protocol version and coordination guarantees.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(() => ({
      name: "agentconduit",
      version: "0.1.0",
      protocol: "agentconduit.v1",
      heartbeatTimeoutMs: service.heartbeatTimeoutMs,
      guarantees: [
        "durable_messages",
        "server_discovered_git",
        "exclusive_leases",
        "renewable_integration_leases",
        "durable_job_events",
        "cursor_replay",
      ],
      limitations: [
        "raw_git_is_outside_broker",
        "notifications_are_not_required_for_correctness",
      ],
    })),
  );

  server.registerTool(
    "workspace.discover",
    {
      title: "Discover Git workspace",
      description:
        "Inspect the real Git repository, worktree, branch, HEAD, and dirty state for a path.",
      inputSchema: { workspacePath: workspacePathSchema },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(({ workspacePath }: { workspacePath: string }) =>
      service.discover(workspacePath),
    ),
  );

  server.registerTool(
    "workspace.register",
    {
      title: "Register Git workspace",
      description:
        "Discover and persist the real Git workspace without registering an agent session.",
      inputSchema: { workspacePath: workspacePathSchema },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    guarded(({ workspacePath }: { workspacePath: string }) =>
      service.registerWorkspace(workspacePath),
    ),
  );

  server.registerTool(
    "workspace.list",
    {
      title: "List registered workspaces",
      description:
        "List Git worktree snapshots known to this broker, optionally within one repository scope.",
      inputSchema: { repositoryId: repositoryIdSchema.optional() },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(({ repositoryId }: { repositoryId?: string }) =>
      service.listWorkspaces(repositoryId),
    ),
  );

  server.registerTool(
    "agent.register",
    {
      title: "Register coding agent",
      description:
        "Register an agent session and the Git workspace it is actually using.",
      inputSchema: {
        runtime: runtimeSchema.describe(
          "Client/runtime identifier such as claude-code, codex, or another provider",
        ),
        workspacePath: workspacePathSchema,
        sessionRef: z.string().trim().min(1).max(512).optional(),
        sessionToken: sessionTokenSchema
          .optional()
          .describe("Prior token when reconnecting the same sessionRef"),
        displayName: z.string().trim().min(1).max(128).optional(),
        capabilities: z
          .array(z.string().trim().min(1).max(64))
          .max(32)
          .optional(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        runtime,
        workspacePath,
        sessionRef,
        sessionToken,
        displayName,
        capabilities,
      }: {
        runtime: string;
        workspacePath: string;
        sessionRef?: string;
        sessionToken?: string;
        displayName?: string;
        capabilities?: string[];
      }) =>
        service.register({
          runtime,
          workspacePath,
          ...(sessionRef ? { sessionRef } : {}),
          ...(sessionToken ? { sessionToken } : {}),
          ...(displayName ? { displayName } : {}),
          ...(capabilities ? { capabilities } : {}),
        }),
    ),
  );

  server.registerTool(
    "agent.heartbeat",
    {
      title: "Heartbeat agent",
      description:
        "Refresh agent presence and re-discover its current Git workspace.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        workspacePath: workspacePathSchema,
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        agentId,
        sessionToken,
        workspacePath,
      }: {
        agentId: string;
        sessionToken: string;
        workspacePath: string;
      }) => service.heartbeat(agentId, sessionToken, workspacePath),
    ),
  );

  server.registerTool(
    "agent.unregister",
    {
      title: "Unregister agent",
      description:
        "Mark an agent session offline and release its active leases.",
      inputSchema: { agentId: agentIdSchema, sessionToken: sessionTokenSchema },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        agentId,
        sessionToken,
      }: {
        agentId: string;
        sessionToken: string;
      }) => {
        service.unregister(agentId, sessionToken);
        return { agentId, status: "unregistered" };
      },
    ),
  );

  server.registerTool(
    "agent.list",
    {
      title: "List agents",
      description:
        "List online and stale agents known to this repository scope.",
      inputSchema: {
        repositoryId: repositoryIdSchema.optional(),
        includeOffline: z.boolean().optional(),
        activeOnly: z
          .boolean()
          .optional()
          .describe("Return only agents with a fresh online heartbeat"),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(
      ({
        repositoryId,
        includeOffline,
        activeOnly,
      }: {
        repositoryId?: string;
        includeOffline?: boolean;
        activeOnly?: boolean;
      }) =>
        service.listAgents(
          repositoryId,
          includeOffline ?? false,
          activeOnly ?? false,
        ),
    ),
  );

  server.registerTool(
    "message.send",
    {
      title: "Send agent message",
      description:
        "Deliver a durable, acknowledged message to another agent in the same repository scope.",
      inputSchema: {
        senderAgentId: agentIdSchema,
        senderSessionToken: sessionTokenSchema,
        recipientAgentId: agentIdSchema,
        body: z
          .string()
          .min(1)
          .max(32 * 1024),
        correlationId: z.string().trim().min(1).max(256).optional(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        senderAgentId,
        senderSessionToken,
        recipientAgentId,
        body,
        correlationId,
      }: {
        senderAgentId: string;
        senderSessionToken: string;
        recipientAgentId: string;
        body: string;
        correlationId?: string;
      }) =>
        service.sendMessage(
          senderAgentId,
          senderSessionToken,
          recipientAgentId,
          body,
          correlationId,
        ),
    ),
  );

  server.registerTool(
    "message.inbox",
    {
      title: "Read agent inbox",
      description:
        "Read durable messages addressed to an agent; polling is the portable delivery mechanism.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        includeAcknowledged: z.boolean().optional(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(
      ({
        agentId,
        sessionToken,
        includeAcknowledged,
      }: {
        agentId: string;
        sessionToken: string;
        includeAcknowledged?: boolean;
      }) => service.inbox(agentId, sessionToken, includeAcknowledged ?? false),
    ),
  );

  server.registerTool(
    "message.ack",
    {
      title: "Acknowledge agent message",
      description: "Acknowledge one message after processing it.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        messageId: z.string().regex(/^msg_[0-9a-f]{32}$/),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        agentId,
        sessionToken,
        messageId,
      }: {
        agentId: string;
        sessionToken: string;
        messageId: string;
      }) => {
        service.acknowledgeMessage(agentId, sessionToken, messageId);
        return { messageId, status: "acknowledged" };
      },
    ),
  );

  server.registerTool(
    "job.create",
    {
      title: "Create durable job",
      description:
        "Create a retry-safe durable job bound to the authenticated agent's server-observed repository and worktree.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        idempotencyKey: idempotencyKeySchema,
        kind: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
        displayName: safeLineSchema(160),
        parentJobId: jobIdSchema.optional(),
        correlationId: safeLineSchema(128).optional(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    guarded(
      ({
        agentId,
        sessionToken,
        idempotencyKey,
        kind,
        displayName,
        parentJobId,
        correlationId,
      }: {
        agentId: string;
        sessionToken: string;
        idempotencyKey: string;
        kind: string;
        displayName: string;
        parentJobId?: string;
        correlationId?: string;
      }) =>
        service.createJob(agentId, sessionToken, {
          idempotencyKey,
          kind,
          displayName,
          ...(parentJobId ? { parentJobId } : {}),
          ...(correlationId ? { correlationId } : {}),
        }),
    ),
  );

  server.registerTool(
    "job.emit",
    {
      title: "Emit durable job event",
      description:
        "Append one retry-safe normalized event. Use heartbeat only for liveness and checkpoint only for meaningful bounded progress; never send prompts, secrets, raw streams, or hidden reasoning.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        jobId: jobIdSchema,
        idempotencyKey: idempotencyKeySchema,
        type: jobEventTypeSchema,
        phase: safeLineSchema(128).optional(),
        summary: safeLineSchema(512).optional(),
        operation: safeLineSchema(128).optional(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    guarded(
      ({
        agentId,
        sessionToken,
        jobId,
        idempotencyKey,
        type,
        phase,
        summary,
        operation,
      }: {
        agentId: string;
        sessionToken: string;
        jobId: string;
        idempotencyKey: string;
        type: JobEventInput["type"];
        phase?: string;
        summary?: string;
        operation?: string;
      }) =>
        service.emitJobEvent(agentId, sessionToken, jobId, {
          idempotencyKey,
          type,
          ...(phase ? { phase } : {}),
          ...(summary ? { summary } : {}),
          ...(operation ? { operation } : {}),
        }),
    ),
  );

  server.registerTool(
    "job.get",
    {
      title: "Get durable job",
      description:
        "Read one job in the authenticated agent's repository scope, including derived activity.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        jobId: jobIdSchema,
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(
      ({
        agentId,
        sessionToken,
        jobId,
      }: {
        agentId: string;
        sessionToken: string;
        jobId: string;
      }) => service.getJob(agentId, sessionToken, jobId),
    ),
  );

  server.registerTool(
    "job.list",
    {
      title: "List durable jobs",
      description:
        "List jobs in the authenticated agent's repository scope with optional lifecycle filters.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        statuses: z.array(jobStatusSchema).max(6).optional(),
        activity: jobActivitySchema.optional(),
        ownerAgentId: agentIdSchema.optional(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(
      ({
        agentId,
        sessionToken,
        statuses,
        activity,
        ownerAgentId,
      }: {
        agentId: string;
        sessionToken: string;
        statuses?: JobStatus[];
        activity?: JobActivity;
        ownerAgentId?: string;
      }) =>
        service.listJobs(agentId, sessionToken, {
          ...(statuses ? { statuses } : {}),
          ...(activity ? { activity } : {}),
          ...(ownerAgentId ? { ownerAgentId } : {}),
        }),
    ),
  );

  server.registerTool(
    "job.events",
    {
      title: "Replay durable job events",
      description:
        "Read an ordered bounded page of normalized job events after a global cursor.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        jobId: jobIdSchema,
        afterCursor: z.number().int().nonnegative().safe().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(
      ({
        agentId,
        sessionToken,
        jobId,
        afterCursor,
        limit,
      }: {
        agentId: string;
        sessionToken: string;
        jobId: string;
        afterCursor?: number;
        limit?: number;
      }) =>
        service.jobEvents(
          agentId,
          sessionToken,
          jobId,
          afterCursor ?? 0,
          limit ?? 100,
        ),
    ),
  );

  server.registerTool(
    "lease.acquire",
    {
      title: "Acquire coordination lease",
      description:
        "Acquire an exclusive, expiring lease for a narrowly scoped shared resource.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        resource: z.string().trim().min(1).max(512),
        ttlSeconds: z.number().int().min(1).max(900).optional(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        agentId,
        sessionToken,
        resource,
        ttlSeconds,
      }: {
        agentId: string;
        sessionToken: string;
        resource: string;
        ttlSeconds?: number;
      }) =>
        service.acquireLease(
          agentId,
          sessionToken,
          resource,
          ttlSeconds ?? 300,
        ),
    ),
  );

  server.registerTool(
    "lease.renew",
    {
      title: "Renew coordination lease",
      description: "Renew an unexpired lease held by this agent.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        leaseId: z.string().regex(/^lea_[0-9a-f]{32}$/),
        ttlSeconds: z.number().int().min(1).max(900).optional(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        agentId,
        sessionToken,
        leaseId,
        ttlSeconds,
      }: {
        agentId: string;
        sessionToken: string;
        leaseId: string;
        ttlSeconds?: number;
      }) =>
        service.renewLease(agentId, sessionToken, leaseId, ttlSeconds ?? 300),
    ),
  );

  server.registerTool(
    "lease.release",
    {
      title: "Release coordination lease",
      description: "Release a lease held by this agent.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        leaseId: z.string().regex(/^lea_[0-9a-f]{32}$/),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        agentId,
        sessionToken,
        leaseId,
      }: {
        agentId: string;
        sessionToken: string;
        leaseId: string;
      }) => {
        service.releaseLease(agentId, sessionToken, leaseId);
        return { leaseId, status: "released" };
      },
    ),
  );

  server.registerTool(
    "integration.enqueue",
    {
      title: "Queue integration request",
      description:
        "Record a Git integration request after server-side resolution of source and target refs.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        workspacePath: workspacePathSchema,
        sourceRef: refSchema,
        targetRef: refSchema,
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        agentId,
        sessionToken,
        workspacePath,
        sourceRef,
        targetRef,
      }: {
        agentId: string;
        sessionToken: string;
        workspacePath: string;
        sourceRef: string;
        targetRef: string;
      }) =>
        service.enqueueIntegration(
          agentId,
          sessionToken,
          workspacePath,
          sourceRef,
          targetRef,
        ),
    ),
  );

  server.registerTool(
    "integration.claim",
    {
      title: "Claim integration request",
      description:
        "Claim the FIFO integration request only if its source and target refs are still at their observed OIDs; the response includes an expiring lease.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        requestId: z.string().regex(/^int_[0-9a-f]{32}$/),
        workspacePath: workspacePathSchema,
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        agentId,
        sessionToken,
        requestId,
        workspacePath,
      }: {
        agentId: string;
        sessionToken: string;
        requestId: string;
        workspacePath: string;
      }) =>
        service.claimIntegration(
          agentId,
          sessionToken,
          requestId,
          workspacePath,
        ),
    ),
  );

  server.registerTool(
    "integration.renew",
    {
      title: "Renew integration request",
      description:
        "Renew the expiring target-ref lease for an integration request owned by this claimant.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        requestId: z.string().regex(/^int_[0-9a-f]{32}$/),
        workspacePath: workspacePathSchema,
        ttlSeconds: z.number().int().min(1).max(900).optional(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        agentId,
        sessionToken,
        requestId,
        workspacePath,
        ttlSeconds,
      }: {
        agentId: string;
        sessionToken: string;
        requestId: string;
        workspacePath: string;
        ttlSeconds?: number;
      }) =>
        service.renewIntegration(
          agentId,
          sessionToken,
          requestId,
          workspacePath,
          ttlSeconds ?? 300,
        ),
    ),
  );

  server.registerTool(
    "integration.refresh",
    {
      title: "Refresh integration request",
      description:
        "Re-resolve source and target refs after the target moved, returning the request to the queue.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        requestId: z.string().regex(/^int_[0-9a-f]{32}$/),
        workspacePath: workspacePathSchema,
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        agentId,
        sessionToken,
        requestId,
        workspacePath,
      }: {
        agentId: string;
        sessionToken: string;
        requestId: string;
        workspacePath: string;
      }) =>
        service.refreshIntegration(
          agentId,
          sessionToken,
          requestId,
          workspacePath,
        ),
    ),
  );

  server.registerTool(
    "integration.complete",
    {
      title: "Complete integration request",
      description:
        "Record the outcome of a claimed integration and release its lease.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        requestId: z.string().regex(/^int_[0-9a-f]{32}$/),
        workspacePath: workspacePathSchema,
        outcome: z.enum([
          "merged",
          "rebased",
          "squashed",
          "failed",
          "cancelled",
        ]),
        postTargetOid: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/i)
          .optional(),
        note: z.string().max(2000).optional(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        agentId,
        sessionToken,
        requestId,
        workspacePath,
        outcome,
        postTargetOid,
        note,
      }: {
        agentId: string;
        sessionToken: string;
        requestId: string;
        workspacePath: string;
        outcome: "merged" | "rebased" | "squashed" | "failed" | "cancelled";
        postTargetOid?: string;
        note?: string;
      }) =>
        service.completeIntegration(
          agentId,
          sessionToken,
          requestId,
          workspacePath,
          {
            outcome,
            ...(postTargetOid ? { postTargetOid } : {}),
            ...(note ? { note } : {}),
          },
        ),
    ),
  );

  server.registerTool(
    "integration.cancel",
    {
      title: "Cancel integration request",
      description:
        "Cancel a queued or claimed integration request as its requester or claimant.",
      inputSchema: {
        agentId: agentIdSchema,
        sessionToken: sessionTokenSchema,
        requestId: z.string().regex(/^int_[0-9a-f]{32}$/),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
    },
    guarded(
      ({
        agentId,
        sessionToken,
        requestId,
      }: {
        agentId: string;
        sessionToken: string;
        requestId: string;
      }) => service.cancelIntegration(agentId, sessionToken, requestId),
    ),
  );

  server.registerTool(
    "integration.get",
    {
      title: "Get integration request",
      description:
        "Read one integration request and its current lease/queue state.",
      inputSchema: { requestId: z.string().regex(/^int_[0-9a-f]{32}$/) },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    guarded(({ requestId }: { requestId: string }) =>
      service.getIntegration(requestId),
    ),
  );

  server.registerTool(
    "integration.list",
    {
      title: "List integration requests",
      description:
        "List queued, claimed, and completed integration requests for a repository or target ref.",
      inputSchema: {
        repositoryId: z
          .string()
          .regex(/^repo_[0-9a-f]{32}$/)
          .optional(),
        targetRef: refSchema.optional(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    guarded(
      ({
        repositoryId,
        targetRef,
      }: {
        repositoryId?: string;
        targetRef?: string;
      }) => service.listIntegrations(repositoryId, targetRef),
    ),
  );

  return server;
}

export { SERVER_INSTRUCTIONS };
