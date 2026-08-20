import assert from "node:assert/strict";
import test from "node:test";
import { projectRuntimeSnapshot } from "../components/diagnostics/runtime/src/index.ts";
import type {
  RuntimeControlSnapshot,
  RuntimeGenerationSnapshot,
  RuntimeOperationSnapshot,
} from "../packages/plugin-sdk/src/index.ts";

await test("runtime diagnostics projects publications, operations, and host state", () => {
  const generation = (
    runtimeId: string,
    generationNumber: number,
    phase: RuntimeGenerationSnapshot["phase"],
  ): RuntimeGenerationSnapshot => ({
    runtimeId,
    pluginId: `plugin.${runtimeId}`,
    pluginVersion: "1.0.0",
    entryId: "host",
    bindingId: runtimeId,
    source: "builtin",
    trust: "builtin",
    scopeType: "global",
    scopeId: "global",
    generation: generationNumber,
    phase,
    upgradeMode: "hot-swap",
    host: "core",
    dependencies: [],
  });
  const operation = (
    runtimeId: string,
    status: RuntimeOperationSnapshot["status"],
    step: RuntimeOperationSnapshot["step"],
    error?: string,
  ): RuntimeOperationSnapshot => ({
    id: `operation.${runtimeId}`,
    runtimeId,
    kind: "activate",
    mode: "hot-swap",
    status,
    step,
    currentGeneration: null,
    candidateGeneration: 1,
    attentionRequired: false,
    ...(error ? { error } : {}),
  });
  const control: RuntimeControlSnapshot = {
    generations: [
      generation("active", 1, "running"),
      generation("active", 2, "failed"),
      generation("blocked", 1, "prepared"),
      generation("failed", 1, "failed"),
      generation("retired", 1, "terminated"),
      generation("updating", 1, "prepared"),
    ],
    publications: [{ runtimeId: "active", generation: 1, epoch: 1 }],
    operations: [
      operation("active", "running", "start-candidate"),
      operation("blocked", "running", "wait-dependencies"),
      operation("failed", "failed", "prepare", "candidate failed"),
      operation("retired", "completed", "stop-previous"),
      operation("updating", "running", "prepare"),
    ],
  };

  const snapshot = projectRuntimeSnapshot(control, {
    host: "electron",
    startedAt: "2026-08-16T00:00:00.000Z",
    stopping: false,
  });
  assert.equal(snapshot.state, "degraded");
  assert.deepEqual(
    snapshot.components.map(({ id, generation: number, phase }) => ({ id, number, phase })),
    [
      { id: "active", number: 1, phase: "active" },
      { id: "blocked", number: 1, phase: "blocked" },
      { id: "failed", number: 1, phase: "failed" },
      { id: "updating", number: 1, phase: "updating" },
    ],
  );
  assert.equal(
    snapshot.components.find((component) => component.id === "failed")?.error,
    "candidate failed",
  );

  const stopping = projectRuntimeSnapshot(control, {
    host: "electron",
    startedAt: snapshot.startedAt,
    stopping: true,
  });
  assert.equal(stopping.state, "stopping");
});
