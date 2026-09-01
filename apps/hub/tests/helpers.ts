import {
  CoordinationStore,
  repositoryIdForProjectId,
  type DeviceCredential,
  type GitWorkspaceSnapshot,
  type RemoteWorkspaceAttestation,
} from "@agentconduit/core";

export function enrollDevice(
  store: CoordinationStore,
  name: string,
): DeviceCredential {
  const enrollment = store.createDeviceEnrollment();
  return store.enrollDevice(enrollment.enrollmentCode, {
    name,
    platform: "linux",
    architecture: "x64",
    nodeVersion: "0.1.0",
    capabilities: ["mcp", "event-stream"],
    health: {
      status: "healthy",
      uptimeSeconds: 60,
      memoryUsedPercent: 32,
      loadAverage1: 0.2,
    },
  });
}

export function workspace(
  deviceId: string,
  projectId: string,
  worktreeSuffix: string,
  branch: string,
  head = "a".repeat(40),
): RemoteWorkspaceAttestation {
  const repositoryId = repositoryIdForProjectId(projectId);
  const worktreeId = `wt_${worktreeSuffix.repeat(32).slice(0, 32)}`;
  const rootPath = `device://${deviceId}/workspaces/${worktreeId}`;
  const snapshot: GitWorkspaceSnapshot = {
    repositoryId,
    projectId,
    worktreeId,
    rootPath,
    commonGitDir: `device://${deviceId}/repositories/${repositoryId}`,
    gitDir: `${rootPath}/git`,
    remoteUrl: "github.com/example/agentconduit",
    branch,
    headOid: head,
    dirty: false,
    upstream: { status: "unavailable", ref: `origin/${branch}` },
    isBare: false,
    observedAt: new Date().toISOString(),
  };
  return { snapshot, pathLabel: `${branch.replaceAll("/", "-")}-checkout` };
}
