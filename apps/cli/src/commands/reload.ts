import { selectHostSessions, sendControl } from "../host-control";

export async function reloadPlugin(runtimeId?: string): Promise<void> {
  const sessions = await selectHostSessions(runtimeId);
  for (const snapshot of sessions) {
    const result = await sendControl(snapshot.session, "reload", runtimeId ? { runtimeId } : {});
    const selected = runtimeId
      ? result.runtime.plugins.filter((plugin) => plugin.runtimeId === runtimeId)
      : result.runtime.plugins.filter((plugin) =>
          result.session.runtimeIds.includes(plugin.runtimeId),
        );
    for (const plugin of selected) {
      console.log(
        `${plugin.runtimeId}: ${plugin.state}${plugin.error ? ` — ${plugin.error}` : ""}`,
      );
    }
  }
}
