import type {
  ServerInstanceSnapshot,
  ServerWorldBackupSnapshot,
  ServerWorldStorageSnapshot,
} from "../packages/contracts/src/index.ts";
import {
  registerServerWorldAgentIntegration,
  type ServerWorldAgentRegistrationOptions,
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

const instanceId = "server-1";
const currentWorldId = "world";
const targetWorldId = "adventure";
const firstBackup: ServerWorldBackupSnapshot = {
  instanceId,
  worldId: targetWorldId,
  worldDirectoryName: "adventure",
  fileName: "adventure-20260829-120000.zip",
  createdAt: "2026-08-29T12:00:00.000Z",
  sizeBytes: 2_048,
};
const secondBackup: ServerWorldBackupSnapshot = {
  ...firstBackup,
  fileName: "adventure-20260828-120000.ZIP",
  createdAt: "2026-08-28T12:00:00.000Z",
  sizeBytes: 1_024,
};

interface WorldAgentHarness {
  readonly resources: AgentResourceRegistry;
  readonly tools: AgentToolRegistry;
  dispose(): void;
}

function createWorldAgentHarness(options: ServerWorldAgentRegistrationOptions): WorldAgentHarness {
  const resources = new AgentResourceRegistry();
  const tools = new AgentToolRegistry();
  const disposers: Array<() => void> = [];
  const scope = { type: "global", id: "global" } as const;
  const context: Pick<PluginContext, "agentResources" | "agentTool"> = {
    agentResources(resourceMap: AgentResourceMap) {
      for (const [pattern, resource] of Object.entries(resourceMap)) {
        const registration = resources.register(`test.${pattern}`, scope, pattern, resource);
        disposers.push(registration.dispose);
      }
    },
    agentTool(definition: AgentToolDefinition, execute: AgentToolHandler) {
      const registration = tools.register(
        `test.${definition.namespace}.${definition.name}`,
        scope,
        definition,
        execute,
      );
      disposers.push(registration.dispose);
      return registration.id;
    },
  };
  registerServerWorldAgentIntegration(context, options);
  return {
    resources,
    tools,
    dispose() {
      for (const dispose of disposers.reverse()) dispose();
    },
  };
}

function createWorldStorage(currentId = currentWorldId): ServerWorldStorageSnapshot {
  return {
    instanceId,
    mode: "unified",
    currentId,
    saves: [
      {
        id: currentWorldId,
        groupId: currentWorldId,
        name: "生存世界名称非常非常长",
        dimension: "overworld",
        current: currentId === currentWorldId,
        createdAt: "2026-08-20T10:00:00.000Z",
        updatedAt: "2026-08-29T10:00:00.000Z",
        iconDataUrl: "data:image/png;base64,private-world-icon",
      },
      {
        id: targetWorldId,
        groupId: targetWorldId,
        name: "冒险世界名称非常非常长",
        dimension: "overworld",
        current: currentId === targetWorldId,
        updatedAt: "2026-08-29T11:00:00.000Z",
        resourceSource: {
          source: "modrinth",
          id: "adventure-map",
          version: "1.0.0",
          iconUrl: "https://cdn.example.invalid/world.png",
        },
      },
    ],
    dimensions: [],
  };
}

function defaultWorldOptions(
  overrides: Partial<ServerWorldAgentRegistrationOptions> = {},
): ServerWorldAgentRegistrationOptions {
  let storage = createWorldStorage();
  return {
    async listInstances(): Promise<readonly ServerInstanceSnapshot[]> {
      return [
        {
          id: instanceId,
          name: "测试服务器名称非常非常长",
          rootPath: "C:/private/server-1",
          coreJarPath: "C:/private/server-1/server.jar",
          modLoader: null,
          storageMode: "managed",
          source: "downloaded",
          createdAt: "2026-08-20T10:00:00.000Z",
          updatedAt: "2026-08-29T10:00:00.000Z",
        },
      ];
    },
    async listWorldStorage() {
      return storage;
    },
    async listWorldBackups() {
      return [firstBackup, secondBackup];
    },
    async runWhileServerStopped<T>(
      _targetInstanceId: string,
      _action: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      return operation();
    },
    async switchWorld(_targetInstanceId, worldId) {
      storage = createWorldStorage(worldId);
      return storage;
    },
    async createWorldBackup() {
      return firstBackup;
    },
    async restoreWorldBackup() {
      return storage;
    },
    async deleteWorldBackup() {},
    ...overrides,
  };
}

function requireTool(registry: AgentToolRegistry, name: string): AgentToolSnapshot {
  const tool = registry.snapshot().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing Agent tool ${name}`);
  return tool;
}

function requireJsonObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value;
}

function requireJsonArray(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a JSON array`);
  return value;
}

