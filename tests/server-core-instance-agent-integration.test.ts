import type {
  ServerCoreArtifact,
  ServerCoreDownloadTaskSnapshot,
  ServerCoreManagedDownloadResult,
  ServerCoreType,
  ServerInstanceSnapshot,
} from "../packages/contracts/src/index.ts";
import {
  registerServerCoreCatalogAgentResources,
  type ServerCoreCatalogAgentOptions,
} from "../components/server/core-source/src/index.ts";
import {
  registerServerInstanceAgentTools,
  type CreateManagedServerInstanceRequest,
  type ServerInstanceAgentToolOptions,
} from "../components/server/instance-manager/src/index.ts";
import type {
  AgentResourceMap,
  AgentToolDefinition,
  AgentToolHandler,
  JsonObject,
  JsonValue,
  PluginContext,
} from "../packages/plugin-sdk/src/index.ts";
import {
  AgentResourceRegistry,
  AgentToolRegistry,
  type AgentToolSnapshot,
} from "../packages/plugin-system/src/runtime-registries.ts";
import assert from "node:assert/strict";
import test from "node:test";

const artifactHash = "a".repeat(64);
const instanceId = "server-1";
const createdInstanceId = "server-2";
const coreTypes: readonly ServerCoreType[] = [
  { id: "paper", iconUrl: "seashard-cache://server-core-icon/private-paper-icon" },
  { id: "vanilla", iconUrl: "seashard-cache://server-core-icon/private-vanilla-icon" },
];
const coreArtifact: ServerCoreArtifact = {
  source: "cnb",
  serverType: "paper",
  gameVersion: "1.21.1",
  fileName: "paper-1.21.1.jar",
  url: "https://download.example.invalid/private-paper.jar",
  sha256: artifactHash,
};
const existingInstance: ServerInstanceSnapshot = {
  id: instanceId,
  name: "旧名称",
  rootPath: "C:/private/servers/server-1",
  coreJarPath: "C:/private/servers/server-1/server.jar",
  iconPath: "C:/private/servers/server-1/.server-info/icon.png",
  storageMode: "managed",
  source: "downloaded",
  modLoader: null,
  serverType: "vanilla",
  gameVersion: "1.21.1",
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};
const createdInstance: ServerInstanceSnapshot = {
  ...existingInstance,
  id: createdInstanceId,
  name: "1.21.1-paper",
  rootPath: "C:/private/servers/server-2",
  coreJarPath: "C:/private/servers/server-2/server.jar",
  serverType: "paper",
  createdAt: "2026-08-29T01:00:00.000Z",
  updatedAt: "2026-08-29T01:00:00.000Z",
};
const queuedTask: ServerCoreDownloadTaskSnapshot = {
  id: "core-task-1",
  artifact: coreArtifact,
  destinationPath: "C:/private/servers/server-2/server.jar",
  state: "queued",
  downloadedBytes: 0,
  totalBytes: 2_048,
  connections: 12,
  progress: 0,
  createdAt: "2026-08-29T01:00:00.000Z",
};
const completedTask: ServerCoreDownloadTaskSnapshot = {
  ...queuedTask,
  state: "completed",
  downloadedBytes: 2_048,
  progress: 1,
  finishedAt: "2026-08-29T01:00:01.000Z",
};

function registerResources(options: ServerCoreCatalogAgentOptions): AgentResourceRegistry {
  const registry = new AgentResourceRegistry();
  registerServerCoreCatalogAgentResources(
    {
      agentResources(resources: AgentResourceMap) {
        for (const [pattern, resource] of Object.entries(resources)) {
          registry.register(`test.${pattern}`, { type: "global", id: "global" }, pattern, resource);
        }
      },
    },
    options,
  );
  return registry;
}

function registerTools(options: ServerInstanceAgentToolOptions): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  const context: Pick<PluginContext, "agentTool"> = {
    agentTool(definition: AgentToolDefinition, execute: AgentToolHandler) {
      return registry.register(
        `test.${definition.namespace}.${definition.name}`,
        { type: "global", id: "global" },
        definition,
        execute,
      ).id;
    },
  };
  registerServerInstanceAgentTools(context, options);
  return registry;
}

