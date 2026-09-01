const views = {
  overview: ["Network authority", "Overview"],
  devices: ["Trusted machines", "Devices"],
  agents: ["Local runtime presence", "Agents & workspaces"],
  jobs: ["Durable work signals", "Jobs & progress"],
  integrations: ["Serialized target refs", "Integrations"],
  messages: ["Durable owner contact", "Messages"],
  reconciliation: ["Preserved uncertain authority", "Reconciliation"],
  audit: ["Ordered coordination record", "Audit"],
};

const SNAPSHOT_REFRESH_INTERVAL_MS = 30_000;

const state = {
  session: undefined,
  snapshot: undefined,
  view: "overview",
  eventSource: undefined,
  refreshTimer: undefined,
  snapshotRefreshTimer: undefined,
  refreshing: undefined,
};

const loginView = document.querySelector("#login-view");
const appShell = document.querySelector("#app-shell");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const content = document.querySelector("#view-content");
const networkBoard = document.querySelector("#network-board");
const announcement = document.querySelector("#announcement");
const notice = document.querySelector("#notice");
const connectionLamp = document.querySelector("#connection-lamp");
const connectionLabel = document.querySelector("#connection-label");
const syncLabel = document.querySelector("#sync-label");
const confirmDialog = document.querySelector("#confirm-dialog");
const confirmTitle = document.querySelector("#confirm-title");
const confirmCopy = document.querySelector("#confirm-copy");
const confirmButton = document.querySelector("#confirm-button");

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.id) node.id = options.id;
  if (options.title) node.title = options.title;
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    if (value !== undefined) node.setAttribute(name, String(value));
  }
  for (const [name, value] of Object.entries(options.dataset ?? {})) {
    node.dataset[name] = String(value);
  }
  for (const child of children) {
    if (child !== undefined && child !== null) {
      node.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
    }
  }
  return node;
}

function textBlock(title, copy) {
  return element("div", {}, [
    element("strong", { text: title }),
    element("p", { text: copy }),
  ]);
}

function shortId(value) {
  if (!value) return "—";
  const parts = String(value).split("_");
  const suffix = parts.at(-1);
  return suffix && suffix.length > 10
    ? `${parts[0]}_${suffix.slice(0, 8)}…`
    : value;
}

function relativeTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "time unavailable";
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const ranges = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.35, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let amount = seconds;
  for (const [divisor, unit] of ranges) {
    if (Math.abs(amount) < divisor) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
        Math.round(amount),
        unit,
      );
    }
    amount /= divisor;
  }
  return new Date(timestamp).toLocaleString();
}

function timeNode(value) {
  return element("time", {
    text: relativeTime(value),
    title: new Date(value).toLocaleString(),
    attributes: { datetime: value },
  });
}

function statusChip(status) {
  return element("span", {
    className: `status-chip ${String(status).toLowerCase()}`,
    text: String(status).replaceAll("_", " "),
  });
}

function rowMeta(...values) {
  return element(
    "div",
    { className: "row-meta" },
    values.filter(Boolean).map((value) => element("span", { text: value })),
  );
}

function emptyState(message) {
  return element("div", { className: "empty-state" }, [
    element("span", {
      className: "status-lamp stale",
      attributes: { "aria-hidden": "true" },
    }),
    element("span", { text: message }),
  ]);
}

function ledgerPanel(title, description, body, actions) {
  const heading = element("div", { className: "ledger-heading" }, [
    element("div", {}, [
      element("h2", { text: title }),
      element("p", { text: description }),
    ]),
    actions,
  ]);
  return element("section", { className: "ledger-panel" }, [heading, body]);
}

function listOrEmpty(items, message) {
  if (items.length === 0) return emptyState(message);
  return element("ol", { className: "ledger-list" }, items);
}

function setConnection(status, label) {
  connectionLamp.className = `connection-lamp ${status}`;
  connectionLabel.textContent = label;
}

function setNotice(message, tone = "info") {
  if (!message) {
    notice.hidden = true;
    notice.textContent = "";
    notice.className = "notice";
    return;
  }
  notice.hidden = false;
  notice.textContent = message;
  notice.className = `notice${tone === "error" ? " error" : ""}`;
}