await test("world Agent integration registers resources and confirmed tools", () => {
  const harness = createWorldAgentHarness(defaultWorldOptions());
  assert.deepEqual(
    harness.resources.snapshot().definitions.map(({ pattern }) => pattern),
    [
      "server://instances/{instanceId}/worlds/{worldId}/backups",
      "server://instances/{instanceId}/worlds",
    ],
  );
  assert.deepEqual(
    harness.tools.snapshot().map(({ name, definition }) => [name, definition.confirmationLevel]),
    [
      ["server_create-world-backup", 1],
      ["server_delete-world-backup", 1],
      ["server_restore-world-backup", 2],
      ["server_switch-world", 1],
    ],
  );
  harness.dispose();
});

await test("world and backup resources publish names, paging, and safe projections", async () => {
  const harness = createWorldAgentHarness(defaultWorldOptions());
  const preparedWorlds = harness.resources
    .snapshot()
    .prepare(`server://instances/${instanceId}/worlds`, {});
  assert.deepEqual(await preparedWorlds.presentRequest(), [
    { label: "服务器", value: "测试服务器名称非常非…" },
  ]);
  const worlds = await preparedWorlds.read();
  const worldContent = requireJsonObject(worlds.content, "worlds");
  assert.equal(worldContent.currentId, currentWorldId);
  assert.equal(
    requireJsonObject(requireJsonArray(worldContent.saves, "world saves")[1], "world save").id,
    targetWorldId,
  );
  assert.doesNotMatch(
    JSON.stringify(worldContent),
    /iconDataUrl|iconUrl|private-world-icon|cdn\.example/u,
  );

  const preparedBackups = harness.resources
    .snapshot()
    .prepare(`server://instances/${instanceId}/worlds/${targetWorldId}/backups`, {
      page: 1,
      pageSize: 1,
    });
  assert.deepEqual(await preparedBackups.presentRequest(), [
    { label: "服务器", value: "测试服务器名称非常非…" },
    { label: "世界", value: "冒险世界名称非常非常…" },
    { label: "范围", value: "1～1" },
  ]);
  const backups = await preparedBackups.read();
  const backupContent = requireJsonObject(backups.content, "backups");
  assert.deepEqual(backupContent.pagination, {
    page: 1,
    pageSize: 1,
    totalItems: 2,
    totalPages: 2,
    hasMore: true,
  });
  assert.deepEqual(
    requireJsonObject(requireJsonArray(backupContent.items, "backup items")[0], "backup"),
    {
      instanceId,
      worldId: targetWorldId,
      fileName: firstBackup.fileName,
      createdAt: firstBackup.createdAt,
      sizeBytes: firstBackup.sizeBytes,
    },
  );
  assert.deepEqual(await preparedBackups.presentResult(backups), [{ value: "1", unit: "个备份" }]);
  assert.doesNotMatch(JSON.stringify(backupContent), /worldDirectoryName|private/u);
  await assert.rejects(
    harness.resources
      .snapshot()
      .read(`server://instances/${instanceId}/worlds/${targetWorldId}/backups`, {
        pageSize: 51,
      }),
    /不符合 inputSchema/u,
  );
  harness.dispose();
});

