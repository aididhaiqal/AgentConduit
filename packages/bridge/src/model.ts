import type {
  AgentRecord,
  AgentRegistration,
  AgentRegistrationInput,
  MessageRecord,
} from "@agentconduit/core";

/** The supervisor lifecycle. A degraded bridge has stopped making progress. */
export type BridgeState =
  | "idle"
  | "starting"
  | "running"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

/** A handler must opt in to acknowledgement; the safe default is defer. */
export type MessageDisposition = "acknowledge" | "defer";

export interface BridgeMessageContext {
  /** Number of times this bridge has handed the message to its handler. */
  attempt: number;
  /** Whether an owned-runtime push was accepted during this poll. */
  nativePushAccepted: boolean;
}

/** Minimal broker metadata needed to calibrate local presence freshness. */
export interface BrokerServerInfo {
  heartbeatTimeoutMs: number;
}

export type BridgeMessageHandler = (
  message: MessageRecord,
  context: BridgeMessageContext,
) => MessageDisposition | void | Promise<MessageDisposition | void>;

/**
 * An adapter is intentionally generic. Its caller must have created and own
 * the process/thread represented by `identity`; the bridge does not discover
 * or attach to arbitrary provider sessions.
 */
export interface OwnedRuntimeAdapter {
  readonly name: string;
  readonly version?: string;
  readonly identity: {
    kind: "process" | "thread" | "session";
    id: string;
  };
  isAlive(): boolean | Promise<boolean>;
  /**
   * Attempt a provider-native wake-up. `accepted` is not an acknowledgement;
   * the recipient must still read and ack the durable AgentConduit message.
   */
  push(message: MessageRecord): Promise<PushAttempt>;
  close?(): Promise<void>;
}

export interface PushAttempt {
  accepted: boolean;
  capability?: string;
  detail?: string;
}

export interface BridgeRegistrationOptions extends Omit<
  AgentRegistrationInput,
  "sessionRef" | "sessionToken"
> {
  /**
   * A non-secret label for a new session. The bridge appends its owner ID when
   * no prior token is supplied, so a new chat can never collide with an old
   * registration accidentally. For a reconnect this value is used verbatim.
   */
  sessionRef?: string;
  /** Prior token, supplied only by protected runtime state for a reconnect. */
  sessionToken?: string;
}

export interface BridgeEventBase {
  at: string;
}

export type BridgeEvent =
  | (BridgeEventBase & {
      type: "state";
      state: BridgeState;
    })
  | (BridgeEventBase & {
      type: "registered";
      agentId: string;
      repositoryId: string;
      worktreeId: string;
      sessionMode: "new" | "resume";
    })
  | (BridgeEventBase & {
      type: "heartbeat";
      status: AgentRecord["status"];
    })
  | (BridgeEventBase & {
      type: "message";
      messageId: string;
      action:
        | "seen"
        | "pushed"
        | "deferred"
        | "acknowledged"
        | "ack-pending"
        | "error";
      detail?: string;
    })
  | (BridgeEventBase & {
      type: "warning";
      code: string;
      detail: string;
    })
  | (BridgeEventBase & {
      type: "error";
      phase:
        | "register"
        | "heartbeat"
        | "inbox"
        | "ack"
        | "send"
        | "runtime"
        | "stop";
      detail: string;
      terminal: boolean;
    });

/** Event payload accepted by the supervisor before it adds server-local time. */
export type BridgeEventInput =
  | Omit<Extract<BridgeEvent, { type: "state" }>, "at">
  | Omit<Extract<BridgeEvent, { type: "registered" }>, "at">
  | Omit<Extract<BridgeEvent, { type: "heartbeat" }>, "at">
  | Omit<Extract<BridgeEvent, { type: "message" }>, "at">
  | Omit<Extract<BridgeEvent, { type: "warning" }>, "at">
  | Omit<Extract<BridgeEvent, { type: "error" }>, "at">;

export interface BridgeSnapshot {
  ownerId: string;
  state: BridgeState;
  /** True only while the bridge has a recent successful heartbeat. */
  active: boolean;
  /** Whether the broker row has been explicitly unregistered. */
  brokerStatus?: "registered" | "unregistered" | "unknown";
  agentId?: string;
  sessionRef?: string;
  repositoryId?: string;
  worktreeId?: string;
  agentStatus?: AgentRecord["status"];
  lastHeartbeatAt?: string;
  lastPollAt?: string;
  lastError?: string;
}

export interface BridgeClientLike {
  register(input: AgentRegistrationInput): Promise<AgentRegistration>;
  /**
   * Optional broker capabilities/configuration discovery. A real MCP client
   * should expose the server heartbeat timeout so local liveness cannot be
   * more optimistic than the broker's active-only view.
   */
  serverInfo?(): Promise<BrokerServerInfo>;
  heartbeat(
    agentId: string,
    sessionToken: string,
    workspacePath: string,
  ): Promise<AgentRecord>;
  unregister(agentId: string, sessionToken: string): Promise<void>;
  /**
   * List agents in a repository. `activeOnly` asks the broker to apply its
   * server-side heartbeat freshness calculation before returning rows.
   */
  listAgents(
    repositoryId?: string,
    activeOnly?: boolean,
  ): Promise<AgentRecord[]>;
  inbox(
    agentId: string,
    sessionToken: string,
    includeAcknowledged?: boolean,
  ): Promise<MessageRecord[]>;
  acknowledgeMessage(
    agentId: string,
    sessionToken: string,
    messageId: string,
  ): Promise<void>;
  sendMessage(
    senderAgentId: string,
    senderSessionToken: string,
    recipientAgentId: string,
    body: string,
    correlationId?: string,
  ): Promise<MessageRecord>;
  close?(): Promise<void>;
}

export interface BridgeSupervisorOptions {
  client: BridgeClientLike;
  registration: BridgeRegistrationOptions;
  /** Defaults to 30 seconds; keep it below the broker heartbeat timeout. */
  heartbeatIntervalMs?: number;
  /** Defaults to 2 seconds. */
  pollIntervalMs?: number;
  /** Defaults to 100 messages per poll. */
  maxMessagesPerPoll?: number;
  /**
   * Fallback/cap for local freshness when the broker client does not expose
   * `serverInfo()`. When available, the server-reported timeout is preferred.
   */
  brokerHeartbeatTimeoutMs?: number;
  /** Optional protected marker; no marker is written when omitted. */
  ownershipFile?: string;
  /** Call `client.close()` on stop when the bridge created the client. */
  ownsClient?: boolean;
  /**
   * Optional protected-state handoff for the private registration token. The
   * callback must not log or persist the value in plaintext; it is invoked on
   * both initial registration and token-rotating reconnect.
   */
  onPrivateRegistration?: (
    registration: Readonly<AgentRegistration>,
  ) => void | Promise<void>;
  onMessage?: BridgeMessageHandler;
  runtimeAdapter?: OwnedRuntimeAdapter;
  onEvent?: (event: BridgeEvent) => void;
  /** Injectable wall clock for deterministic tests. */
  clock?: () => number;
}

export interface BridgeStopOptions {
  /**
   * Explicitly unregister even after a fail-closed/degraded state. This is a
   * reconciliation action because unregister releases broker-owned leases.
   */
  forceUnregister?: boolean;
}