function announce(message) {
  announcement.textContent = "";
  window.setTimeout(() => {
    announcement.textContent = message;
  }, 10);
}

async function request(path, options = {}) {
  const headers = { accept: "application/json", ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.mutation && state.session?.csrfToken) {
    headers["x-agentconduit-csrf"] = state.session.csrfToken;
  }
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : response.status === 401
          ? "Owner session is not authorized"
          : "The Hub rejected this request";
    throw new ApiError(response.status, message);
  }
  return payload.result;
}

const snapshotCollections = [
  "devices",
  "workspaces",
  "agents",
  "messages",
  "leases",
  "integrations",
  "jobs",
  "reconciliations",
  "recentEvents",
];

async function readSnapshot() {
  const seen = new Set();
  let cursor;
  let combined;
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const page = await request(
      `/api/v1/admin/snapshot${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (!page || typeof page !== "object") {
      throw new ApiError(502, "The Hub snapshot response is invalid");
    }
    if (!combined) {
      combined = { ...page };
      for (const collection of snapshotCollections) {
        if (!Array.isArray(page[collection])) {
          throw new ApiError(502, "The Hub snapshot response is invalid");
        }
        combined[collection] = [...page[collection]];
      }
    } else {
      for (const collection of snapshotCollections) {
        if (!Array.isArray(page[collection])) {
          throw new ApiError(502, "The Hub snapshot response is invalid");
        }
        combined[collection].push(...page[collection]);
      }
      combined.generatedAt = page.generatedAt;
      combined.latestEventCursor = page.latestEventCursor;
      combined.database = page.database;
    }
    if (page.nextCursor === undefined) {
      delete combined.nextCursor;
      return combined;
    }
    if (typeof page.nextCursor !== "string" || seen.has(page.nextCursor)) {
      throw new ApiError(502, "The Hub snapshot cursor did not advance");
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new ApiError(502, "The Hub snapshot exceeded its pagination limit");
}

function closeEvents() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = undefined;
}

function clearSnapshotRefresh() {
  if (state.snapshotRefreshTimer !== undefined) {
    window.clearTimeout(state.snapshotRefreshTimer);
  }
  state.snapshotRefreshTimer = undefined;
}

function scheduleSnapshotRefresh() {
  clearSnapshotRefresh();
  if (!state.session) return;
  state.snapshotRefreshTimer = window.setTimeout(() => {
    state.snapshotRefreshTimer = undefined;
    void refreshSnapshot({ focus: false, quiet: true });
  }, SNAPSHOT_REFRESH_INTERVAL_MS);
}

function showLogin(message) {
  closeEvents();
  clearSnapshotRefresh();
  if (state.refreshTimer !== undefined) {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = undefined;
  }
  state.session = undefined;
  state.snapshot = undefined;
  appShell.hidden = true;
  loginView.hidden = false;
  loginError.hidden = !message;
  loginError.textContent = message ?? "";
  document.querySelector("#owner-token").focus();
}

async function showApp(session) {
  state.session = session;
  loginError.hidden = true;
  loginView.hidden = true;
  appShell.hidden = false;
  setConnection("degraded", "Reading Hub");
  await refreshSnapshot({ focus: false });
  connectEvents();
}

function connectEvents() {
  closeEvents();
  const cursor = state.snapshot?.latestEventCursor ?? 0;
  const source = new EventSource(`/api/v1/admin/events?cursor=${cursor}`);
  state.eventSource = source;
  source.addEventListener("open", () =>
    setConnection("connected", "Live replay"),
  );
  source.addEventListener("coordination", () => scheduleRefresh());
  source.addEventListener("reset", () => scheduleRefresh(0));
  source.addEventListener("error", () => {
    setConnection("degraded", "Replay reconnecting");
  });
}

function scheduleRefresh(delay = 180) {
  if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
  state.refreshTimer = window.setTimeout(() => {
    state.refreshTimer = undefined;
    void refreshSnapshot({ focus: false, quiet: true });
  }, delay);
}

async function refreshSnapshot({ focus = false, quiet = false } = {}) {
  if (state.refreshing) return await state.refreshing;
  clearSnapshotRefresh();
  content.setAttribute("aria-busy", "true");
  state.refreshing = (async () => {
    try {
      const snapshot = await readSnapshot();
      state.snapshot = snapshot;
      setNotice();
      setConnection("connected", "Hub current");
      syncLabel.textContent = `Snapshot ${relativeTime(snapshot.generatedAt)}`;
      syncLabel.title = new Date(snapshot.generatedAt).toLocaleString();
      renderBoard();
      renderView();
      if (!quiet) announce("Coordination state refreshed");
      if (focus) content.focus();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        showLogin("Your owner session ended. Sign in again.");
        return;
      }
      setConnection("degraded", "Hub unavailable");
      setNotice(
        "The latest Hub state could not be read. No coordination authority was changed.",
        "error",
      );
      if (!state.snapshot)
        content.replaceChildren(
          emptyState("No trusted snapshot is available."),
        );
    } finally {
      content.setAttribute("aria-busy", "false");
      state.refreshing = undefined;
      scheduleSnapshotRefresh();
    }
  })();
  return await state.refreshing;
}

function deviceForAgent(agent) {
  const workspace = state.snapshot.workspaces.find(
    (item) => item.workspace.worktreeId === agent.workspace.worktreeId,
  );
  return state.snapshot.devices.find(
    (device) => device.deviceId === workspace?.deviceId,
  );
}

function workspaceLabel(worktreeId) {
  return (
    state.snapshot.workspaces.find(
      (item) => item.workspace.worktreeId === worktreeId,
    )?.pathLabel ?? shortId(worktreeId)
  );
}

function agentLabel(agentId) {
  const agent = state.snapshot.agents.find((item) => item.agentId === agentId);
  return agent?.displayName ?? agent?.runtime ?? shortId(agentId);
}

function renderBoard() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const activeIntegrations = snapshot.integrations.filter((item) =>
    ["queued", "needs_refresh", "claimed"].includes(item.status),
  );
  const activeJobs = snapshot.jobs.filter(
    (item) => item.activity !== "terminal",
  );
  const online = snapshot.devices.filter(
    (device) => device.status === "online",
  ).length;
  document.querySelector("#route-board-summary").textContent =
    `${online} of ${snapshot.devices.length} devices online · ` +
    `${activeIntegrations.length} integration route${activeIntegrations.length === 1 ? "" : "s"} active · ` +
    `${activeJobs.length} durable job${activeJobs.length === 1 ? "" : "s"} open`;

  if (snapshot.devices.length === 0) {
    networkBoard.replaceChildren(
      element("div", { className: "board-empty" }, [
        element("span", {
          className: "status-lamp",
          attributes: { "aria-hidden": "true" },
        }),
        textBlock(
          "No device stations enrolled",
          "Create a one-time enrollment through the protected owner API, then enroll a Node from that machine.",
        ),
      ]),
    );
    return;
  }

  const rows = snapshot.devices.map((device) => {
    const workspaces = snapshot.workspaces.filter(
      (item) => item.deviceId === device.deviceId,
    );
    const worktreeIds = new Set(
      workspaces.map((item) => item.workspace.worktreeId),
    );
    const agents = snapshot.agents.filter((agent) =>
      worktreeIds.has(agent.workspace.worktreeId),
    );
    const agentIds = new Set(agents.map((agent) => agent.agentId));
    const routes = activeIntegrations.filter(
      (item) => agentIds.has(item.requestedBy) || agentIds.has(item.claimedBy),
    );
    const jobs = activeJobs.filter((item) => agentIds.has(item.ownerAgentId));
    return element("div", { className: "track-row" }, [
      element("div", { className: "station" }, [
        element("span", {
          className: `status-lamp ${device.status}`,
          attributes: { "aria-hidden": "true" },
        }),
        element("div", {}, [
          element("strong", { text: device.name }),
          element("span", { text: `${device.platform} · ${device.status}` }),
        ]),
      ]),
      element(
        "div",
        { className: "track-line", attributes: { "aria-hidden": "true" } },
        [
          element("span", {
            className: `track-signal${routes.length > 0 ? " busy" : ""}`,
          }),
        ],
      ),
      element("div", { className: "track-destination" }, [
        element("strong", {
          text: `${agents.length} agent${agents.length === 1 ? "" : "s"}`,
        }),
        `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"} · ${routes.length} routes · ${jobs.length} jobs`,
      ]),
    ]);
  });
  networkBoard.replaceChildren(...rows);
}

