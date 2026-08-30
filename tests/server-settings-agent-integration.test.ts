import assert from "node:assert/strict";
import test from "node:test";
import { createServerSettingsModule } from "../components/server/settings/src/index.ts";
import {
  serverSettingsContract,
  type ServerSettingsClientService,
  type ServerSettingsSnapshot,
} from "../packages/contracts/src/index.ts";
import type {
  AgentResourceMap,
  AgentToolDefinition,
  AgentToolHandler,
  JsonValue,
  JsonObject,
  PluginContext,
  PluginStorage,
  PluginStoredDocument,
  ServiceProvider,
} from "../packages/plugin-sdk/src/index.ts";
import {
  AgentResourceRegistry,
  AgentToolRegistry,
  type AgentToolSnapshot,
} from "../packages/plugin-system/src/runtime-registries.ts";

const privateResourceDirectory = "C:/Users/Alice/Private/SeaShard/resources";
const runtimeId = "test.server-settings";
const scope = { type: "global", id: "global" } as const;

class MemoryPluginStorage implements PluginStorage {
  private readonly documents = new Map<string, PluginStoredDocument>();
  constructor(private readonly beforePut?: () => Promise<void>) {}

  async get(key: string): Promise<PluginStoredDocument | undefined> {
    return this.documents.get(key);
  }