function requireTool(registry: AgentToolRegistry, name: string): AgentToolSnapshot {
  const tool = registry.snapshot().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing Agent tool ${name}`);
  return tool;
}

function requireObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireArray(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

await test("server core Agent resources publish safe hierarchical catalog identities", async () => {
  const calls: string[] = [];
  const registry = registerResources({
    async listTypes() {
      calls.push("types");
      return coreTypes;
    },
    async listVersions(serverType) {
      calls.push(`versions:${serverType}`);
      return ["1.21.1", "1.21", "1.20.6"];
    },
    async listArtifacts(serverType, gameVersion) {
      calls.push(`artifacts:${serverType}:${gameVersion}`);
      return [coreArtifact];
    },
  });
  assert.deepEqual(
    new Set(registry.snapshot().definitions.map(({ pattern }) => pattern)),
    new Set([
      "server://core-types",
      "server://core-types/{serverType}/versions",
      "server://core-types/{serverType}/versions/{gameVersion}/artifacts",
    ]),
  );

  const types = await registry.snapshot().read("server://core-types", {
    query: "paper",
    page: 1,
    pageSize: 1,
  });
  const typeContent = requireObject(types.content, "core types");
  assert.deepEqual(requireArray(typeContent.items, "core type items"), [
    { serverType: "paper", name: "Paper" },
  ]);

  const versions = await registry
    .snapshot()
    .read("server://core-types/paper/versions", { query: "1.21", page: 1, pageSize: 2 });
  const versionContent = requireObject(versions.content, "core versions");
  assert.deepEqual(requireArray(versionContent.items, "version items"), ["1.21.1", "1.21"]);
  assert.equal(versionContent.serverType, "paper");

  const artifacts = await registry
    .snapshot()
    .read("server://core-types/paper/versions/1.21.1/artifacts", {
      page: 1,
      pageSize: 20,
    });
  const artifactContent = requireObject(artifacts.content, "core artifacts");
  assert.deepEqual(requireArray(artifactContent.items, "artifact items"), [
    {
      source: "cnb",
      serverType: "paper",
      gameVersion: "1.21.1",
      artifactFileName: "paper-1.21.1.jar",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify([typeContent, artifactContent]),
    /iconUrl|private-|download\.example|sha256|destinationPath/u,
  );
  assert.deepEqual(calls, ["types", "versions:paper", "artifacts:paper:1.21.1"]);
});

await test("instance Agent tools create, rename, and delete through bounded domain receipts", async () => {
  let instances: ServerInstanceSnapshot[] = [existingInstance];
  const createRequests: CreateManagedServerInstanceRequest[] = [];
  const waitedTasks: string[] = [];
  const renameCalls: Array<{ instanceId: string; name: string }> = [];
  const deleteCalls: string[] = [];
  const options: ServerInstanceAgentToolOptions = {
    async listInstances() {
      return instances;
    },
    async getDefaultDownloadConnections() {
      return 12;
    },
    async createManaged(request): Promise<ServerCoreManagedDownloadResult> {
      createRequests.push(request);
      return { instanceId: createdInstanceId, task: queuedTask };
    },
    async waitForManagedTask(taskId) {
      waitedTasks.push(taskId);
      instances = [...instances, createdInstance];
    },
    async snapshotManagedTask() {
      return completedTask;
    },
    async rename(targetInstanceId, name) {
      renameCalls.push({ instanceId: targetInstanceId, name });
      const current = instances.find(({ id }) => id === targetInstanceId);
      if (!current) throw new Error("missing instance");
      const renamed = { ...current, name, updatedAt: "2026-08-29T02:00:00.000Z" };
      instances = instances.map((candidate) =>
        candidate.id === targetInstanceId ? renamed : candidate,
      );
      return renamed;
    },
    async delete(targetInstanceId) {
      deleteCalls.push(targetInstanceId);
      instances = instances.filter(({ id }) => id !== targetInstanceId);
    },
  };
  const registry = registerTools(options);
  assert.deepEqual(
    registry.snapshot().map(({ name, definition }) => [name, definition.confirmationLevel]),
    [
      ["server_create-instance", 1],
      ["server_delete-instance", 2],
      ["server_rename-instance", 1],
    ],
  );

  const created = requireObject(
    await requireTool(registry, "server_create-instance").execute(
      {
        serverType: "paper",
        gameVersion: "1.21.1",
        artifactFileName: "paper-1.21.1.jar",
      },
      {},
    ),
    "create receipt",
  );
  assert.equal(created.before, null);
  assert.equal(requireObject(created.after, "created instance").id, createdInstanceId);
  assert.equal(requireObject(created.download, "download receipt").taskId, queuedTask.id);
  assert.deepEqual(createRequests, [
    {
      serverType: "paper",
      gameVersion: "1.21.1",
      artifactFileName: "paper-1.21.1.jar",
      destinationFileName: "server.jar",
      connections: 12,
    },
  ]);
  assert.deepEqual(waitedTasks, [queuedTask.id]);
  assert.doesNotMatch(
    JSON.stringify(created),
    /rootPath|coreJarPath|iconPath|destinationPath|download\.example|sha256|private/u,
  );

  const renamed = requireObject(
    await requireTool(registry, "server_rename-instance").execute(
      { instanceId, name: "生存服务器" },
      {},
    ),
    "rename receipt",
  );
  assert.equal(requireObject(renamed.before, "rename before").name, "旧名称");
  assert.equal(requireObject(renamed.after, "rename after").name, "生存服务器");
  assert.equal(renamed.changed, true);
  assert.deepEqual(renameCalls, [{ instanceId, name: "生存服务器" }]);

  const deleted = requireObject(
    await requireTool(registry, "server_delete-instance").execute({ instanceId }, {}),
    "delete receipt",
  );
  assert.equal(requireObject(deleted.before, "delete before").name, "生存服务器");
  assert.equal(deleted.after, null);
  assert.equal(deleted.registrationRemoved, true);
  assert.equal(deleted.localFilesDeleted, true);
  assert.deepEqual(deleteCalls, [instanceId]);
});

await test("instance creation cancellation after settings lookup does not start a download", async () => {
  const controller = new AbortController();
  let createCalls = 0;
  const registry = registerTools({
    async listInstances() {
      return [existingInstance];
    },
    async getDefaultDownloadConnections() {
      await new Promise<void>((resolveTurn) => queueMicrotask(resolveTurn));
      controller.abort();
      return 8;
    },
    async createManaged() {
      createCalls += 1;
      return { instanceId: createdInstanceId, task: queuedTask };
    },
    async waitForManagedTask() {},
    async snapshotManagedTask() {
      return completedTask;
    },
    async rename() {
      return existingInstance;
    },
    async delete() {},
  });

  await assert.rejects(
    requireTool(registry, "server_create-instance").execute(
      {
        serverType: "paper",
        gameVersion: "1.21.1",
        artifactFileName: "paper-1.21.1.jar",
      },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(createCalls, 0);
});