function registerCell(label, value) {
  return element("div", { className: "register-cell" }, [
    element("span", { className: "utility-label", text: label }),
    element("strong", { text: value }),
  ]);
}

function overviewView() {
  const snapshot = state.snapshot;
  const devicesOnline = snapshot.devices.filter(
    (item) => item.status === "online",
  ).length;
  const agentsOnline = snapshot.agents.filter(
    (item) => item.status === "online",
  ).length;
  const activeRoutes = snapshot.integrations.filter((item) =>
    ["queued", "needs_refresh", "claimed"].includes(item.status),
  );
  const activeJobs = snapshot.jobs.filter(
    (item) => item.activity !== "terminal",
  );
  const openCases = snapshot.reconciliations.filter(
    (item) => item.status === "open",
  );
  const warnings = [
    ...snapshot.devices
      .filter((item) => item.status !== "online")
      .map((item) => ({
        title: `${item.name} is ${item.status}`,
        copy:
          item.status === "revoked"
            ? "Its credential no longer authenticates. Existing uncertain authority remains preserved."
            : `Last contact ${relativeTime(item.lastSeenAt)}. Do not assume its work is abandoned.`,
        status: item.status,
      })),
    ...openCases.map((item) => ({
      title: `Reconciliation ${shortId(item.reconciliationId)} is open`,
      copy: `${agentLabel(item.agentId)} · ${item.reason}`,
      status: "open",
    })),
    ...snapshot.jobs
      .filter((item) => item.activity === "stale")
      .map((item) => ({
        title: `${item.displayName} is stale`,
        copy: `Last activity ${relativeTime(item.lastActivityAt)}. Inspect or resume it; staleness does not prove abandonment.`,
        status: "stale",
      })),
  ];

  const routeRows = activeRoutes.slice(0, 6).map((item) =>
    element("li", { className: "ledger-row" }, [
      element("div", {}, [
        element("h3", { text: `${item.sourceRef} → ${item.targetRef}` }),
        element(
          "div",
          {
            className: "integration-route",
            attributes: { "aria-hidden": "true" },
          },
          [
            element("span", { text: item.sourceRef }),
            element("i"),
            element("span", { text: item.targetRef }),
          ],
        ),
        rowMeta(
          agentLabel(item.requestedBy),
          shortId(item.repositoryId),
          relativeTime(item.updatedAt),
        ),
      ]),
      element("div", { className: "row-actions" }, [statusChip(item.status)]),
    ]),
  );
  const warningRows = warnings
    .slice(0, 6)
    .map((item) =>
      element("li", { className: "ledger-row" }, [
        element("div", {}, [
          element("h3", { text: item.title }),
          element("p", { text: item.copy }),
        ]),
        statusChip(item.status),
      ]),
    );

  return element("div", {}, [
    element(
      "section",
      {
        className: "register-strip",
        attributes: { "aria-label": "Network register" },
      },
      [
        registerCell(
          "Devices online",
          `${devicesOnline}/${snapshot.devices.length}`,
        ),
        registerCell(
          "Agents online",
          `${agentsOnline}/${snapshot.agents.length}`,
        ),
        registerCell("Active routes", activeRoutes.length),
        registerCell("Open jobs", activeJobs.length),
        registerCell("Open cases", openCases.length),
      ],
    ),
    element("div", { className: "content-grid" }, [
      ledgerPanel(
        "Integration routes",
        "Global FIFO work approaching a shared target ref.",
        listOrEmpty(routeRows, "No integration route is waiting or claimed."),
      ),
      ledgerPanel(
        "Attention register",
        "Staleness and uncertainty stay visible until reconciled.",
        listOrEmpty(
          warningRows,
          "All observed device and reconciliation signals are nominal.",
        ),
      ),
    ]),
  ]);
}

