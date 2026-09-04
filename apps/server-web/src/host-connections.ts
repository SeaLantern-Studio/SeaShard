import type { DesktopHostConnectionsSnapshot } from "@seashard/contracts";
import type { HostConnectionsUiService } from "@seashard/host-connections-ui";
import type { ServerWebStateSnapshot } from "@seashard/server-web-api";
import {
  loadServerWebState,
  mutateServerHostControl,
  type ServerWebEvents,
} from "./client-runtime";

/** 把 Server Web 的本机 Host 状态投影到共享设置页；安装和断线操作仍只属于 Desktop。 */
export function createServerHostConnectionsUiService(
  events: ServerWebEvents,
): HostConnectionsUiService {
  const mutate = async (
    hostId: string,
    action: "request" | "release" | "confirm" | "reject",
    requestId?: string,
  ): Promise<DesktopHostConnectionsSnapshot> => {
    requireLocalHost(hostId);
    return projectHostConnections(await mutateServerHostControl(action, requestId));
  };

  return {
    getSnapshot: async () => projectHostConnections(await loadServerWebState()),
    onChanged: (listener) =>
      events.subscribeState((snapshot) => listener(projectHostConnections(snapshot))),
    requestControl: (hostId) => mutate(hostId, "request"),
    confirmControl: (hostId, requestId) => mutate(hostId, "confirm", requestId),
    rejectControl: (hostId, requestId) => mutate(hostId, "reject", requestId),
    releaseControl: (hostId) => mutate(hostId, "release"),
  };
}

function projectHostConnections(snapshot: ServerWebStateSnapshot): DesktopHostConnectionsSnapshot {
  const host = snapshot.host;
  return {
    revision: host.revision,
    controllerSessionId: host.controllerSessionId,
    hosts: [
      {
        id: host.id,
        label: "本机 Host",
        transport: "local",
        endpoint: "Server Controller 本机",
        isDefault: true,
        state: host.connected ? (host.hasControl ? "control" : "read-only") : "disconnected",
        installation: host.connected ? "installed" : "missing",
        ...(host.holder ? { holder: host.holder } : {}),
        ...(host.pending ? { pending: host.pending } : {}),
        conflictAcknowledged: false,
      },
    ],
  };
}

function requireLocalHost(hostId: string): void {
  if (hostId !== "local") throw new TypeError(`未知的 Server Host：${hostId}`);
}
