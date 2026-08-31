import type { DesktopHostConnection, DesktopHostConnectionsSnapshot } from "@seashard/contracts";

export type DesktopHostPromptKind = "occupied" | "outgoing" | "incoming" | "unavailable";

export interface DesktopHostPrompt {
  host: DesktopHostConnection;
  kind: DesktopHostPromptKind;
}

/** 普通单机控制没有管理负担；只有拓扑或状态值得关注时才显示 Host 外壳。 */
export function shouldShowHostChrome(snapshot?: DesktopHostConnectionsSnapshot): boolean {
  if (!snapshot) return false;
  return (
    snapshot.hosts.length > 1 ||
    snapshot.hosts.some(
      (host) => host.transport !== "local" || host.state !== "control" || Boolean(host.pending),
    )
  );
}

/** 将 Host 状态收敛为唯一应用内决策，避免多个连接同时弹出重叠模态框。 */
export function findHostPrompt(
  snapshot?: DesktopHostConnectionsSnapshot,
): DesktopHostPrompt | undefined {
  if (!snapshot) return undefined;
  for (const host of snapshot.hosts) {
    if (host.pending?.requester.sessionId === snapshot.controllerSessionId) {
      return { host, kind: "outgoing" };
    }
    if (host.pending && host.state === "control") {
      return { host, kind: "incoming" };
    }
  }
  for (const host of snapshot.hosts) {
    if (host.conflictAcknowledged) continue;
    if (host.state === "read-only") return { host, kind: "occupied" };
    if (host.state === "error" || host.state === "disconnected") {
      return { host, kind: "unavailable" };
    }
  }
  return undefined;
}