function devicesView() {
  const rows = state.snapshot.devices.map((device) => {
    const actions = [statusChip(device.status)];
    if (device.status !== "revoked") {
      actions.push(
        element("button", {
          className: "button button-danger button-compact",
          text: "Revoke device",
          attributes: { type: "button" },
          dataset: { action: "revoke-device", deviceId: device.deviceId },
        }),
      );
    }
    return element("li", { className: "ledger-row" }, [
      element("div", {}, [
        element("h3", { text: device.name }),
        element("p", {
          text: `${device.platform} / ${device.architecture} · Node ${device.nodeVersion}`,
        }),
        rowMeta(
          shortId(device.deviceId),
          `health ${device.health.status}`,
          `memory ${device.health.memoryUsedPercent}%`,
          `last seen ${relativeTime(device.lastSeenAt)}`,
        ),
      ]),
      element("div", { className: "row-actions" }, actions),
    ]);
  });
  return ledgerPanel(
    "Device stations",
    "Revocation blocks new calls immediately and never releases uncertain leases or claims.",
    listOrEmpty(
      rows,
      "No device is enrolled. Generate one protected enrollment code through the owner API, then enroll a Node on that PC.",
    ),
  );
}

function agentsView() {
  const rows = state.snapshot.agents.map((agent) => {
    const device = deviceForAgent(agent);
    return element("li", { className: "ledger-row" }, [
      element("div", {}, [
        element("h3", { text: agent.displayName ?? agent.runtime }),
        element("p", {
          text: `${workspaceLabel(agent.workspace.worktreeId)} · ${agent.workspace.branch ?? "detached HEAD"}`,
        }),
        rowMeta(
          shortId(agent.agentId),
          device?.name ?? "device unresolved",
          shortId(agent.workspace.repositoryId),
          agent.workspace.dirty ? "dirty worktree" : "clean worktree",
          `heartbeat ${relativeTime(agent.lastHeartbeat)}`,
        ),
      ]),
      element("div", { className: "row-actions" }, [statusChip(agent.status)]),
    ]);
  });
  const workspaceRows = state.snapshot.workspaces.map((record) => {
    const device = state.snapshot.devices.find(
      (item) => item.deviceId === record.deviceId,
    );
    return element("li", { className: "ledger-row" }, [
      element("div", {}, [
        element("h3", { text: record.pathLabel }),
        element("p", {
          text: `${record.workspace.projectId ?? "explicit project identity missing"} · ${record.workspace.branch ?? "detached HEAD"}`,
        }),
        rowMeta(
          device?.name ?? shortId(record.deviceId),
          shortId(record.workspace.worktreeId),
          shortId(record.workspace.headOid),
          record.workspace.dirty ? "dirty" : "clean",
        ),
      ]),
      statusChip(device?.status ?? "stale"),
    ]);
  });
  return element("div", { className: "content-grid" }, [
    ledgerPanel(
      "Agent sessions",
      "Fresh presence is evidence of a live runtime; stale presence is not proof of abandonment.",
      listOrEmpty(
        rows,
        "No coding-agent session has registered through an enrolled Node.",
      ),
    ),
    ledgerPanel(
      "Redacted workspaces",
      "Only device labels and Git evidence cross the network; local absolute paths stay local.",
      listOrEmpty(workspaceRows, "No remote workspace has been attested yet."),
    ),
  ]);
}

