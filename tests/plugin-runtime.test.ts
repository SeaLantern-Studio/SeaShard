import assert from "node:assert/strict";
import test from "node:test";
import type {
  PreparedPlugin,
  PluginRuntime,
  RunningPlugin,
} from "../packages/plugin-system/src/runtime.ts";
import { PluginRuntime as CordisPluginRuntime } from "../packages/plugin-system/src/runtime.ts";
import type { PluginManifest } from "../packages/plugin-sdk/src/index.ts";
import type { ResolvedEntry } from "../packages/plugin-system/src/types.ts";
import { validManifest } from "./plugin-test-fixtures.ts";

class RecordingBackend {
  readonly events: string[] = [];
  failedVersions = new Set<string>();

  async prepare(entry: ResolvedEntry): Promise<PreparedPlugin> {
    const version = entry.package.manifest.version;
    return {
      dependencies: [],
      provides: [],
      start: async (): Promise<RunningPlugin> => {
        this.events.push(`start:${version}`);
        if (this.failedVersions.has(version)) throw new Error(`version ${version} failed`);
        return {
          stop: async () => {
            this.events.push(`stop:${version}`);
          },
        };
      },
      discard: async () => {
        this.events.push(`discard:${version}`);
      },
    };
  }

  dependencyAvailable(): boolean {
    return true;
  }
}

function entryFor(version: string): ResolvedEntry {
  const manifest: PluginManifest = { ...validManifest, version };
  return {
    package: {
      manifest,
      digest: version.padEnd(64, "0"),
      rootPath: `builtin:${version}`,
      source: "builtin",
      trust: "builtin",
      installedAt: new Date(0).toISOString(),
    },
    entry: manifest.entries[0]!,
    binding: {
      id: "example.runtime",
      pluginId: manifest.id,
      entryId: manifest.entries[0]!.id,
      scopeType: "global",
      scopeId: "global",
      enabled: true,
      config: null,
    },
    runtimeId: "example.runtime",
    host: "core",
  };
}

await test("plugin runtime stops the old Fiber before starting a replacement", async () => {
  const backend = new RecordingBackend();
  const runtime: PluginRuntime = new CordisPluginRuntime(backend);

  await runtime.reconcile([entryFor("1.0.0")]);
  await runtime.reconcile([entryFor("2.0.0")]);

  assert.deepEqual(backend.events, ["start:1.0.0", "stop:1.0.0", "start:2.0.0"]);
  assert.deepEqual(runtime.snapshot().plugins, [
    {
      runtimeId: "example.runtime",
      pluginId: validManifest.id,
      pluginVersion: "2.0.0",
      entryId: validManifest.entries[0]!.id,
      host: "core",
      state: "active",
    },
  ]);
  await runtime.dispose();
});

await test("plugin runtime disables a plugin without stopping the application", async () => {
  const backend = new RecordingBackend();
  const runtime = new CordisPluginRuntime(backend);

  await runtime.reconcile([entryFor("1.0.0")]);
  await runtime.reconcile([]);

  assert.deepEqual(backend.events, ["start:1.0.0", "stop:1.0.0"]);
  assert.deepEqual(runtime.snapshot().plugins, []);
  await runtime.dispose();
});

await test("plugin runtime reports a failed Fiber without persisting runtime state", async () => {
  const backend = new RecordingBackend();
  backend.failedVersions.add("1.0.0");
  const runtime = new CordisPluginRuntime(backend);

  await runtime.reconcile([entryFor("1.0.0")]);

  assert.equal(runtime.snapshot().plugins[0]?.state, "failed");
  assert.match(runtime.snapshot().plugins[0]?.error ?? "", /version 1\.0\.0 failed/);
  await runtime.dispose();
});