  async put(key: string, value: JsonValue): Promise<PluginStoredDocument> {
    await this.beforePut?.();
    const previous = this.documents.get(key);
    const document: PluginStoredDocument = {
      value,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.documents.set(key, document);
    return document;
  }

  async delete(key: string): Promise<boolean> {
    return this.documents.delete(key);
  }
}

interface SettingsAgentHarness {
  readonly resources: AgentResourceRegistry;
  readonly tools: AgentToolRegistry;
  readonly service: ServerSettingsClientService;
  dispose(): void;
}

async function createSettingsAgentHarness(
  storage: PluginStorage = new MemoryPluginStorage(),
): Promise<SettingsAgentHarness> {
  const resources = new AgentResourceRegistry();
  const tools = new AgentToolRegistry();
  const providers = new Map<string, ServiceProvider>();
  const disposers: Array<() => void> = [];
  const context = {
    storage,
    provide(contract: string, provider: ServiceProvider) {
      providers.set(contract, provider);
    },
    agentResources(resourceMap: AgentResourceMap) {
      for (const [pattern, resource] of Object.entries(resourceMap)) {
        const registration = resources.register(runtimeId, scope, pattern, resource);
        disposers.push(registration.dispose);
      }
    },
    agentTool(definition: AgentToolDefinition, execute: AgentToolHandler) {
      const registration = tools.register(runtimeId, scope, definition, execute);
      disposers.push(registration.dispose);
      return registration.id;
    },
  } as unknown as PluginContext;

  await createServerSettingsModule({
    defaultResourceDownloadDirectory: privateResourceDirectory,
    defaultDownloadConnections: 8,
  }).apply(context, null);
  const service = providers.get(serverSettingsContract);
  assert.ok(service, "server settings component must publish its service");
  return {
    resources,
    tools,
    service: service as unknown as ServerSettingsClientService,
    dispose() {
      for (const dispose of disposers.reverse()) dispose();
    },
  };
}

function requireTool(registry: AgentToolRegistry, name: string): AgentToolSnapshot {
  const tool = registry.snapshot().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing Agent tool ${name}`);
  return tool;
}

function projectSettings(snapshot: ServerSettingsSnapshot): JsonValue {
  return {
    defaultDownloadConnections: snapshot.defaultDownloadConnections,
    startupDefaults: {
      minimumMemoryMiB: snapshot.defaultMinimumMemoryMiB,
      maximumMemoryMiB: snapshot.defaultMaximumMemoryMiB,
      serverPort: snapshot.defaultServerPort,
      autoAcceptEula: snapshot.autoAcceptEula,
      jvmArguments: snapshot.defaultJvmArguments,
    },
  };
}

function requireJsonObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected Agent tool result to be a JSON object");
  }
  return value;
}

await test("server settings Agent resource hides Host paths and follows component lifecycle", async () => {
  const harness = await createSettingsAgentHarness();
  const snapshot = harness.resources.snapshot();
  assert.deepEqual(
    snapshot.definitions.map(({ pattern }) => pattern),
    ["server://settings"],
  );
  assert.equal(snapshot.definitions[0]?.presentation?.title, "读取服务器默认设置");
  assert.equal(snapshot.definitions[0]?.presentation?.icon, "wrench");
  assert.match(snapshot.definitions[0]?.description ?? "", /不包含.*宿主绝对路径/u);
  assert.deepEqual(
    harness.tools.snapshot().map(({ name }) => name),
    ["server_set-default-download-connections", "server_update-startup-defaults"],
  );
  assert.deepEqual(
    harness.tools.snapshot().map(({ definition }) => definition.confirmationLevel),
    [1, 2],
  );

  const prepared = snapshot.prepare("server://settings", {});
  const result = await prepared.read();
  assert.deepEqual(result, {
    mimeType: "application/json",
    content: {
      defaultDownloadConnections: 8,
      startupDefaults: {
        minimumMemoryMiB: 512,
        maximumMemoryMiB: 2_048,
        serverPort: 25_565,
        autoAcceptEula: true,
        jvmArguments: "",
      },
    },
  });
  assert.deepEqual(await prepared.presentResult(result), [
    { label: "默认内存", value: "512～2048", unit: "MiB" },
    { label: "默认端口", value: "25565" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(result.content),
    /resourceDownloadDirectory|Users|Alice|Private/u,
  );
  assert.throws(() => snapshot.prepare("server://settings", null), /不符合 inputSchema/u);
  assert.throws(
    () => snapshot.prepare("server://settings", { resourceDownloadDirectory: "D:/Leak" }),
    /不符合 inputSchema/u,
  );

  const staleResource = snapshot.prepare("server://settings", {});
  const staleTool = requireTool(harness.tools, "server_set-default-download-connections");
  harness.dispose();
  assert.equal(harness.resources.snapshot().definitions.length, 0);
  assert.equal(harness.tools.snapshot().length, 0);
  await assert.rejects(staleResource.read(), /Agent 资源已停止/u);
  await assert.rejects(staleTool.execute({ connections: 4 }, {}), /Agent 工具已停止/u);
});

await test("server settings Agent tools persist atomic before-after updates and reject unsafe input", async () => {
  const harness = await createSettingsAgentHarness();
  const setConnections = requireTool(harness.tools, "server_set-default-download-connections");
  const updateStartup = requireTool(harness.tools, "server_update-startup-defaults");
  const initial = await harness.service.get();

  assert.deepEqual(await setConnections.execute({ connections: 16 }, {}), {
    before: projectSettings(initial),
    after: projectSettings({ ...initial, defaultDownloadConnections: 16 }),
    changed: true,
  });

  const beforeStartup = await harness.service.get();
  const expectedAfter: ServerSettingsSnapshot = {
    ...beforeStartup,
    defaultMaximumMemoryMiB: 4_096,
    defaultServerPort: 25_570,
    autoAcceptEula: false,
    defaultJvmArguments: "-XX:+UseG1GC",
  };
  assert.deepEqual(
    await updateStartup.execute(
      {
        maximumMemoryMiB: 4_096,
        serverPort: 25_570,
        autoAcceptEula: false,
        jvmArguments: "-XX:+UseG1GC",
      },
      {},
    ),
    {
      before: projectSettings(beforeStartup),
      after: projectSettings(expectedAfter),
      changed: true,
    },
  );
  assert.deepEqual(await harness.service.get(), expectedAfter);
  assert.equal((await harness.service.get()).resourceDownloadDirectory, privateResourceDirectory);

  assert.deepEqual(await updateStartup.execute({ serverPort: 25_570 }, {}), {
    before: projectSettings(expectedAfter),
    after: projectSettings(expectedAfter),
    changed: false,
  });
  await assert.rejects(updateStartup.execute({ minimumMemoryMiB: 8_192 }, {}), /must not exceed/u);
  await assert.rejects(updateStartup.execute({}, {}), /不符合 inputSchema/u);
  await assert.rejects(updateStartup.execute({ unknown: true }, {}), /不符合 inputSchema/u);
  await assert.rejects(updateStartup.execute({ jvmArguments: "unsafe\0argument" }, {}), /NUL/u);
  await assert.rejects(setConnections.execute({ connections: 0 }, {}), /不符合 inputSchema/u);

  const controller = new AbortController();
  controller.abort();
  for (const [tool, input] of [
    [setConnections, { connections: 4 }],
    [updateStartup, { serverPort: 25_571 }],
  ] as const) {
    await assert.rejects(tool.execute(input, { signal: controller.signal }), /abort/iu);
  }
  assert.deepEqual(await harness.service.get(), expectedAfter);
  harness.dispose();
});

await test("server settings Agent tools finish writes that passed the cancellation window", async () => {
  type WriteCancellationScenario = {
    readonly toolName: string;
    readonly input: JsonValue;
    after(before: ServerSettingsSnapshot): ServerSettingsSnapshot;
  };
  const scenarios: readonly WriteCancellationScenario[] = [
    {
      toolName: "server_set-default-download-connections",
      input: { connections: 12 },
      after: (before) => ({ ...before, defaultDownloadConnections: 12 }),
    },
    {
      toolName: "server_update-startup-defaults",
      input: { serverPort: 25_570 },
      after: (before) => ({ ...before, defaultServerPort: 25_570 }),
    },
  ];

  for (const scenario of scenarios) {
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const storage = new MemoryPluginStorage(async () => {
      markWriteStarted();
      await writeGate;
    });
    const harness = await createSettingsAgentHarness(storage);
    const tool = requireTool(harness.tools, scenario.toolName);
    const before = await harness.service.get();
    const controller = new AbortController();

    const operation = tool.execute(scenario.input, { signal: controller.signal });
    await writeStarted;
    controller.abort();
    releaseWrite();

    const after = scenario.after(before);
    assert.deepEqual(await operation, {
      before: projectSettings(before),
      after: projectSettings(after),
      changed: true,
    });
    assert.deepEqual(await harness.service.get(), after);
    harness.dispose();
  }
});

await test("server settings Agent changed tracks every projected setting field", async () => {
  const harness = await createSettingsAgentHarness();
  const setConnections = requireTool(harness.tools, "server_set-default-download-connections");
  const updateStartup = requireTool(harness.tools, "server_update-startup-defaults");
  const changes: ReadonlyArray<{
    readonly tool: AgentToolSnapshot;
    readonly input: JsonValue;
  }> = [
    { tool: setConnections, input: { connections: 9 } },
    { tool: updateStartup, input: { minimumMemoryMiB: 768 } },
    { tool: updateStartup, input: { maximumMemoryMiB: 4_096 } },
    { tool: updateStartup, input: { serverPort: 25_570 } },
    { tool: updateStartup, input: { autoAcceptEula: false } },
    { tool: updateStartup, input: { jvmArguments: "-XX:+UseG1GC" } },
  ];

  for (const { tool, input } of changes) {
    const result = requireJsonObject(await tool.execute(input, {}));
    assert.equal(result.changed, true, `${tool.name} 应识别投影字段变化`);
  }
  harness.dispose();
});
