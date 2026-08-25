import { selectHostSessions, sendControl } from "../host-control";

export async function showPluginLogs(runtimeId?: string): Promise<void> {
  const sessions = await selectHostSessions(runtimeId);
  const records = (
    await Promise.all(
      sessions.map((snapshot) =>
        sendControl(snapshot.session, "logs", runtimeId ? { runtimeId } : {}),
      ),
    )
  )
    .flat()
    .sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence,
    );
  if (records.length === 0) {
    console.log("No plugin lifecycle records.");
    return;
  }
  for (const record of records) {
    console.log(
      `${record.timestamp} ${record.runtimeId} ${record.event}${record.error ? ` — ${record.error}` : ""}`,
    );
  }
}