function latestJobSignal(jobId) {
  return [...state.snapshot.recentEvents]
    .filter(
      (event) =>
        event.resourceId === jobId &&
        String(event.eventType).startsWith("job.event."),
    )
    .sort((left, right) => right.cursor - left.cursor)[0];
}

function jobsView() {
  const jobs = [...state.snapshot.jobs].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const rows = jobs.map((job) => {
    const signal = latestJobSignal(job.jobId);
    const summary =
      typeof signal?.metadata?.summary === "string"
        ? signal.metadata.summary
        : signal
          ? `Latest signal: ${String(signal.metadata?.eventType ?? signal.eventType).replaceAll("_", " ")}`
          : "No recent progress signal is present in the bounded audit window.";
    return element("li", { className: "ledger-row" }, [
      element("div", {}, [
        element("h3", { text: job.displayName }),
        element("p", { text: summary }),
        rowMeta(
          `owner ${agentLabel(job.ownerAgentId)}`,
          job.kind,
          workspaceLabel(job.worktreeId),
          shortId(job.repositoryId),
          `activity ${relativeTime(job.lastActivityAt)}`,
          `event ${job.lastEventSequence}`,
        ),
      ]),
      element("div", { className: "row-actions" }, [
        statusChip(job.status),
        statusChip(job.activity),
      ]),
    ]);
  });
  return ledgerPanel(
    "Durable job register",
    "Heartbeat means recent liveness only. Checkpoints describe bounded progress; stale work remains inspectable and may resume.",
    listOrEmpty(rows, "No durable job has been registered."),
  );
}

