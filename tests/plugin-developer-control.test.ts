import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPluginDeveloperControl } from "../apps/desktop/src/main/developer-control.ts";
import { selectDevelopmentHostSnapshots, sendControl } from "../apps/cli/src/host-control.ts";
import {
  pluginDeveloperControlProtocolVersion,
  type PluginDeveloperControlLaunch,
  type PluginDeveloperHostSnapshot,
  type PluginDeveloperSessionDescriptor,
  type PluginKernel,
  type PluginRuntimeLifecycleRecord,
} from "../packages/plugin-system/src/index.ts";

await test("developer control filters default logs and preserves explicit runtime lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-developer-control-"));
  const sessionId = randomBytes(12).toString("hex");
  const launch: PluginDeveloperControlLaunch = {
    protocolVersion: pluginDeveloperControlProtocolVersion,
    sessionId,
    token: randomBytes(32).toString("hex"),
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\seashard-plugin-control-test-${sessionId}`
        : join(directory, `${sessionId}.sock`),
    descriptorPath: join(directory, `${sessionId}.json`),
    mode: "development",
    pluginRoot: directory,
  };
  let pluginId = "example.before";
  let runtimeIds = ["dev:example.before:host"];
  const lifecycle: readonly PluginRuntimeLifecycleRecord[] = [
    {
      sequence: 1,
      timestamp: "2026-08-25T00:00:00.000Z",
      runtimeId: "seashard.core",
      event: "active",
    },
    {
      sequence: 2,
      timestamp: "2026-08-25T00:00:00.001Z",
      runtimeId: "dev:example.before:host",
      event: "active",
    },
    {
      sequence: 3,
      timestamp: "2026-08-25T00:00:00.002Z",
      runtimeId: "dev:example.after:host",
      event: "active",
    },
  ];
  const kernel = {
    runtimeLifecycle(runtimeId?: string) {
      return lifecycle.filter((record) => !runtimeId || record.runtimeId === runtimeId);
    },
    runtimeSnapshot() {
      return { plugins: [] };
    },
    services: {
      snapshot() {
        return [];
      },
    },
  } as unknown as PluginKernel;

  const dispose = await startPluginDeveloperControl({
    kernel,
    launch,
    startedAt: "2026-08-25T00:00:00.000Z",
    pluginId: () => pluginId,
    runtimeIds: () => runtimeIds,
    logRuntimeIds: () => [...new Set(["dev:example.before:host", ...runtimeIds])],
    refreshDevelopmentPlugin: async () => {
      pluginId = "example.after";
      runtimeIds = ["dev:example.after:host"];
    },
    requestShutdown() {},
  });

  try {
    const descriptor = JSON.parse(
      await readFile(launch.descriptorPath, "utf8"),
    ) as PluginDeveloperSessionDescriptor;
    const refreshed = await sendControl(descriptor, "refresh", {});
    assert.equal(refreshed.session.pluginId, "example.after");
    assert.deepEqual(refreshed.session.runtimeIds, ["dev:example.after:host"]);

    const records = await sendControl(descriptor, "logs", {});
    assert.deepEqual(
      records.map((record) => record.runtimeId),
      ["dev:example.before:host", "dev:example.after:host"],
    );
    const explicitRecords = await sendControl(descriptor, "logs", {
      runtimeId: "seashard.core",
    });
    assert.deepEqual(
      explicitRecords.map((record) => record.runtimeId),
      ["seashard.core"],
    );
  } finally {
    await dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("development session selection excludes operation Hosts", () => {
  const snapshot = (
    mode: "development" | "operation",
    sessionId: string,
    runtimeId: string,
  ): PluginDeveloperHostSnapshot => ({
    session: {
      protocolVersion: pluginDeveloperControlProtocolVersion,
      sessionId,
      token: sessionId,
      socketPath: sessionId,
      descriptorPath: sessionId,
      pid: 1,
      startedAt: "2026-08-25T00:00:00.000Z",
      mode,
      runtimeIds: [runtimeId],
    },
    runtime: {
      plugins: [
        {
          runtimeId,
          pluginId: "example.plugin",
          pluginVersion: "1.0.0",
          entryId: "example.host",
          host: "node-plugin-host",
          state: "active",
        },
      ],
    },
    services: [],
  });
  const development = snapshot("development", "development", "dev:example.plugin:example.host");
  const operation = snapshot("operation", "operation", "plugin:example.plugin:example.host");

  assert.deepEqual(selectDevelopmentHostSnapshots([operation, development]), [development]);
  assert.deepEqual(
    selectDevelopmentHostSnapshots([operation, development], development.session.runtimeIds[0]),
    [development],
  );
  assert.deepEqual(
    selectDevelopmentHostSnapshots([operation, development], operation.session.runtimeIds[0]),
    [],
  );
});
