import type {
  ServerConfigurationCatalog,
  ServerConfigurationDocument,
  ServerConfigurationWriteRequest,
} from "../packages/contracts/src/index.ts";
import {
  serverConfigurationContract,
  serverInstanceManagerContract,
} from "../packages/contracts/src/index.ts";
import {
  createServerConfigurationModule,
  createServerConfigurationResource,
  registerServerConfigurationAgentIntegration,
  type ServerConfigurationAgentRegistrationOptions,
} from "../components/server/configuration/src/index.ts";
import type {
  AgentResourceMap,
  AgentToolDefinition,
  AgentToolHandler,
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

const instanceId = "550e8400-e29b-41d4-a716-446655440000";
const initialRevision = "1".repeat(64);
const savedRevision = "2".repeat(64);
const initialContent = "alpha\nbeta\ngamma\n";

const catalog: ServerConfigurationCatalog = {
  instanceId,
  serverType: "paper",
  configurationRootPath: "D:/Private/servers/survival",
  pluginSupported: true,
  serverFiles: [
    { path: "server.properties", name: "server.properties", kind: "properties", scope: "server" },
  ],
  otherFiles: [{ path: "bukkit.yml", name: "bukkit.yml", kind: "yaml", scope: "other" }],
  plugins: [
    {
      name: "Essentials",
      files: [
        {
          path: "plugins/Essentials/config.yml",
          name: "config.yml",
          kind: "yaml",
          scope: "plugin",
          pluginName: "Essentials",
        },
        {
          path: `plugins/${"x".repeat(510)}`,
          name: "oversized.yml",
          kind: "yaml",
          scope: "plugin",
          pluginName: "Essentials",
        },
      ],
    },
  ],
};

const document: ServerConfigurationDocument = {
  instanceId,
  path: "server.properties",
  name: "server.properties",
  kind: "properties",
  scope: "server",
  content: initialContent,
  revision: initialRevision,
  encoding: "utf-8",
  modifiedAt: "2026-08-26T10:00:00.000Z",
};

interface AgentIntegrationHarness {
  readonly resources: AgentResourceRegistry;
  readonly tools: AgentToolRegistry;
  dispose(): void;
}

function createAgentIntegrationHarness(
  options: ServerConfigurationAgentRegistrationOptions,
): AgentIntegrationHarness {
  const resources = new AgentResourceRegistry();
  const tools = new AgentToolRegistry();
  const disposers: Array<() => void> = [];
  const runtimeId = "test.server-configuration";
  const scope = { type: "global", id: "global" } as const;
  const context: Pick<PluginContext, "agentResources" | "agentTool"> = {
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
  };
  registerServerConfigurationAgentIntegration(context, options);
  return {
    resources,
    tools,
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

function createReadRequest(input: JsonValue) {
  return {
    uri: {
      href: `server://instances/${instanceId}/config`,
      scheme: "server",
      path: `instances/${instanceId}/config`,
      query: {},
    },
    pathParams: { instanceId },
    input,
  } as const;
}

await test("server configuration Agent resource lists safe paths and reads bounded excerpts", async () => {
  const listCalls: string[] = [];
  const readCalls: Array<{ readonly instanceId: string; readonly path: string }> = [];
  const harness = createAgentIntegrationHarness({
    list: async (requestedInstanceId) => {
      listCalls.push(requestedInstanceId);
      return catalog;
    },
    read: async (requestedInstanceId, path) => {
      readCalls.push({ instanceId: requestedInstanceId, path });
      return document;
    },
    write: async () => document,
  });

  const snapshot = harness.resources.snapshot();
  assert.deepEqual(
    snapshot.definitions.map(({ pattern }) => pattern),
    ["server://instances/{instanceId}/config"],
  );
  assert.equal(snapshot.definitions[0]?.presentation?.title, "读取服务器配置");
  assert.match(snapshot.definitions[0]?.description ?? "", /不包含.*绝对路径/u);
  assert.deepEqual(
    harness.tools.snapshot().map(({ name }) => name),
    ["server_write-config"],
  );

  const preparedCatalog = snapshot.prepare(`server://instances/${instanceId}/config`, {});
  assert.deepEqual(await preparedCatalog.presentRequest(), [
    { label: "服务器", value: instanceId },
    { value: "配置目录" },
  ]);
  const catalogResult = await preparedCatalog.read();
  assert.deepEqual(listCalls, [instanceId]);
  assert.deepEqual(catalogResult, {
    mimeType: "application/json",
    content: {
      mode: "catalog",
      instanceId,
      serverType: "paper",
      pluginSupported: true,
      serverFiles: [
        {
          path: "server.properties",
          name: "server.properties",
          kind: "properties",
          scope: "server",
        },
      ],
      otherFiles: [{ path: "bukkit.yml", name: "bukkit.yml", kind: "yaml", scope: "other" }],
      plugins: [
        {
          name: "Essentials",
          files: [
            {
              path: "plugins/Essentials/config.yml",
              name: "config.yml",
              kind: "yaml",
              scope: "plugin",
              pluginName: "Essentials",
            },
          ],
        },
      ],
      fileCount: 3,
      omittedFileCount: 1,
    },
  });
  assert.deepEqual(await preparedCatalog.presentResult(catalogResult), [
    { value: "3", unit: "个文件" },
  ]);
  assert.doesNotMatch(JSON.stringify(catalogResult.content), /configurationRootPath|D:\/Private/u);

  const preparedDocument = snapshot.prepare(`server://instances/${instanceId}/config`, {
    path: "server.properties",
    start: 6,
    length: 4,
  });
  assert.deepEqual(await preparedDocument.presentRequest(), [
    { label: "服务器", value: instanceId },
    { label: "文件", value: "server.properties" },
    { label: "范围", value: "6～9", unit: "字符" },
  ]);
  const documentResult = await preparedDocument.read();
  assert.deepEqual(readCalls, [{ instanceId, path: "server.properties" }]);
  assert.deepEqual(documentResult, {
    mimeType: "application/json",
    content: {
      mode: "document",
      path: "server.properties",
      name: "server.properties",
      kind: "properties",
      scope: "server",
      instanceId,
      revision: initialRevision,
      encoding: "utf-8",
      modifiedAt: "2026-08-26T10:00:00.000Z",
      content: "beta",
      range: { start: 6, length: 4, totalLength: initialContent.length, hasMore: true },
    },
  });
  assert.deepEqual(await preparedDocument.presentResult(documentResult), [
    { value: "4", unit: "个字符" },
  ]);

  assert.doesNotThrow(() =>
    snapshot.prepare(`server://instances/${instanceId}/config`, {
      path: "server.properties",
      start: 1_000_000,
      length: 50_000,
    }),
  );
  const schemaInvalidInputs: JsonValue[] = [
    null,
    { unknown: true },
    { path: "" },
    { path: "server.properties", start: -1 },
    { path: "server.properties", start: 1_000_001 },
    { path: "server.properties", length: 0 },
    { path: "server.properties", length: 50_001 },
  ];
  for (const invalid of schemaInvalidInputs) {
    assert.throws(
      () => snapshot.prepare(`server://instances/${instanceId}/config`, invalid),
      /不符合 inputSchema/u,
    );
  }
  await assert.rejects(
    snapshot.prepare(`server://instances/${instanceId}/config`, { start: 1 }).read(),
    /只有读取文件时/u,
  );
  await assert.rejects(
    snapshot.prepare(`server://instances/${instanceId}/config`, { path: "../secret.yml" }).read(),
    /规范实例内相对路径/u,
  );
  await assert.rejects(
    snapshot.prepare(`server://instances/${instanceId}/config`, { path: "   " }).read(),
    /规范实例内相对路径/u,
  );

  const resource = createServerConfigurationResource({
    list: async () => catalog,
    read: async () => document,
    write: async () => document,
  });
  await assert.rejects(
    async () => resource.implementation.read(createReadRequest({ unknown: true }), {}),
    /不支持参数/u,
  );
  await assert.rejects(
    async () => resource.implementation.read(createReadRequest(null), {}),
    /必须是对象/u,
  );

  const stalePrepared = snapshot.prepare(`server://instances/${instanceId}/config`, {});
  const staleTool = requireTool(harness.tools, "server_write-config");
  harness.dispose();
  assert.equal(harness.resources.snapshot().definitions.length, 0);
  assert.equal(harness.tools.snapshot().length, 0);
  await assert.rejects(stalePrepared.read(), /Agent 资源已停止/u);
  await assert.rejects(
    staleTool.execute(
      {
        instanceId,
        path: "server.properties",
        content: initialContent,
        expectedRevision: initialRevision,
      },
      {},
    ),
    /Agent 工具已停止/u,
  );
});

await test("server_write-config validates optimistic writes and returns no configuration body", async () => {
  const writeCalls: ServerConfigurationWriteRequest[] = [];
  const savedDocument: ServerConfigurationDocument = {
    ...document,
    content: "motd=SeaShard\n",
    revision: savedRevision,
    modifiedAt: "2026-08-26T10:01:00.000Z",
  };
  const harness = createAgentIntegrationHarness({
    list: async () => catalog,
    read: async () => document,
    write: async (request) => {
      writeCalls.push(request);
      return savedDocument;
    },
  });
  const tool = requireTool(harness.tools, "server_write-config");
  const input = {
    instanceId,
    path: "server.properties",
    content: savedDocument.content,
    expectedRevision: initialRevision,
  } as const;

  const result = await tool.execute(input, {});
  assert.deepEqual(writeCalls, [input]);
  assert.deepEqual(result, {
    saved: true,
    path: "server.properties",
    name: "server.properties",
    kind: "properties",
    scope: "server",
    instanceId,
    revision: savedRevision,
    encoding: "utf-8",
    modifiedAt: "2026-08-26T10:01:00.000Z",
    contentLength: savedDocument.content.length,
  });
  assert.doesNotMatch(JSON.stringify(result), /"content":|D:\/Private/u);

  const invalidInputs: JsonValue[] = [
    null,
    {},
    { ...input, instanceId: "" },
    { ...input, path: "/server.properties" },
    { ...input, path: "plugins/../secret.yml" },
    { ...input, path: "   " },
    { ...input, content: null },
    { ...input, content: "invalid\0content" },
    { ...input, expectedRevision: "A".repeat(64) },
    { ...input, unknown: true },
  ];
  for (const invalid of invalidInputs) {
    await assert.rejects(
      tool.execute(invalid, {}),
      /必须|不支持|规范|plain identifier|不符合 inputSchema/u,
    );
  }
  assert.equal(writeCalls.length, 1);
  harness.dispose();

  const domainError = new Error("configuration revision is stale");
  const failing = createAgentIntegrationHarness({
    list: async () => catalog,
    read: async () => document,
    write: async () => {
      throw domainError;
    },
  });
  await assert.rejects(
    requireTool(failing.tools, "server_write-config").execute(input, {}),
    (error: unknown) => error === domainError,
  );
  failing.dispose();
});

await test("server configuration Agent integration honors cancellation around domain calls", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  let preAbortedListCalls = 0;
  const resource = createServerConfigurationResource({
    list: async () => {
      preAbortedListCalls += 1;
      return catalog;
    },
    read: async () => document,
    write: async () => document,
  });
  await assert.rejects(
    async () => resource.implementation.read(createReadRequest({}), { signal: preAborted.signal }),
    { name: "AbortError" },
  );
  assert.equal(preAbortedListCalls, 0);

  const duringRead = new AbortController();
  const cancelingResource = createServerConfigurationResource({
    list: async () => catalog,
    read: async () => {
      duringRead.abort();
      return document;
    },
    write: async () => document,
  });
  await assert.rejects(
    async () =>
      cancelingResource.implementation.read(createReadRequest({ path: "server.properties" }), {
        signal: duringRead.signal,
      }),
    { name: "AbortError" },
  );

  const afterWrite = new AbortController();
  let completedWrites = 0;
  const harness = createAgentIntegrationHarness({
    list: async () => catalog,
    read: async () => document,
    write: async () => {
      completedWrites += 1;
      afterWrite.abort();
      return document;
    },
  });
  await assert.rejects(
    requireTool(harness.tools, "server_write-config").execute(
      {
        instanceId,
        path: "server.properties",
        content: initialContent,
        expectedRevision: initialRevision,
      },
      { signal: afterWrite.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(completedWrites, 1);
  harness.dispose();
});

await test("server configuration module registers Agent capabilities beside its Host service", async () => {
  const resourcePatterns: string[] = [];
  const toolNames: string[] = [];
  const providers = new Map<string, unknown>();
  const instanceService = { list: async () => [] };
  const context = {
    service(contract: string) {
      assert.equal(contract, serverInstanceManagerContract);
      return instanceService;
    },
    provide(contract: string, provider: unknown) {
      providers.set(contract, provider);
    },
    agentResources(resources: Parameters<PluginContext["agentResources"]>[0]) {
      resourcePatterns.push(...Object.keys(resources));
    },
    agentTool(
      definition: Parameters<PluginContext["agentTool"]>[0],
      _execute: Parameters<PluginContext["agentTool"]>[1],
    ) {
      const name = `${definition.namespace}_${definition.name}`;
      toolNames.push(name);
      return name;
    },
  } as unknown as PluginContext;

  await createServerConfigurationModule().apply(context, null);
  assert.ok(providers.has(serverConfigurationContract));
  assert.deepEqual(resourcePatterns, ["server://instances/{instanceId}/config"]);
  assert.deepEqual(toolNames, ["server_write-config"]);
});
