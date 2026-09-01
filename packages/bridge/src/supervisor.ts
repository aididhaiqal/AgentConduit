import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import type {
  AgentRecord,
  AgentRegistration,
  MessageRecord,
} from "@agentconduit/core";
import {
  digestSessionRef,
  FileOwnershipStore,
  inspectOwnership,
  newBridgeOwnerId,
  type BridgeOwnershipRecord,
} from "./ownership.js";
import type {
  BridgeEvent,
  BridgeEventInput,
  BridgeMessageContext,
  BridgeSnapshot,
  BridgeStopOptions,
  BridgeSupervisorOptions,
  BridgeState,
  MessageDisposition,
  OwnedRuntimeAdapter,
} from "./model.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_BROKER_HEARTBEAT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_MESSAGES_PER_POLL = 100;

type BrokerLifecycle =
  "not_attempted" | "registered" | "unregistered" | "unknown";
type CallbackContext = "startup" | "message" | "runtime";

interface ActiveCallbackContext {
  kind: CallbackContext;
  /**
   * AsyncLocalStorage propagates through timers and microtasks. Keep an
   * explicit stack bit so a callback-created descendant cannot later be
   * mistaken for an invocation that is still on the callback stack. `pending`
   * covers an async callback whose returned promise has not settled yet.
   */
  active: boolean;
  pending: boolean;
}

function nowIso(clock: () => number): string {
  return new Date(clock()).toISOString();
}

/** Treat a wall-clock rollback as an expired observation, never as freshness. */
function elapsedSince(now: number, then: number): number {
  return now >= then ? now - then : Number.POSITIVE_INFINITY;
}

function safeErrorMessage(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  const message = error instanceof Error ? error.message : String(error);
  return secrets
    .reduce(
      (result, secret) =>
        secret ? result.split(secret).join("[redacted]") : result,
      message,
    )
    .slice(0, 2_000);
}