await test("world tools enforce stopped execution and return bounded receipts", async () => {
  const stateChecks: Array<{ instanceId: string; action: string }> = [];
  const switchCalls: JsonObject[] = [];
  const createCalls: JsonObject[] = [];
  const restoreCalls: JsonObject[] = [];
  const deleteCalls: JsonObject[] = [];
  let storage = createWorldStorage();
  const options = defaultWorldOptions({
    async listWorldStorage() {
      return storage;
    },
    async runWhileServerStopped<T>(
      targetInstanceId: string,
      action: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      stateChecks.push({ instanceId: targetInstanceId, action });
      return operation();
    },
    async switchWorld(targetInstanceId, worldId) {
      switchCalls.push({ instanceId: targetInstanceId, worldId });
      storage = createWorldStorage(worldId);
      return storage;
    },
    async createWorldBackup(targetInstanceId, worldId) {
      createCalls.push({ instanceId: targetInstanceId, worldId });
      return firstBackup;
    },
    async restoreWorldBackup(targetInstanceId, worldId, fileName) {
      restoreCalls.push({ instanceId: targetInstanceId, worldId, fileName });
      return storage;
    },
    async deleteWorldBackup(targetInstanceId, worldId, fileName) {
      deleteCalls.push({ instanceId: targetInstanceId, worldId, fileName });
    },
  });
  const harness = createWorldAgentHarness(options);

  const switched = requireJsonObject(
    await requireTool(harness.tools, "server_switch-world").execute(
      { instanceId, worldId: targetWorldId },
      {},
    ),
    "switch world receipt",
  );
  assert.equal(switched.changed, true);
  assert.equal(requireJsonObject(switched.before, "before world").worldId, currentWorldId);
  assert.equal(requireJsonObject(switched.after, "after world").worldId, targetWorldId);
  const unchanged = requireJsonObject(
    await requireTool(harness.tools, "server_switch-world").execute(
      { instanceId, worldId: targetWorldId },
      {},
    ),
    "unchanged world receipt",
  );
  assert.equal(unchanged.changed, false);
  assert.deepEqual(switchCalls, [{ instanceId, worldId: targetWorldId }]);

  const created = requireJsonObject(
    await requireTool(harness.tools, "server_create-world-backup").execute(
      { instanceId, worldId: targetWorldId },
      {},
    ),
    "create backup receipt",
  );
  assert.equal(requireJsonObject(created.backup, "created backup").fileName, firstBackup.fileName);

  const restored = requireJsonObject(
    await requireTool(harness.tools, "server_restore-world-backup").execute(
      { instanceId, worldId: targetWorldId, fileName: secondBackup.fileName },
      {},
    ),
    "restore backup receipt",
  );
  assert.equal(
    requireJsonObject(restored.backup, "restored backup").fileName,
    secondBackup.fileName,
  );
  assert.equal(requireJsonObject(restored.worlds, "restored worlds").currentId, targetWorldId);

  const deleted = requireJsonObject(
    await requireTool(harness.tools, "server_delete-world-backup").execute(
      { instanceId, worldId: targetWorldId, fileName: firstBackup.fileName },
      {},
    ),
    "delete backup receipt",
  );
  assert.equal(requireJsonObject(deleted.before, "deleted backup").fileName, firstBackup.fileName);
  assert.equal(deleted.after, null);
  assert.deepEqual(createCalls, [{ instanceId, worldId: targetWorldId }]);
  assert.deepEqual(restoreCalls, [
    { instanceId, worldId: targetWorldId, fileName: secondBackup.fileName },
  ]);
  assert.deepEqual(deleteCalls, [
    { instanceId, worldId: targetWorldId, fileName: firstBackup.fileName },
  ]);
  assert.deepEqual(stateChecks, [
    { instanceId, action: "切换服务器世界" },
    { instanceId, action: "切换服务器世界" },
    { instanceId, action: "创建世界备份" },
    { instanceId, action: "恢复世界备份" },
    { instanceId, action: "删除世界备份" },
  ]);
  harness.dispose();

  const activeHarness = createWorldAgentHarness(
    defaultWorldOptions({
      async runWhileServerStopped<T>(): Promise<T> {
        throw new Error("需要关停服务器之后才能操作世界备份。");
      },
    }),
  );
  await assert.rejects(
    requireTool(activeHarness.tools, "server_restore-world-backup").execute(
      { instanceId, worldId: targetWorldId, fileName: firstBackup.fileName },
      {},
    ),
    /需要关停服务器/u,
  );
  activeHarness.dispose();
});

await test("world tools honor cancellation after preflight before every mutation", async () => {
  const scenarios: ReadonlyArray<{
    readonly toolName: string;
    readonly input: JsonObject;
    readonly preflight: "worlds" | "backups";
  }> = [
    {
      toolName: "server_switch-world",
      input: { instanceId, worldId: targetWorldId },
      preflight: "worlds",
    },
    {
      toolName: "server_create-world-backup",
      input: { instanceId, worldId: targetWorldId },
      preflight: "worlds",
    },
    {
      toolName: "server_restore-world-backup",
      input: { instanceId, worldId: targetWorldId, fileName: firstBackup.fileName },
      preflight: "backups",
    },
    {
      toolName: "server_delete-world-backup",
      input: { instanceId, worldId: targetWorldId, fileName: firstBackup.fileName },
      preflight: "backups",
    },
  ];

  for (const scenario of scenarios) {
    const controller = new AbortController();
    let mutationCalls = 0;
    const harness = createWorldAgentHarness(
      defaultWorldOptions({
        async listWorldStorage() {
          if (scenario.preflight === "worlds") {
            await new Promise<void>((resolveTurn) => queueMicrotask(resolveTurn));
            controller.abort();
          }
          return createWorldStorage();
        },
        async listWorldBackups() {
          if (scenario.preflight === "backups") {
            await new Promise<void>((resolveTurn) => queueMicrotask(resolveTurn));
            controller.abort();
          }
          return [firstBackup, secondBackup];
        },
        async switchWorld() {
          mutationCalls += 1;
          return createWorldStorage(targetWorldId);
        },
        async createWorldBackup() {
          mutationCalls += 1;
          return firstBackup;
        },
        async restoreWorldBackup() {
          mutationCalls += 1;
          return createWorldStorage(targetWorldId);
        },
        async deleteWorldBackup() {
          mutationCalls += 1;
        },
      }),
    );

    await assert.rejects(
      requireTool(harness.tools, scenario.toolName).execute(scenario.input, {
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
    // waitForInvocation 会立即向调用方传播取消；再等一轮，确认底层预检恢复后也没有进入修改。
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(mutationCalls, 0, `${scenario.toolName} must stop after canceled preflight`);
    harness.dispose();
  }
});