function integrationsView() {
  const integrations = [...state.snapshot.integrations].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const rows = integrations.map((item, index) => {
    const cancellable =
      !item.claimedBy && ["queued", "needs_refresh"].includes(item.status);
    const actions = [statusChip(item.status)];
    if (cancellable) {
      actions.push(
        element("button", {
          className: "button button-quiet button-compact",
          text: "Cancel request",
          attributes: { type: "button" },
          dataset: { action: "cancel-integration", requestId: item.requestId },
        }),
      );
    }
    return element("li", { className: "ledger-row" }, [
      element("div", {}, [
        element("h3", {
          text: `Route ${String(index + 1).padStart(2, "0")} · ${item.targetRef}`,
        }),
        element("div", { className: "integration-route" }, [
          element("span", { text: item.sourceRef }),
          element("i", { attributes: { "aria-hidden": "true" } }),
          element("span", { text: item.targetRef }),
        ]),
        rowMeta(
          `requested by ${agentLabel(item.requestedBy)}`,
          item.claimedBy
            ? `claimed by ${agentLabel(item.claimedBy)}`
            : "unclaimed",
          shortId(item.repositoryId),
          `updated ${relativeTime(item.updatedAt)}`,
        ),
      ]),
      element("div", { className: "row-actions" }, actions),
    ]);
  });
  return ledgerPanel(
    "Integration interlocking",
    "Only the queue head can claim a target. This panel can cancel an unclaimed request, never a live claim.",
    listOrEmpty(rows, "No integration request has entered the global queue."),
  );
}

function agentOptions() {
  return state.snapshot.agents.map((agent) =>
    element("option", {
      text: `${agent.displayName ?? agent.runtime} · ${workspaceLabel(agent.workspace.worktreeId)} · ${agent.status}`,
      attributes: { value: agent.agentId },
    }),
  );
}

function messagesView() {
  const form = element(
    "form",
    { className: "control-form", id: "message-form" },
    [
      element("label", {
        text: "Recipient",
        attributes: { for: "message-recipient" },
      }),
      element(
        "select",
        {
          id: "message-recipient",
          attributes: { name: "recipientAgentId", required: "" },
        },
        [
          element("option", {
            text: "Choose an agent",
            attributes: { value: "" },
          }),
          ...agentOptions(),
        ],
      ),
      element("label", {
        text: "Owner message",
        attributes: { for: "message-body" },
      }),
      element("textarea", {
        id: "message-body",
        attributes: { name: "body", required: "", maxlength: "32768" },
      }),
      element("p", {
        className: "field-hint",
        text: "Delivered durably. Push may wake the Node, but the recipient inbox remains authoritative.",
      }),
      element("button", {
        className: "button button-primary",
        text: "Send owner message",
        attributes: { type: "submit" },
      }),
    ],
  );
  const rows = [...state.snapshot.messages]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((message) =>
      element("li", { className: "ledger-row" }, [
        element("div", {}, [
          element("h3", {
            text: `${message.senderAgentId === "owner" ? "Owner" : agentLabel(message.senderAgentId)} → ${agentLabel(message.recipientAgentId)}`,
          }),
          element("p", { className: "message-body", text: message.body }),
          rowMeta(
            shortId(message.messageId),
            relativeTime(message.createdAt),
            message.acknowledgedAt
              ? `acknowledged ${relativeTime(message.acknowledgedAt)}`
              : "awaiting acknowledgement",
          ),
        ]),
        statusChip(message.acknowledgedAt ? "online" : "queued"),
      ]),
    );
  return element("div", { className: "content-grid one-third" }, [
    ledgerPanel(
      "Send to an agent",
      "One bounded owner-to-agent message.",
      state.snapshot.agents.length > 0
        ? form
        : emptyState("Register an agent before sending an owner message."),
    ),
    ledgerPanel(
      "Durable message ledger",
      "Bodies are visible only inside the authenticated owner boundary and recipient inbox.",
      listOrEmpty(rows, "No agent or owner message has been recorded."),
    ),
  ]);
}

