import assert from "node:assert/strict";
import test from "node:test";
import { projectRuntimeSnapshot } from "../components/diagnostics/runtime/src/index.ts";
import type { RuntimeControlSnapshot } from "../packages/plugin-sdk/src/index.ts";

await test("runtime diagnostics projects active and failed Cordis plugins", () => {
  const control: RuntimeControlSnapshot = {
    plugins: [
      {
        runtimeId: "active",
        pluginId: "plugin.active",
        pluginVersion: "1.0.0",
        entryId: "host",
        host: "core",
        state: "active",
      },
      {
        runtimeId: "failed",
        pluginId: "plugin.failed",
        pluginVersion: "1.0.0",
        entryId: "host",
        host: "core",
        state: "failed",
        error: "plugin startup failed",
      },
    ],
  };

  const snapshot = projectRuntimeSnapshot(control, {
    host: "electron",
    startedAt: "2026-08-16T00:00:00.000Z",
    stopping: false,
  });
  assert.equal(snapshot.state, "degraded");
  assert.deepEqual(
    snapshot.components.map(({ id, phase, error }) => ({ id, phase, error })),
    [
      { id: "active", phase: "active", error: undefined },
      { id: "failed", phase: "failed", error: "plugin startup failed" },
    ],
  );

  const stopping = projectRuntimeSnapshot(control, {
    host: "electron",
    startedAt: snapshot.startedAt,
    stopping: true,
  });
  assert.equal(stopping.state, "stopping");
});
