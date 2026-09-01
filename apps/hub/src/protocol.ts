import {
  AGENTCONDUIT_NODE_PROTOCOL,
  type NodeRpcOperation,
  type NodeRpcOperations,
  type NodeRpcRequest,
} from "@agentconduit/core";
import * as z from "zod/v4";

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const oid = z.string().regex(/^[0-9a-f]{40,64}$/i);
const repositoryId = z.string().regex(/^repo_[0-9a-f]{32}$/);
const worktreeId = z.string().regex(/^wt_[0-9a-f]{32}$/);
const agentId = z.string().regex(/^agt_[0-9a-f]{32}$/);
const sessionToken = z.string().regex(/^acs_[0-9a-f]{64}$/);
const leaseId = z.string().regex(/^lea_[0-9a-f]{32}$/);
const integrationId = z.string().regex(/^int_[0-9a-f]{32}$/);
const messageId = z.string().regex(/^(?:msg|opm)_[0-9a-f]{32}$/);
const jobId = z.string().regex(/^job_[0-9a-f]{32}$/);
const collectionCursor = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const eventCursor = z.string().regex(/^(?:0|[1-9][0-9]{0,15})$/);
const capabilities = z.array(text(64)).max(32);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const safeLine = (maximumBytes: number) =>
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
const jobStatus = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);
const jobActivity = z.enum(["active", "stale", "terminal"]);
const jobCreate = z
  .object({
    idempotencyKey,
    kind: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    displayName: safeLine(160),
    parentJobId: jobId.optional(),
    correlationId: safeLine(128).optional(),
  })
  .strict();
const jobEvent = z
  .object({
    idempotencyKey,
    type: z.enum([
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
    ]),
    phase: safeLine(128).optional(),
    summary: safeLine(512).optional(),
    operation: safeLine(128).optional(),
  })
  .strict();

const upstream = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      ref: text(512),
      ahead: z.number().int().nonnegative(),
      behind: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      ref: text(512).optional(),
    })
    .strict(),
]);

const workspaceSnapshot = z
  .object({
    repositoryId,
    projectId: text(128),
    worktreeId,
    rootPath: text(512),
    commonGitDir: text(512),
    gitDir: text(512),
    remoteUrl: text(2_048).optional(),
    branch: text(512).optional(),
    headOid: oid,
    dirty: z.boolean(),
    upstream,
    isBare: z.boolean(),
    observedAt: text(64),
  })
  .strict();

const workspace = z
  .object({ snapshot: workspaceSnapshot, pathLabel: text(128) })
  .strict();

const health = z
  .object({
    status: z.enum(["healthy", "degraded"]),
    uptimeSeconds: z.number().nonnegative().finite(),
    memoryUsedPercent: z.number().min(0).max(100).finite(),
    loadAverage1: z.number().nonnegative().finite().optional(),
  })
  .strict();

const completion = z
  .object({
    outcome: z.enum(["merged", "rebased", "squashed", "failed", "cancelled"]),
    postTargetOid: oid.optional(),
    note: text(2_000).optional(),
  })
  .strict();