function reconciliationView() {
  const form = element(
    "form",
    { className: "control-form", id: "reconciliation-form" },
    [
      element("label", {
        text: "Agent",
        attributes: { for: "reconciliation-agent" },
      }),
      element(
        "select",
        {
          id: "reconciliation-agent",
          attributes: { name: "agentId", required: "" },
        },
        [
          element("option", {
            text: "Choose an agent",
            attributes: { value: "" },
          }),
          ...agentOptions(),
        ],
      ),
      element("label", {
        text: "Observed uncertainty",
        attributes: { for: "reconciliation-reason" },
      }),
      element("textarea", {
        id: "reconciliation-reason",
        attributes: { name: "reason", required: "", maxlength: "1000" },
      }),
      element("p", {
        className: "field-hint",
        text: "Opening a case records evidence. It does not release, complete, or mutate Git authority.",
      }),
      element("button", {
        className: "button button-primary",
        text: "Open reconciliation",
        attributes: { type: "submit" },
      }),
    ],
  );
  const rows = [...state.snapshot.reconciliations]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((item) =>
      element("li", { className: "ledger-row" }, [
        element("div", {}, [
          element("h3", {
            text: `${agentLabel(item.agentId)} · ${shortId(item.reconciliationId)}`,
          }),
          element("p", { text: item.reason }),
          rowMeta(
            `${item.leaseIds.length} preserved leases`,
            `${item.claimedIntegrationIds.length} preserved claims`,
            relativeTime(item.createdAt),
          ),
        ]),
        statusChip(item.status),
      ]),
    );
  return element("div", { className: "content-grid one-third" }, [
    ledgerPanel(
      "Open a case",
      "Attach operator-visible context to an uncertain agent.",
      state.snapshot.agents.length > 0
        ? form
        : emptyState("No agent is available for reconciliation."),
    ),
    ledgerPanel(
      "Case register",
      "Authority remains preserved while an operator inspects real Hub and Git state.",
      listOrEmpty(rows, "No reconciliation case has been opened."),
    ),
  ]);
}

function auditView() {
  const rows = [...state.snapshot.recentEvents]
    .sort((left, right) => right.cursor - left.cursor)
    .map((event) =>
      element("li", { className: "ledger-row" }, [
        element("div", {}, [
          element("h3", {
            text: `${String(event.cursor).padStart(6, "0")} · ${event.eventType}`,
          }),
          element("p", {
            className: "audit-metadata",
            text: JSON.stringify(event.metadata),
          }),
          rowMeta(
            event.actorAgentId
              ? `actor ${shortId(event.actorAgentId)}`
              : "system/owner event",
            event.resourceId
              ? `resource ${shortId(event.resourceId)}`
              : "no resource",
            relativeTime(event.createdAt),
          ),
        ]),
      ]),
    );
  return ledgerPanel(
    "Audit relay",
    `The latest ${state.snapshot.recentEvents.length} retained ordered events. Current cursor ${state.snapshot.latestEventCursor}.`,
    listOrEmpty(rows, "No durable coordination event has been recorded."),
  );
}