function validateInterval(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer in milliseconds`);
  }
  return value;
}

function validateRegistration(
  registration: BridgeSupervisorOptions["registration"],
): void {
  if (!registration.runtime.trim() || registration.runtime.length > 128) {
    throw new Error("registration.runtime must be 1-128 characters");
  }
  if (
    !registration.workspacePath.trim() ||
    !isAbsolute(registration.workspacePath)
  ) {
    throw new Error("registration.workspacePath must be an absolute path");
  }
  if (registration.sessionRef !== undefined) {
    if (
      !registration.sessionRef.trim() ||
      registration.sessionRef.length > 512
    ) {
      throw new Error("registration.sessionRef must be 1-512 characters");
    }
  }
  if (registration.sessionToken !== undefined) {
    if (!registration.sessionRef) {
      throw new Error(
        "registration.sessionRef is required when resuming a session",
      );
    }
    if (!/^acs_[0-9a-f]{64}$/.test(registration.sessionToken)) {
      throw new Error("registration.sessionToken has an invalid format");
    }
  }
}

function validateAdapter(adapter: OwnedRuntimeAdapter | undefined): void {
  if (!adapter) return;
  if (!adapter.name.trim() || adapter.name.length > 128) {
    throw new Error("runtimeAdapter.name must be 1-128 characters");
  }
  if (!adapter.identity.id.trim() || adapter.identity.id.length > 512) {
    throw new Error("runtimeAdapter.identity.id must be 1-512 characters");
  }
}

function disposition(value: unknown): MessageDisposition {
  return value === "acknowledge" ? "acknowledge" : "defer";
}

/**
 * Supervises one explicitly registered AgentConduit session. The supervisor
 * deliberately keeps the private session token in a private field and never
 * includes it in snapshots, events, ownership files, or error details.
 */
export class BridgeSupervisor {
  readonly ownerId: string;
  readonly heartbeatIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly maxMessagesPerPoll: number;
  readonly brokerHeartbeatTimeoutMs: number;

  private readonly client: BridgeSupervisorOptions["client"];
  private readonly registrationOptions: BridgeSupervisorOptions["registration"];
  private readonly onMessage: BridgeSupervisorOptions["onMessage"];
  private readonly onPrivateRegistration:
    BridgeSupervisorOptions["onPrivateRegistration"] | undefined;
  private readonly runtimeAdapter: OwnedRuntimeAdapter | undefined;
  private readonly onEvent: BridgeSupervisorOptions["onEvent"];
  private readonly clock: () => number;
  private readonly ownership: FileOwnershipStore | undefined;
  private readonly ownsClient: boolean;
  private readonly effectiveSessionRef: string;
  /** The smaller of the configured cap and the broker-observed timeout. */
  private effectiveBrokerHeartbeatTimeoutMs: number;

  private stateValue: BridgeState = "idle";
  private registration: AgentRegistration | undefined;
  private lastAgentStatus: AgentRecord["status"] | undefined;
  private lastHeartbeatAtMs: number | undefined;
  private lastPollAtMs: number | undefined;
  private lastError: string | undefined;
  /**
   * `unknown` is deliberately sticky until a forced, authenticated
   * unregister succeeds. It covers lost responses and broker disconnects.
   */
  private brokerLifecycle: BrokerLifecycle = "not_attempted";
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private cyclePromise: Promise<void> | undefined;
  private stopPromise: Promise<BridgeSnapshot> | undefined;
  /** Serialize start/stop so a shutdown cannot race registration. */
  private lifecycleTail: Promise<void> = Promise.resolve();
  /** Serialize protected ownership-file writes in invocation order. */
  private ownershipTail: Promise<void> = Promise.resolve();
  /** Broker operations that a graceful shutdown must let settle first. */
  private readonly inFlightOperations = new Set<Promise<void>>();
  private readonly callbackContext =
    new AsyncLocalStorage<ActiveCallbackContext>();
  private stopRequested = false;
  private startupInProgress = false;
  /** A fail-closed operation observed while startup was still in progress. */
  private startupFailure: Error | undefined;
  private ownershipRecord: BridgeOwnershipRecord | undefined;
  private readonly handlerAttempts = new Map<string, number>();
  private readonly pushedMessages = new Set<string>();
  private readonly pendingAcknowledgements = new Map<string, MessageRecord>();
  private adapterDisabled = false;
  private cyclePhase: "heartbeat" | "inbox" | "ack" = "heartbeat";

  constructor(options: BridgeSupervisorOptions) {
    validateRegistration(options.registration);
    validateAdapter(options.runtimeAdapter);
    this.client = options.client;
    this.registrationOptions = {
      runtime: options.registration.runtime.trim(),
      workspacePath: options.registration.workspacePath.trim(),
      ...(options.registration.sessionRef !== undefined
        ? { sessionRef: options.registration.sessionRef.trim() }
        : {}),
      ...(options.registration.sessionToken !== undefined
        ? { sessionToken: options.registration.sessionToken }
        : {}),
      ...(options.registration.displayName !== undefined
        ? { displayName: options.registration.displayName.trim() }
        : {}),
      ...(options.registration.capabilities !== undefined
        ? { capabilities: [...options.registration.capabilities] }
        : {}),
    };
    this.onMessage = options.onMessage;
    this.onPrivateRegistration = options.onPrivateRegistration;
    this.runtimeAdapter = options.runtimeAdapter;
    this.onEvent = options.onEvent;
    this.clock = options.clock ?? Date.now;
    this.heartbeatIntervalMs = validateInterval(
      "heartbeatIntervalMs",
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    this.pollIntervalMs = validateInterval(
      "pollIntervalMs",
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
    this.maxMessagesPerPoll =
      options.maxMessagesPerPoll ?? DEFAULT_MAX_MESSAGES_PER_POLL;
    if (
      !Number.isInteger(this.maxMessagesPerPoll) ||
      this.maxMessagesPerPoll < 1 ||
      this.maxMessagesPerPoll > 1_000
    ) {
      throw new Error("maxMessagesPerPoll must be an integer from 1-1000");
    }
    this.brokerHeartbeatTimeoutMs = validateInterval(
      "brokerHeartbeatTimeoutMs",
      options.brokerHeartbeatTimeoutMs ?? DEFAULT_BROKER_HEARTBEAT_TIMEOUT_MS,
    );
    if (this.heartbeatIntervalMs >= this.brokerHeartbeatTimeoutMs) {
      throw new Error(
        "heartbeatIntervalMs must be shorter than brokerHeartbeatTimeoutMs",
      );
    }
    this.effectiveBrokerHeartbeatTimeoutMs = this.brokerHeartbeatTimeoutMs;
    this.ownerId = newBridgeOwnerId();
    this.effectiveSessionRef = this.registrationOptions.sessionToken
      ? this.registrationOptions.sessionRef!
      : `${this.registrationOptions.sessionRef ?? "agentconduit-bridge"}-${this.ownerId}`;
    if (this.effectiveSessionRef.length > 512) {
      throw new Error(
        "effective bridge session reference exceeds 512 characters",
      );
    }
    this.ownership = options.ownershipFile
      ? new FileOwnershipStore(options.ownershipFile)
      : undefined;
    this.ownsClient = options.ownsClient ?? false;
  }

  get state(): BridgeState {
    return this.stateValue;
  }

  private errorMessage(error: unknown): string {
    return safeErrorMessage(error, [
      this.registration?.sessionToken ?? "",
      this.registrationOptions.sessionToken ?? "",
    ]);
  }

  /**
   * Calibrate local presence against the actual broker when the client can
   * inspect `server.info`. A stale local configuration must never make the
   * bridge claim to be active after the broker has already aged it out.
   */
  private async observeBrokerHeartbeatTimeout(): Promise<void> {
    if (!this.client.serverInfo) return;
    const info = await this.client.serverInfo();
    if (
      !Number.isSafeInteger(info.heartbeatTimeoutMs) ||
      info.heartbeatTimeoutMs < 1
    ) {
      throw new Error(
        "broker server.info returned an invalid heartbeat timeout",
      );
    }
    if (this.heartbeatIntervalMs >= info.heartbeatTimeoutMs) {
      throw new Error(
        "heartbeatIntervalMs must be shorter than the broker heartbeat timeout reported by server.info",
      );
    }
    this.effectiveBrokerHeartbeatTimeoutMs = Math.min(
      this.brokerHeartbeatTimeoutMs,
      info.heartbeatTimeoutMs,
    );
  }

  /** A token-free view suitable for logs and host status panels. */
  snapshot(): BridgeSnapshot {
    const now = this.clock();
    const heartbeatFresh =
      this.lastHeartbeatAtMs !== undefined &&
      elapsedSince(now, this.lastHeartbeatAtMs) <=
        this.effectiveBrokerHeartbeatTimeoutMs;
    const active =
      this.stateValue === "running" &&
      heartbeatFresh &&
      this.lastAgentStatus === "online";
    return {
      ownerId: this.ownerId,
      state: this.stateValue,
      active,
      ...(this.registration
        ? {
            brokerStatus:
              this.brokerLifecycle === "unregistered"
                ? ("unregistered" as const)
                : this.brokerLifecycle === "registered" &&
                    this.stateValue !== "degraded" &&
                    this.stateValue !== "failed"
                  ? ("registered" as const)
                  : ("unknown" as const),
          }
        : {}),
      ...(this.registration ? { agentId: this.registration.agentId } : {}),
      ...(this.registration ? { sessionRef: this.effectiveSessionRef } : {}),
      ...(this.registration
        ? { repositoryId: this.registration.workspace.repositoryId }
        : {}),
      ...(this.registration
        ? { worktreeId: this.registration.workspace.worktreeId }
        : {}),
      ...(this.lastAgentStatus ? { agentStatus: this.lastAgentStatus } : {}),
      ...(this.lastHeartbeatAtMs !== undefined
        ? { lastHeartbeatAt: new Date(this.lastHeartbeatAtMs).toISOString() }
        : {}),
      ...(this.lastPollAtMs !== undefined
        ? { lastPollAt: new Date(this.lastPollAtMs).toISOString() }
        : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private emit(event: BridgeEventInput): void {
    try {
      this.runSynchronousCallback("runtime", () => {
        this.onEvent?.({ ...event, at: nowIso(this.clock) } as BridgeEvent);
      });
    } catch {
      // An observer must never be able to interrupt coordination.
    }
  }

  /**
   * Run a synchronous observer callback and clear its re-entrancy marker
   * before any callback-created microtask can run.
   */
  private runSynchronousCallback<T>(
    kind: CallbackContext,
    callback: () => T,
  ): T {
    const context: ActiveCallbackContext = {
      kind,
      active: true,
      pending: false,
    };
    try {
      return this.callbackContext.run(context, callback);
    } finally {
      context.active = false;
    }
  }

  /**
   * Run an async callback while it is awaiting. The synchronous callback stack
   * ends immediately, while `pending` remains true until a returned thenable
   * settles so an in-callback `stop()` cannot deadlock the lifecycle.
   */
  private runCallback<T>(
    kind: CallbackContext,
    callback: () => T | PromiseLike<T>,
  ): Promise<Awaited<T>> {
    const context: ActiveCallbackContext = {
      kind,
      active: true,
      pending: true,
    };
    let result: T | PromiseLike<T>;
    try {
      result = this.callbackContext.run(context, callback);
    } catch (error) {
      context.active = false;
      context.pending = false;
      return Promise.reject(error);
    }
    // The callback's synchronous stack has returned even when it handed us a
    // pending promise. This lets a later timer/microtask be distinguished from
    // a direct in-callback shutdown request.
    context.active = false;
    let isThenable = false;
    try {
      isThenable =
        Boolean(result) &&
        typeof (result as PromiseLike<T>).then === "function";
    } catch (error) {
      context.pending = false;
      return Promise.reject(error);
    }
    if (!isThenable) {
      context.pending = false;
      return Promise.resolve(result as Awaited<T>);
    }
    return Promise.resolve(result).finally(() => {
      context.pending = false;
    }) as Promise<Awaited<T>>;
  }

  private setState(state: BridgeState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.emit({ type: "state", state });
  }

  /** Queue lifecycle mutations while allowing failures to propagate locally. */
  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Track an operation that may be called by a host while the bridge is
   * running. The marker is installed before invoking the operation, so stop()
   * cannot unregister or close the client underneath an in-flight call.
   */
  private trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const marker = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.inFlightOperations.add(marker);
    let run: Promise<T>;
    try {
      run = Promise.resolve(operation());
    } catch (error) {
      run = Promise.reject(error);
    }
    void run.then(
      () => {
        this.inFlightOperations.delete(marker);
        release();
      },
      () => {
        this.inFlightOperations.delete(marker);
        release();
      },
    );
    return run;
  }

  private async waitForOperations(): Promise<void> {
    while (this.inFlightOperations.size > 0) {
      const pending = [...this.inFlightOperations];
      await Promise.all(pending);
    }
  }

  private baseOwnershipRecord(): BridgeOwnershipRecord {
    const timestamp = nowIso(this.clock);
    return {
      schemaVersion: 1,
      ownerId: this.ownerId,
      state: "running",
      pid: process.pid,
      runtime: this.registrationOptions.runtime,
      sessionRefDigest: digestSessionRef(this.effectiveSessionRef),
      workspacePath: this.registrationOptions.workspacePath,
      startedAt: timestamp,
      updatedAt: timestamp,
      ...(this.runtimeAdapter ? { adapterName: this.runtimeAdapter.name } : {}),
      ...(this.runtimeAdapter?.version
        ? { adapterVersion: this.runtimeAdapter.version }
        : {}),
    };
  }

  private async persistOwnership(
    patch: Partial<BridgeOwnershipRecord>,
  ): Promise<void> {
    if (!this.ownership) return;
    const run = this.ownershipTail.then(async () => {
      const current = this.ownershipRecord ?? this.baseOwnershipRecord();
      const next: BridgeOwnershipRecord = {
        ...current,
        ...patch,
        schemaVersion: 1,
        ownerId: this.ownerId,
        updatedAt: nowIso(this.clock),
      };
      this.ownershipRecord = next;
      await this.ownership!.write(next);
    });
    this.ownershipTail = run.catch(() => undefined);
    await run;
  }

  private registrationInput(): {
    runtime: string;
    workspacePath: string;
    sessionRef: string;
    sessionToken?: string;
    displayName?: string;
    capabilities?: string[];
  } {
    const input = this.registrationOptions;
    return {
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      sessionRef: this.effectiveSessionRef,
      ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.capabilities ? { capabilities: [...input.capabilities] } : {}),
    };
  }

  private requireRegistration(): AgentRegistration {
    if (!this.registration || !this.registration.sessionToken) {
      throw new Error("bridge is not registered");
    }
    return this.registration;
  }

  private async heartbeatInternal(): Promise<AgentRecord> {
    const registration = this.requireRegistration();
    const result = await this.client.heartbeat(
      registration.agentId,
      registration.sessionToken,
      this.registrationOptions.workspacePath,
    );
    this.ensureBrokerResultApplicable("heartbeat");
    if (
      result.workspace.repositoryId !== registration.workspace.repositoryId ||
      result.workspace.worktreeId !== registration.workspace.worktreeId
    ) {
      throw new Error(
        "broker heartbeat returned a different repository/worktree",
      );
    }
    this.brokerLifecycle = "registered";
    this.lastAgentStatus = result.status;
    this.lastHeartbeatAtMs = this.clock();
    this.emit({ type: "heartbeat", status: result.status });
    await this.persistOwnership({
      ...(result.workspace.repositoryId
        ? { repositoryId: result.workspace.repositoryId }
        : {}),
      ...(result.workspace.worktreeId
        ? { worktreeId: result.workspace.worktreeId }
        : {}),
      agentId: registration.agentId,
    });
    this.ensureBrokerResultApplicable("heartbeat");
    return result;
  }

  private ensureBrokerResultApplicable(operation: string): void {
    if (
      this.stateValue === "starting" ||
      this.stateValue === "running" ||
      this.stateValue === "stopping"
    )
      return;
    throw new Error(
      `bridge became inactive while ${operation} was in progress (${this.stateValue})`,
    );
  }

  /**
   * A graceful stop moves the state to `stopping` while an already-started
   * cycle drains. A fail-closed/runtime-exit transition uses `degraded` or
   * `failed`, which must cancel any remaining message work.
   */
  private canContinueCycle(): boolean {
    return this.stateValue === "running" || this.stateValue === "stopping";
  }

  private async pollInboxInternal(): Promise<void> {
    if (!this.canContinueCycle()) return;
    const registration = this.requireRegistration();
    let messages = await this.client.inbox(
      registration.agentId,
      registration.sessionToken,
      false,
    );
    if (!this.canContinueCycle()) return;
    this.lastPollAtMs = this.clock();

    // If an acknowledgement was uncertain in a previous cycle, ask the broker
    // for the acknowledged view before handing the body to a handler again.
    if (this.pendingAcknowledgements.size > 0) {
      if (!this.canContinueCycle()) return;
      const all = await this.client.inbox(
        registration.agentId,
        registration.sessionToken,
        true,
      );
      if (!this.canContinueCycle()) return;
      const byId = new Map(all.map((message) => [message.messageId, message]));
      for (const [messageId] of this.pendingAcknowledgements) {
        const current = byId.get(messageId);
        if (current?.acknowledgedAt) {
          this.pendingAcknowledgements.delete(messageId);
          this.emit({
            type: "message",
            messageId,
            action: "acknowledged",
            detail: "acknowledgement observed during reconciliation",
          });
        } else if (
          current &&
          !messages.some((item) => item.messageId === messageId)
        ) {
          messages = [...messages, current];
        }
      }
    }

    const seenThisPoll = new Set<string>();
    for (const message of messages.slice(0, this.maxMessagesPerPoll)) {
      if (!this.canContinueCycle()) return;
      // Let a message already admitted to the current cycle finish during a
      // graceful stop, but do not start additional handler work after stop was
      // requested.
      if (this.stopRequested && seenThisPoll.size > 0) return;
      if (message.acknowledgedAt || seenThisPoll.has(message.messageId))
        continue;
      seenThisPoll.add(message.messageId);
      await this.processMessage(message);
    }
  }

  private async tryNativePush(message: MessageRecord): Promise<boolean> {
    if (
      !this.canContinueCycle() ||
      !this.runtimeAdapter ||
      this.adapterDisabled
    )
      return false;
    if (this.pushedMessages.has(message.messageId)) return true;
    let alive: boolean;
    try {
      alive = await this.runCallback("runtime", () =>
        this.runtimeAdapter!.isAlive(),
      );
    } catch (error) {
      this.adapterDisabled = true;
      this.emit({
        type: "warning",
        code: "runtime_liveness_unknown",
        detail: this.errorMessage(error),
      });
      return false;
    }
    if (!this.canContinueCycle()) return false;
    if (!alive) {
      this.adapterDisabled = true;
      this.emit({
        type: "warning",
        code: "runtime_not_alive",
        detail:
          "owned runtime is not alive; durable inbox polling remains available",
      });
      return false;
    }
    try {
      const result = await this.runCallback("runtime", () =>
        this.runtimeAdapter!.push(message),
      );
      if (!this.canContinueCycle()) return false;
      if (!result.accepted) {
        this.emit({
          type: "message",
          messageId: message.messageId,
          action: "deferred",
          detail: result.detail ?? "owned runtime did not accept the push",
        });
        return false;
      }
      this.pushedMessages.add(message.messageId);
      this.emit({
        type: "message",
        messageId: message.messageId,
        action: "pushed",
        ...(result.capability || result.detail
          ? {
              detail: [result.capability, result.detail]
                .filter(Boolean)
                .join(": "),
            }
          : {}),
      });
      return true;
    } catch (error) {
      // A rejected native hint is not a broker delivery failure. Keep polling
      // and leave the durable message unacknowledged for the host to process.
      this.emit({
        type: "warning",
        code: "runtime_push_failed",
        detail: this.errorMessage(error),
      });
      return false;
    }
  }

  private async acknowledge(message: MessageRecord): Promise<void> {
    const registration = this.requireRegistration();
    this.pendingAcknowledgements.set(message.messageId, message);
    try {
      await this.client.acknowledgeMessage(
        registration.agentId,
        registration.sessionToken,
        message.messageId,
      );
      if (!this.canContinueCycle()) {
        throw new Error(
          `bridge became inactive while acknowledging ${message.messageId}`,
        );
      }
      this.pendingAcknowledgements.delete(message.messageId);
      this.emit({
        type: "message",
        messageId: message.messageId,
        action: "acknowledged",
      });
    } catch (error) {
      // Preserve the pending marker. The next cycle first reads the broker's
      // acknowledged view, so an uncertain call cannot cause a blind handler
      // replay or a false delivery claim.
      this.emit({
        type: "message",
        messageId: message.messageId,
        action: "ack-pending",
        detail: this.errorMessage(error),
      });
      throw error;
    }
  }

  private async processMessage(message: MessageRecord): Promise<void> {
    if (!this.canContinueCycle()) return;
    const attempt = (this.handlerAttempts.get(message.messageId) ?? 0) + 1;
    this.handlerAttempts.set(message.messageId, attempt);
    this.emit({
      type: "message",
      messageId: message.messageId,
      action: "seen",
    });
    const nativePushAccepted = await this.tryNativePush(message);
    if (!this.canContinueCycle()) return;
    if (!this.onMessage) {
      this.emit({
        type: "message",
        messageId: message.messageId,
        action: "deferred",
        detail: nativePushAccepted
          ? "native push accepted; recipient acknowledgement is still required"
          : "no message handler is configured",
      });
      return;
    }
    let result: MessageDisposition | void;
    const context: BridgeMessageContext = { attempt, nativePushAccepted };
    try {
      result = await this.runCallback("message", () =>
        this.onMessage!(message, context),
      );
    } catch (error) {
      this.emit({
        type: "message",
        messageId: message.messageId,
        action: "error",
        detail: this.errorMessage(error),
      });
      return;
    }
    if (!this.canContinueCycle()) return;
    if (disposition(result) !== "acknowledge") {
      this.emit({
        type: "message",
        messageId: message.messageId,
        action: "deferred",
      });
      return;
    }
    if (!this.canContinueCycle()) return;
    // Keep the failure phase on `ack` until the cycle-level error handler has
    // classified an uncertain acknowledgement. Reset only after success so a
    // lost response is not reported as a generic inbox failure.
    this.cyclePhase = "ack";
    await this.acknowledge(message);
    this.cyclePhase = "inbox";
  }

  private async performCycle(): Promise<void> {
    if (this.stateValue !== "running") return;
    const now = this.clock();
    this.cyclePhase = "heartbeat";
    if (
      this.lastHeartbeatAtMs === undefined ||
      elapsedSince(now, this.lastHeartbeatAtMs) >= this.heartbeatIntervalMs
    ) {
      await this.heartbeatInternal();
    }
    if (this.stateValue !== "running") return;
    this.cyclePhase = "inbox";
    await this.pollInboxInternal();
  }

  private async performPollNow(): Promise<void> {
    if (this.stateValue !== "running") return;
    const now = this.clock();
    this.cyclePhase = "heartbeat";
    if (
      this.lastHeartbeatAtMs === undefined ||
      elapsedSince(now, this.lastHeartbeatAtMs) >= this.heartbeatIntervalMs
    ) {
      await this.heartbeatInternal();
    }
    if (this.stateValue !== "running") return;
    this.cyclePhase = "inbox";
    await this.pollInboxInternal();
  }

  private async failClosed(
    error: unknown,
    phase: "heartbeat" | "inbox" | "ack" | "send" | "runtime",
  ): Promise<void> {
    if (this.startupInProgress && !this.startupFailure) {
      this.startupFailure =
        error instanceof Error ? error : new Error(String(error));
    }
    this.lastError = this.errorMessage(error);
    this.brokerLifecycle = "unknown";
    this.clearTimers();
    this.setState("degraded");
    this.emit({
      type: "error",
      phase,
      detail: this.lastError,
      terminal: true,
    });
    await this.persistOwnership({ state: "unknown" }).catch(() => undefined);
  }

  /**
   * Startup may overlap a runtime-exit notification or another fail-closed
   * operation. Never let that later await resume the bridge as `running`.
   */
  private ensureStartupHealthy(): void {
    if (
      !this.startupFailure &&
      (this.stateValue === "starting" || this.stateValue === "running")
    )
      return;
    throw (
      this.startupFailure ??
      new Error(`bridge startup interrupted (${this.stateValue})`)
    );
  }

  private schedule(): void {
    this.heartbeatTimer = setInterval(() => {
      void this.runCycle().catch(() => undefined);
    }, this.heartbeatIntervalMs);
    this.pollTimer = setInterval(() => {
      void this.runCycle().catch(() => undefined);
    }, this.pollIntervalMs);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.heartbeatTimer = undefined;
    this.pollTimer = undefined;
  }

  /** Register, verify the exact worktree with a heartbeat, and start polling. */
  async start(): Promise<BridgeSnapshot> {
    return this.enqueueLifecycle(() => this.performStart());
  }

  private async performStart(): Promise<BridgeSnapshot> {
    if (this.stateValue !== "idle") {
      throw new Error(`bridge cannot start from state ${this.stateValue}`);
    }
    this.startupInProgress = true;
    this.startupFailure = undefined;
    this.setState("starting");
    try {
      await this.observeBrokerHeartbeatTimeout();
      this.ensureStartupHealthy();
      if (this.ownership) {
        const previous = await this.ownership.read();
        this.ensureStartupHealthy();
        if (previous?.state === "running") {
          const observation = inspectOwnership(previous);
          this.emit({
            type: "warning",
            code: "previous_owner_marker",
            detail: `previous owner ${previous.ownerId} is recorded as running (${observation.processState}); marker is not a takeover credential`,
          });
        }
        this.ownershipRecord = this.baseOwnershipRecord();
        await this.persistOwnership({});
        this.ensureStartupHealthy();
      }

      // From this point onward a lost response may have created a broker row.
      // Keep the lifecycle state unknown until an authenticated result proves
      // which side of the boundary we are on.
      this.brokerLifecycle = "unknown";
      const registration = await this.client.register(this.registrationInput());
      if (!registration.sessionToken) {
        throw new Error("broker registration did not return a session token");
      }
      this.registration = registration;
      this.brokerLifecycle = "registered";
      this.ensureStartupHealthy();
      if (this.onPrivateRegistration) {
        await this.runCallback("startup", () =>
          this.onPrivateRegistration!(registration),
        );
      }
      this.ensureStartupHealthy();
      this.emit({
        type: "registered",
        agentId: registration.agentId,
        repositoryId: registration.workspace.repositoryId,
        worktreeId: registration.workspace.worktreeId,
        sessionMode: this.registrationOptions.sessionToken ? "resume" : "new",
      });
      await this.persistOwnership({
        agentId: registration.agentId,
        repositoryId: registration.workspace.repositoryId,
        worktreeId: registration.workspace.worktreeId,
      });
      this.ensureStartupHealthy();
      await this.heartbeatInternal();
      this.ensureStartupHealthy();
      this.setState("running");
      // A queued stop must get a fully authenticated registration to clean up,
      // but it should not start a fresh inbox cycle or timers on the way there.
      if (this.stopRequested) return this.snapshot();
      await this.pollInboxInternal();
      this.ensureStartupHealthy();
      if (this.stopRequested) return this.snapshot();
      this.schedule();
      return this.snapshot();
    } catch (error) {
      // A concurrent fail-closed operation already owns the terminal state.
      // Preserve it (and the unknown broker lifecycle) instead of converting
      // a runtime/broker failure into a misleading ordinary startup failure.
      if (this.snapshot().state === "degraded" && this.startupFailure) {
        this.clearTimers();
        if (this.registration) this.brokerLifecycle = "unknown";
        await this.persistOwnership({ state: "unknown" }).catch(
          () => undefined,
        );
        throw error;
      }
      this.lastError = this.errorMessage(error);
      this.emit({
        type: "error",
        phase: "register",
        detail: this.lastError,
        terminal: true,
      });
      this.clearTimers();
      // Registration or a later lifecycle call may have reached the broker
      // even when the response was lost. Preserve an unknown marker rather
      // than unregistering blindly; an operator can reconcile claims and Git
      // state before choosing an explicit forced unregister.
      if (this.registration) this.brokerLifecycle = "unknown";
      await this.persistOwnership({ state: "unknown" }).catch(() => undefined);
      // Keep an authenticated client open after a post-registration failure so
      // an explicit forced stop can still reconcile and unregister the row.
      if (this.ownsClient && !this.registration) {
        await this.client.close?.().catch(() => undefined);
      }
      this.setState("failed");
      throw error;
    } finally {
      this.startupInProgress = false;
    }
  }

  /** Run one bounded heartbeat/inbox cycle; timers use the same path. */
  async runCycle(): Promise<BridgeSnapshot> {
    if (this.stateValue !== "running") return this.snapshot();
    await this.runCycleOperation(() => this.performCycle());
    return this.snapshot();
  }

  private async runCycleOperation(
    operation: () => Promise<void>,
  ): Promise<void> {
    if (!this.cyclePromise) {
      this.cyclePromise = operation()
        .catch((error) => {
          return this.failClosed(error, this.cyclePhase).then(() => {
            throw error;
          });
        })
        .finally(() => {
          this.cyclePromise = undefined;
        });
    }
    await this.cyclePromise;
  }

  /** Force a fresh server-observed heartbeat before a meaningful operation. */
  async heartbeatNow(): Promise<AgentRecord> {
    if (
      this.stopRequested ||
      (this.stateValue !== "running" && this.stateValue !== "starting")
    ) {
      throw new Error(`bridge is not active (${this.stateValue})`);
    }
    return this.trackOperation(async () => {
      try {
        const result = await this.heartbeatInternal();
        this.ensureBrokerResultApplicable("heartbeat");
        return result;
      } catch (error) {
        if (this.stateValue === "running" || this.stateValue === "starting") {
          await this.failClosed(error, "heartbeat");
        }
        throw error;
      }
    });
  }

  /** Force one inbox poll without waiting for the next timer. */
  async pollNow(): Promise<BridgeSnapshot> {
    if (this.stateValue !== "running") return this.snapshot();
    await this.runCycleOperation(() => this.performPollNow());
    return this.snapshot();
  }

  /**
   * Return only peers whose broker status is explicitly `online`. Stale rows
   * are intentionally excluded; callers must not infer activity from a row's
   * existence, branch, PID, or ownership marker.
   */
  async listActivePeers(): Promise<AgentRecord[]> {
    if (this.stopRequested || this.stateValue !== "running") {
      throw new Error(`bridge is not active (${this.stateValue})`);
    }
    return this.trackOperation(async () => {
      const registration = this.requireRegistration();
      try {
        await this.heartbeatInternal();
        this.ensureBrokerResultApplicable("peer discovery");
        const agents = await this.client.listAgents(
          registration.workspace.repositoryId,
          true,
        );
        this.ensureBrokerResultApplicable("peer discovery");
        return agents.filter(
          (agent) =>
            agent.agentId !== registration.agentId && agent.status === "online",
        );
      } catch (error) {
        if (this.stateValue === "running" || this.stateValue === "starting") {
          await this.failClosed(error, "inbox");
        }
        throw error;
      }
    });
  }

  /** Return active peers sharing this exact worktree, for an overlap stop gate. */
  async listActiveWorktreePeers(): Promise<AgentRecord[]> {
    const registration = this.requireRegistration();
    const peers = await this.listActivePeers();
    return peers.filter(
      (agent) =>
        agent.workspace.worktreeId === registration.workspace.worktreeId,
    );
  }

  /** Persist a durable message; no native push is attempted by this method. */
  async sendMessage(
    recipientAgentId: string,
    body: string,
    correlationId?: string,
  ): Promise<MessageRecord> {
    if (this.stopRequested || this.stateValue !== "running") {
      throw new Error(`bridge is not active (${this.stateValue})`);
    }
    return this.trackOperation(async () => {
      const registration = this.requireRegistration();
      try {
        await this.heartbeatInternal();
        this.ensureBrokerResultApplicable("message send");
        const result = await this.client.sendMessage(
          registration.agentId,
          registration.sessionToken,
          recipientAgentId,
          body,
          correlationId,
        );
        this.ensureBrokerResultApplicable("message send");
        return result;
      } catch (error) {
        if (this.stateValue === "running" || this.stateValue === "starting") {
          await this.failClosed(error, "send");
        }
        throw error;
      }
    });
  }

  /**
   * Tell the supervisor that its owned runtime disappeared. This deliberately
   * does not unregister: an operator may need the broker's stale/lease state
   * to reconcile an in-flight external operation.
   */
  async notifyRuntimeExit(
    detail = "owned runtime exited",
  ): Promise<BridgeSnapshot> {
    if (this.stateValue === "stopped" || this.stateValue === "failed") {
      return this.snapshot();
    }
    await this.failClosed(new Error(detail), "runtime");
    return this.snapshot();
  }

  private requestStop(options: BridgeStopOptions): BridgeSnapshot {
    this.stopRequested = true;
    if (!this.stopPromise) {
      this.stopPromise = this.enqueueLifecycle(() => this.performStop(options));
    }
    return this.snapshot();
  }

  /**
   * Gracefully unregister and release this session's broker-owned leases.
   * Calls made re-entrantly by a bridge callback are non-blocking shutdown
   * requests; callers outside the callback can await the returned promise for
   * the final stopped/degraded snapshot.
   */
  async stop(options: BridgeStopOptions = {}): Promise<BridgeSnapshot> {
    // A callback runs inside the lifecycle/cycle operation that must finish
    // before performStop can run. Return a non-blocking request snapshot for a
    // re-entrant callback; the queued stopPromise remains the final result for
    // callers outside that callback.
    const callback = this.callbackContext.getStore();
    if (callback?.active === true) return this.requestStop(options);
    // A returned promise may still be settling while a callback-created
    // microtask runs. Give its settlement reaction one turn to clear `pending`;
    // if it remains pending, this is still an in-callback shutdown and must be
    // non-blocking to avoid a self-deadlock.
    if (callback?.pending === true) {
      await Promise.resolve();
      if (callback.pending) return this.requestStop(options);
    }
    if (this.stopPromise) {
      const result = await this.stopPromise;
      if (
        options.forceUnregister === true &&
        this.registration &&
        this.brokerLifecycle !== "unregistered"
      ) {
        this.stopPromise = undefined;
        return this.stop({ forceUnregister: true });
      }
      return result;
    }
    this.stopRequested = true;
    this.stopPromise = this.enqueueLifecycle(() => this.performStop(options));
    return this.stopPromise;
  }

  private async performStop(
    options: BridgeStopOptions,
  ): Promise<BridgeSnapshot> {
    if (this.stateValue === "stopped") return this.snapshot();
    const stateBeforeStopping = this.stateValue;
    this.clearTimers();
    if (this.stateValue !== "idle" && this.stateValue !== "failed") {
      this.setState("stopping");
    }
    if (this.cyclePromise) await this.cyclePromise.catch(() => undefined);
    await this.waitForOperations();

    // A cycle can fail while shutdown is waiting for it. Re-read the state
    // after the await; unregistering from that degraded path could release a
    // claim whose external Git outcome is still uncertain.
    const failedClosed =
      this.stateValue === "degraded" || this.stateValue === "failed";
    let clean = true;
    const shouldUnregister =
      Boolean(this.registration) &&
      (options.forceUnregister === true ||
        (!failedClosed &&
          (stateBeforeStopping === "running" ||
            stateBeforeStopping === "starting")));
    if (shouldUnregister && this.registration) {
      try {
        await this.client.unregister(
          this.registration.agentId,
          this.registration.sessionToken,
        );
        this.brokerLifecycle = "unregistered";
        this.lastAgentStatus = "offline";
      } catch (error) {
        clean = false;
        this.brokerLifecycle = "unknown";
        this.lastError = this.errorMessage(error);
        this.emit({
          type: "error",
          phase: "stop",
          detail: this.lastError,
          terminal: true,
        });
      }
    } else if (this.registration) {
      // Deliberately preserve the broker row after a fail-closed/uncertain
      // state. It may still own a claim and must be reconciled explicitly.
      if (this.brokerLifecycle !== "unregistered") clean = false;
    }
    if (this.runtimeAdapter?.close) {
      try {
        await this.runCallback("runtime", () => this.runtimeAdapter!.close!());
      } catch (error) {
        clean = false;
        this.lastError = this.errorMessage(error);
        this.emit({
          type: "error",
          phase: "stop",
          detail: this.lastError,
          terminal: true,
        });
      }
    }
    if (
      this.ownsClient &&
      (this.brokerLifecycle === "unregistered" || !this.registration)
    ) {
      await this.client.close?.().catch(() => undefined);
    }
    const brokerClean = this.registration
      ? this.brokerLifecycle === "unregistered"
      : this.brokerLifecycle === "not_attempted" ||
        this.brokerLifecycle === "unregistered";
    if (this.ownership) {
      await this.persistOwnership({
        state: clean && brokerClean ? "stopped" : "unknown",
        ...(clean && brokerClean ? { stoppedAt: nowIso(this.clock) } : {}),
      }).catch(() => {
        clean = false;
      });
    }
    this.setState(clean && brokerClean ? "stopped" : "degraded");
    return this.snapshot();
  }
}