const parameterSchemas: Record<NodeRpcOperation, z.ZodType> = {
  "device.heartbeat": z
    .object({ nodeVersion: text(64), capabilities, health })
    .strict(),
  "workspace.register": z.object({ workspace }).strict(),
  "workspace.list": z
    .object({
      repositoryId: repositoryId.optional(),
      cursor: collectionCursor.optional(),
    })
    .strict(),
  "agent.register": z
    .object({
      runtime: text(128),
      workspace,
      sessionRef: text(512).optional(),
      sessionToken: sessionToken.optional(),
      displayName: text(128).optional(),
      capabilities: capabilities.optional(),
    })
    .strict(),
  "agent.heartbeat": z.object({ agentId, sessionToken, workspace }).strict(),
  "agent.unregister": z.object({ agentId, sessionToken }).strict(),
  "agent.list": z
    .object({
      repositoryId: repositoryId.optional(),
      includeOffline: z.boolean().optional(),
      activeOnly: z.boolean().optional(),
      cursor: collectionCursor.optional(),
    })
    .strict(),
  "message.send": z
    .object({
      senderAgentId: agentId,
      senderSessionToken: sessionToken,
      recipientAgentId: agentId,
      body: text(32 * 1_024),
      correlationId: text(512).optional(),
    })
    .strict(),
  "message.inbox": z
    .object({
      agentId,
      sessionToken,
      includeAcknowledged: z.boolean().optional(),
      cursor: collectionCursor.optional(),
    })
    .strict(),
  "message.ack": z.object({ agentId, sessionToken, messageId }).strict(),
  "job.create": z.object({ agentId, sessionToken, input: jobCreate }).strict(),
  "job.emit": z
    .object({ agentId, sessionToken, jobId, event: jobEvent })
    .strict(),
  "job.get": z.object({ agentId, sessionToken, jobId }).strict(),
  "job.list": z
    .object({
      agentId,
      sessionToken,
      statuses: z.array(jobStatus).max(6).optional(),
      activity: jobActivity.optional(),
      ownerAgentId: agentId.optional(),
      cursor: collectionCursor.optional(),
    })
    .strict(),
  "job.events": z
    .object({
      agentId,
      sessionToken,
      jobId,
      cursor: eventCursor.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  "lease.acquire": z
    .object({
      agentId,
      sessionToken,
      resource: text(512),
      ttlSeconds: z.number().int().min(1).max(900),
    })
    .strict(),
  "lease.renew": z
    .object({
      agentId,
      sessionToken,
      leaseId,
      ttlSeconds: z.number().int().min(1).max(900),
    })
    .strict(),
  "lease.release": z.object({ agentId, sessionToken, leaseId }).strict(),
  "integration.enqueue": z
    .object({
      agentId,
      sessionToken,
      workspace,
      sourceRef: text(512),
      sourceOid: oid,
      targetRef: text(512),
      observedTargetOid: oid,
    })
    .strict(),
  "integration.claim": z
    .object({
      agentId,
      sessionToken,
      requestId: integrationId,
      workspace,
      currentSourceOid: oid,
      currentTargetOid: oid,
    })
    .strict(),
  "integration.renew": z
    .object({
      agentId,
      sessionToken,
      requestId: integrationId,
      workspace,
      ttlSeconds: z.number().int().min(1).max(900).optional(),
    })
    .strict(),
  "integration.refresh": z
    .object({
      agentId,
      sessionToken,
      requestId: integrationId,
      workspace,
      sourceOid: oid,
      observedTargetOid: oid,
    })
    .strict(),
  "integration.complete": z
    .object({
      agentId,
      sessionToken,
      requestId: integrationId,
      workspace,
      completion,
      currentTargetOid: oid.optional(),
    })
    .strict(),
  "integration.cancel": z
    .object({ agentId, sessionToken, requestId: integrationId })
    .strict(),
  "integration.get": z.object({ requestId: integrationId }).strict(),
  "integration.list": z
    .object({
      repositoryId: repositoryId.optional(),
      targetRef: text(512).optional(),
      cursor: collectionCursor.optional(),
    })
    .strict(),
};

const envelope = z
  .object({
    protocol: z.literal(AGENTCONDUIT_NODE_PROTOCOL),
    operation: z.enum(
      Object.keys(parameterSchemas) as [
        NodeRpcOperation,
        ...NodeRpcOperation[],
      ],
    ),
    params: z.unknown(),
  })
  .strict();

export function parseNodeRpcRequest(value: unknown): NodeRpcRequest {
  const parsed = envelope.parse(value);
  const params = parameterSchemas[parsed.operation].parse(parsed.params);
  return {
    protocol: AGENTCONDUIT_NODE_PROTOCOL,
    operation: parsed.operation,
    params,
  } as NodeRpcRequest;
}

export const enrollmentRequestSchema = z
  .object({
    enrollmentCode: z.string().regex(/^ace_[0-9a-f]{48}$/),
    name: text(128),
    platform: text(64),
    architecture: text(64),
    nodeVersion: text(64),
    capabilities,
    health,
  })
  .strict();

export const ownerLoginSchema = z.object({ token: text(512) }).strict();
export const createEnrollmentSchema = z
  .object({ nameHint: text(128).optional() })
  .strict();
export const operatorMessageSchema = z
  .object({ recipientAgentId: agentId, body: text(32 * 1_024) })
  .strict();
export const revokeDeviceSchema = z
  .object({ deviceId: z.string().regex(/^dev_[0-9a-f]{32}$/) })
  .strict();
export const cancelIntegrationSchema = z
  .object({ requestId: integrationId })
  .strict();
export const reconciliationSchema = z
  .object({ agentId, reason: text(1_000) })
  .strict();

export type ParsedNodeParams<TOperation extends NodeRpcOperation> =
  NodeRpcOperations[TOperation]["params"];