function renderView() {
  if (!state.snapshot) return;
  const [kicker, title] = views[state.view];
  document.querySelector("#view-kicker").textContent = kicker;
  document.querySelector("#view-title").textContent = title;
  document.title = `${title} · AgentConduit`;
  for (const button of document.querySelectorAll("[data-view]")) {
    if (button.dataset.view === state.view)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  const renderer = {
    overview: overviewView,
    devices: devicesView,
    agents: agentsView,
    jobs: jobsView,
    integrations: integrationsView,
    messages: messagesView,
    reconciliation: reconciliationView,
    audit: auditView,
  }[state.view];
  content.replaceChildren(renderer());
}

function setView(view, focus = true) {
  if (!views[view]) return;
  state.view = view;
  renderView();
  if (focus) content.focus();
}

function confirmAction(title, copy, label) {
  confirmTitle.textContent = title;
  confirmCopy.textContent = copy;
  confirmButton.textContent = label;
  return new Promise((resolve) => {
    confirmDialog.addEventListener(
      "close",
      () => resolve(confirmDialog.returnValue === "confirm"),
      { once: true },
    );
    confirmDialog.showModal();
  });
}

async function mutate(label, operation) {
  setNotice(`${label}…`);
  try {
    await operation();
    await refreshSnapshot({ focus: false, quiet: true });
    setNotice();
    announce(`${label} completed`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      showLogin("Your owner session ended. Sign in again.");
      return;
    }
    setNotice(
      `${label} did not complete. ${error instanceof Error ? error.message : "The Hub rejected the request."}`,
      "error",
    );
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = loginForm.querySelector("button[type=submit]");
  const tokenInput = document.querySelector("#owner-token");
  const token = tokenInput.value;
  tokenInput.value = "";
  submit.disabled = true;
  loginError.hidden = true;
  try {
    const session = await request("/api/v1/auth/login", {
      method: "POST",
      body: { token },
    });
    await showApp(session);
  } catch (error) {
    loginError.textContent =
      error instanceof ApiError && error.status === 401
        ? "The owner token was not accepted. Read it from the protected Hub token file and try again."
        : "The Hub login endpoint is unavailable. Check the HTTPS boundary and Hub readiness.";
    loginError.hidden = false;
    tokenInput.focus();
  } finally {
    submit.disabled = false;
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.view) {
    setView(target.dataset.view);
    return;
  }
  if (target.id === "refresh-button") {
    await refreshSnapshot({ focus: true });
    return;
  }
  if (target.id === "logout-button") {
    try {
      await request("/api/v1/auth/logout", { method: "POST", mutation: true });
    } finally {
      showLogin("Owner session ended.");
    }
    return;
  }
  if (target.dataset.action === "revoke-device") {
    const device = state.snapshot.devices.find(
      (item) => item.deviceId === target.dataset.deviceId,
    );
    const confirmed = await confirmAction(
      "Revoke this device?",
      `${device?.name ?? "This device"} will immediately lose Hub access. Existing uncertain leases and integration claims will remain preserved for reconciliation.`,
      "Revoke device",
    );
    if (confirmed) {
      await mutate("Revoke device", () =>
        request("/api/v1/admin/devices/revoke", {
          method: "POST",
          mutation: true,
          body: { deviceId: target.dataset.deviceId },
        }),
      );
    }
    return;
  }
  if (target.dataset.action === "cancel-integration") {
    const integration = state.snapshot.integrations.find(
      (item) => item.requestId === target.dataset.requestId,
    );
    const confirmed = await confirmAction(
      "Cancel this unclaimed request?",
      `${integration?.sourceRef ?? "The source"} will leave the queue for ${integration?.targetRef ?? "the target"}. The Hub will refuse this action if a claimant has acquired authority.`,
      "Cancel request",
    );
    if (confirmed) {
      await mutate("Cancel integration request", () =>
        request("/api/v1/admin/integrations/cancel", {
          method: "POST",
          mutation: true,
          body: { requestId: target.dataset.requestId },
        }),
      );
    }
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.id === "login-form") return;
  event.preventDefault();
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const data = new FormData(form);
    if (form.id === "message-form") {
      await mutate("Send owner message", () =>
        request("/api/v1/admin/messages", {
          method: "POST",
          mutation: true,
          body: {
            recipientAgentId: String(data.get("recipientAgentId") ?? ""),
            body: String(data.get("body") ?? ""),
          },
        }),
      );
      form.reset();
      return;
    }
    if (form.id === "reconciliation-form") {
      await mutate("Open reconciliation", () =>
        request("/api/v1/admin/reconciliations", {
          method: "POST",
          mutation: true,
          body: {
            agentId: String(data.get("agentId") ?? ""),
            reason: String(data.get("reason") ?? ""),
          },
        }),
      );
      form.reset();
    }
  } finally {
    submit.disabled = false;
  }
});

async function bootstrap() {
  try {
    const session = await request("/api/v1/auth/session");
    await showApp(session);
  } catch {
    showLogin();
  }
}

void bootstrap();
