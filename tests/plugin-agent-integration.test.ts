import type {
  PluginManagementSnapshot,
  PluginMarketInstallationSnapshot,
  PluginMarketPlugin,
  PluginMarketSearchRequest,
} from "../packages/contracts/src/index.ts";
import {
  createInstalledPluginsResource,
  createPluginManagementModule,
  registerPluginManagementAgentIntegration,
  type PluginManagementAgentRegistrationOptions,
} from "../components/plugin/management/src/index.ts";
import {
  createPluginMarketModule,
  createPluginMarketResource,
  registerPluginMarketAgentIntegration,
  type PluginMarketAgentRegistrationOptions,
} from "../components/plugin/market/src/index.ts";
import type {
  AgentResourceMap,
  AgentToolDefinition,
  AgentToolHandler,
  JsonObject,
  JsonValue,
  PluginContext,
} from "../packages/plugin-sdk/src/index.ts";
import type { PluginKernel } from "../packages/plugin-system/src/index.ts";
import {
  AgentResourceRegistry,
  AgentToolRegistry,
  type AgentToolSnapshot,
} from "../packages/plugin-system/src/runtime-registries.ts";
import assert from "node:assert/strict";
import test from "node:test";

const installedPlugin: PluginManagementSnapshot = {
  id: "example.backup",
  version: "1.0.0",
  publisher: "example.publisher",
  source: "installed",
  trust: "package-full-trust",
  digest: "1".repeat(64),
  installedAt: "2026-08-27T10:00:00.000Z",
  enabled: true,
  entries: [
    {
      id: "host",
      runtimeId: "private.runtime.example.backup.host",
      runtime: "host",
      enabled: true,
      state: "failed",
      uses: { "seashard.private": ["secretMethod"] },
      error: "failed at C:/Users/Alice/Private/plugin/index.js",
    },
  ],
};

const developmentPlugin: PluginManagementSnapshot = {
  ...installedPlugin,
  id: "example.development",
  version: "1.1.0-dev",
  source: "development",
  trust: "local-full-trust",
  digest: "2".repeat(64),
  enabled: false,
  entries: [],
};

const marketPlugin: PluginMarketPlugin = {
  id: "example.backup",
  name: "Example Backup",
  summary: "Backs up managed servers.",
  owners: ["alice"],
  source: {
    type: "github",
    repository: "example/backup",
    url: "https://github.com/example/backup",
  },
  license: "MIT",
  releases: [
    {
      version: "1.2.0",
      tag: "v1.2.0",
      releaseUrl: "https://github.com/example/backup/releases/tag/v1.2.0",
      downloadUrl: "https://github.com/example/backup/releases/download/v1.2.0/plugin.zip",
      archiveSha256: "3".repeat(64),
      packageDigest: "4".repeat(64),
      publisher: "example.publisher",
      compatibility: { seaShard: ">=0.0.0 <1.0.0", clientProtocol: ">=1 <2" },
      entries: [
        {
          id: "host",
          runtime: "host",
          uses: {},
          hostProfiles: ["electron"],
        },
      ],
      fileCount: 5,
      unpackedSize: 2_048,
      yanked: false,
    },
    {
      version: "1.1.0",
      tag: "v1.1.0",
      releaseUrl: "https://github.com/example/backup/releases/tag/v1.1.0",
      downloadUrl: "https://github.com/example/backup/releases/download/v1.1.0/plugin.zip",
      archiveSha256: "5".repeat(64),
      packageDigest: "6".repeat(64),
      publisher: "example.publisher",
      compatibility: { seaShard: ">=0.0.0 <1.0.0" },
      entries: [{ id: "host", runtime: "host", uses: {} }],
      fileCount: 4,
      unpackedSize: 1_024,
      yanked: true,
    },
  ],
};

const currentInstallation: PluginMarketInstallationSnapshot = {
  id: "example.backup",
  version: "1.0.0",
  digest: "1".repeat(64),
  source: "installed",
  enabled: true,
};

interface PluginAgentHarness {
  readonly resources: AgentResourceRegistry;
  readonly tools: AgentToolRegistry;
  dispose(): void;
}

function createPluginAgentHarness(
  management: PluginManagementAgentRegistrationOptions,
  market: PluginMarketAgentRegistrationOptions,
): PluginAgentHarness {
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
  registerPluginManagementAgentIntegration(context, management);
  registerPluginMarketAgentIntegration(context, market);
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

function requireJsonObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value;
}

function projectedEntryEnabledValues(value: JsonValue | undefined): readonly JsonValue[] {
  const plugin = requireJsonObject(value, "projected plugin");
  if (!Array.isArray(plugin.entries)) throw new TypeError("projected plugin must contain entries");
  return plugin.entries.map((entry) => requireJsonObject(entry, "projected entry").enabled ?? null);
}

function marketResult(request: PluginMarketSearchRequest) {
  return {
    totalCount: 1,
    page: request.page,
    pageSize: request.pageSize,
    fetchedAt: "2026-08-27T12:00:00.000Z",
    plugins: [marketPlugin],
  } as const;
}

function createReadRequest(path: "installed" | "market", input: JsonValue) {
  return {
    uri: {
      href: `plugin://${path}`,
      scheme: "plugin",
      path,
      query: {},
    },
    pathParams: {},
    input,
  } as const;
}

await test("plugin Agent resources project installed state and trusted market metadata", async () => {
  const managementListCalls: number[] = [];
  const marketRequests: PluginMarketSearchRequest[] = [];
  const harness = createPluginAgentHarness(
    {
      list: async () => {
        managementListCalls.push(1);
        return [installedPlugin, developmentPlugin];
      },
      setEnabled: async () => installedPlugin,
      uninstall: async () => {},
    },
    {
      search: async (request) => {
        marketRequests.push(request);
        return marketResult(request);
      },
      listInstalled: async () => [currentInstallation],
      install: async () => currentInstallation,
    },
  );

  const snapshot = harness.resources.snapshot();
  assert.deepEqual(
    snapshot.definitions.map(({ pattern }) => pattern),
    ["plugin://installed", "plugin://market"],
  );
  assert.deepEqual(
    harness.tools.snapshot().map(({ name, definition }) => ({
      name,
      confirmationLevel: definition.confirmationLevel,
    })),
    [
      { name: "plugin_install", confirmationLevel: 2 },
      { name: "plugin_set-enabled", confirmationLevel: 1 },
      { name: "plugin_uninstall", confirmationLevel: 1 },
    ],
  );

  const installedRead = snapshot.prepare("plugin://installed", {
    page: 1,
    pageSize: 20,
    enabled: true,
    source: "installed",
  });
  assert.deepEqual(await installedRead.presentRequest(), [
    { value: "1～20" },
    { label: "状态", value: "已启用" },
    { label: "来源", value: "正式安装" },
  ]);
  const installedResult = await installedRead.read();
  assert.equal(managementListCalls.length, 1);
  const installedJson = JSON.stringify(installedResult.content);
  assert.match(installedJson, /example\.backup/u);
  assert.doesNotMatch(
    installedJson,
    /digest|runtimeId|uses|secretMethod|C:\/Users|Private|failed at/u,
  );
  assert.deepEqual(await installedRead.presentResult(installedResult), [
    { value: "1", unit: "个插件" },
  ]);

  const oversizedInstalledResource = createInstalledPluginsResource({
    list: async () => [
      {
        ...installedPlugin,
        entries: Array.from({ length: 51 }, (_, index) => ({
          ...installedPlugin.entries[0]!,
          id: `entry-${index}`,
        })),
      },
    ],
    setEnabled: async () => installedPlugin,
    uninstall: async () => {},
  });
  const oversizedInstalledResult = await oversizedInstalledResource.implementation.read(
    createReadRequest("installed", {}),
    {},
  );
  const oversizedInstalledJson = JSON.stringify(oversizedInstalledResult.content);
  assert.match(oversizedInstalledJson, /"entryCount":51,"omittedEntryCount":1/u);
  assert.doesNotMatch(oversizedInstalledJson, /"id":"entry-50"/u);

  const marketRead = snapshot.prepare("plugin://market", {
    query: "backup",
    page: 1,
    pageSize: 10,
    refresh: false,
  });
  assert.deepEqual(await marketRead.presentRequest(), [
    { value: "backup" },
    { label: "范围", value: "1～10" },
  ]);
  const marketReadResult = await marketRead.read();
  assert.deepEqual(marketRequests, [{ query: "backup", page: 1, pageSize: 10, refresh: false }]);
  const marketJson = JSON.stringify(marketReadResult.content);
  assert.match(marketJson, /Example Backup|1\.2\.0|example\/backup/u);
  assert.doesNotMatch(
    marketJson,
    /downloadUrl|releaseUrl|archiveSha256|packageDigest|plugin\.zip|releases\/tag|"digest"/u,
  );
  assert.deepEqual(await marketRead.presentResult(marketReadResult), [
    { value: "1", unit: "个插件" },
  ]);

  const invalidInstalledInputs: JsonValue[] = [
    null,
    { unknown: true },
    { page: 0 },
    { pageSize: 51 },
    { enabled: null },
    { source: "builtin" },
  ];
  for (const invalid of invalidInstalledInputs) {
    assert.throws(() => snapshot.prepare("plugin://installed", invalid), /不符合 inputSchema/u);
  }
  const invalidMarketInputs: JsonValue[] = [
    null,
    { unknown: true },
    { query: "x".repeat(101) },
    { page: 0 },
    { pageSize: 21 },
    { refresh: null },
  ];
  for (const invalid of invalidMarketInputs) {
    assert.throws(() => snapshot.prepare("plugin://market", invalid), /不符合 inputSchema/u);
  }

  const installedResource = createInstalledPluginsResource({
    list: async () => [installedPlugin],
    setEnabled: async () => installedPlugin,
    uninstall: async () => {},
  });
  await assert.rejects(
    installedResource.implementation.read(createReadRequest("installed", { unknown: true }), {}),
    /不支持参数/u,
  );
  const marketResource = createPluginMarketResource({
    search: async (request) => marketResult(request),
    listInstalled: async () => [],
    install: async () => currentInstallation,
  });
  await assert.rejects(
    marketResource.implementation.read(createReadRequest("market", { unknown: true }), {}),
    /不支持参数/u,
  );

  const staleInstalled = snapshot.prepare("plugin://installed", {});
  const staleMarket = snapshot.prepare("plugin://market", {});
  const staleTool = requireTool(harness.tools, "plugin_install");
  harness.dispose();
  assert.equal(harness.resources.snapshot().definitions.length, 0);
  assert.equal(harness.tools.snapshot().length, 0);
  await assert.rejects(staleInstalled.read(), /Agent 资源已停止/u);
  await assert.rejects(staleMarket.read(), /Agent 资源已停止/u);
  await assert.rejects(
    staleTool.execute({ pluginId: marketPlugin.id, version: "1.2.0" }, {}),
    /Agent 工具已停止/u,
  );
});

await test("plugin Agent tools return bounded before/after receipts around domain transactions", async () => {
  let managedPlugins: PluginManagementSnapshot[] = [installedPlugin, developmentPlugin];
  let marketInstallations: PluginMarketInstallationSnapshot[] = [];
  const enabledCalls: Array<{ readonly pluginId: string; readonly enabled: boolean }> = [];
  const uninstallCalls: string[] = [];
  const installCalls: Array<{
    readonly pluginId: string;
    readonly version: string;
    readonly acknowledgeFullMachineAccess: true;
  }> = [];
  const harness = createPluginAgentHarness(
    {
      list: async () => managedPlugins,
      setEnabled: async (pluginId, enabled) => {
        enabledCalls.push({ pluginId, enabled });
        const current = managedPlugins.find((plugin) => plugin.id === pluginId)!;
        const entries = current.entries.map((entry) => ({
          ...entry,
          enabled,
          state: enabled ? ("active" as const) : ("inactive" as const),
        }));
        const updated = { ...current, enabled: entries.every((entry) => entry.enabled), entries };
        managedPlugins = managedPlugins.map((plugin) =>
          plugin.id === pluginId ? updated : plugin,
        );
        return updated;
      },
      uninstall: async (pluginId) => {
        uninstallCalls.push(pluginId);
        managedPlugins = managedPlugins.filter((plugin) => plugin.id !== pluginId);
      },
    },
    {
      search: async (request) => marketResult(request),
      listInstalled: async () => marketInstallations,
      install: async (request) => {
        installCalls.push(request);
        const installed = {
          id: request.pluginId,
          version: request.version,
          digest: "4".repeat(64),
          source: "installed",
          enabled: true,
        } as const;
        marketInstallations = [installed];
        return installed;
      },
    },
  );

  const setEnabled = requireTool(harness.tools, "plugin_set-enabled");
  const disabled = requireJsonObject(
    await setEnabled.execute({ pluginId: installedPlugin.id, enabled: false }, {}),
    "set-enabled receipt",
  );
  assert.equal(requireJsonObject(disabled.before, "set-enabled before").enabled, true);
  assert.equal(requireJsonObject(disabled.after, "set-enabled after").enabled, false);
  assert.deepEqual(enabledCalls, [{ pluginId: installedPlugin.id, enabled: false }]);

  const unchanged = requireJsonObject(
    await setEnabled.execute({ pluginId: installedPlugin.id, enabled: false }, {}),
    "unchanged set-enabled receipt",
  );
  assert.deepEqual(unchanged.before, unchanged.after);
  assert.equal(enabledCalls.length, 2);

  const mixedPlugin: PluginManagementSnapshot = {
    ...installedPlugin,
    enabled: false,
    entries: [
      installedPlugin.entries[0]!,
      {
        ...installedPlugin.entries[0]!,
        id: "client",
        runtimeId: "private.runtime.example.backup.client",
        enabled: false,
        state: "inactive",
      },
    ],
  };
  managedPlugins = [mixedPlugin, developmentPlugin];
  const converged = requireJsonObject(
    await setEnabled.execute({ pluginId: installedPlugin.id, enabled: false }, {}),
    "mixed set-enabled receipt",
  );
  assert.deepEqual(projectedEntryEnabledValues(converged.before), [true, false]);
  assert.deepEqual(projectedEntryEnabledValues(converged.after), [false, false]);
  assert.equal(enabledCalls.length, 3);

  const install = requireTool(harness.tools, "plugin_install");
  const installed = requireJsonObject(
    await install.execute({ pluginId: marketPlugin.id, version: "1.2.0" }, {}),
    "install receipt",
  );
  assert.equal(installed.before, null);
  assert.deepEqual(installed.after, {
    id: marketPlugin.id,
    version: "1.2.0",
    source: "installed",
    enabled: true,
  });
  assert.deepEqual(installCalls, [
    {
      pluginId: marketPlugin.id,
      version: "1.2.0",
      acknowledgeFullMachineAccess: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(installed), /digest|downloadUrl|archiveSha256/u);

  const alreadyInstalled = requireJsonObject(
    await install.execute({ pluginId: marketPlugin.id, version: "9.9.9" }, {}),
    "already-installed receipt",
  );
  assert.deepEqual(alreadyInstalled.before, alreadyInstalled.after);
  assert.equal(requireJsonObject(alreadyInstalled.after, "installed state").version, "1.2.0");
  assert.equal(installCalls.length, 1);

  const uninstall = requireTool(harness.tools, "plugin_uninstall");
  await assert.rejects(
    uninstall.execute({ pluginId: developmentPlugin.id }, {}),
    /开发覆盖插件不能卸载/u,
  );
  assert.deepEqual(uninstallCalls, []);
  const uninstalled = requireJsonObject(
    await uninstall.execute({ pluginId: installedPlugin.id }, {}),
    "uninstall receipt",
  );
  assert.deepEqual(uninstallCalls, [installedPlugin.id]);
  assert.equal(requireJsonObject(uninstalled.before, "uninstall before").id, installedPlugin.id);
  assert.equal(uninstalled.after, null);
  assert.doesNotMatch(JSON.stringify(uninstalled), /digest|runtimeId|uses|C:\/Users/u);

  const invalidSetInputs: JsonValue[] = [
    null,
    {},
    { pluginId: "invalid/id", enabled: true },
    { pluginId: installedPlugin.id, enabled: null },
    { pluginId: installedPlugin.id, enabled: true, unknown: true },
  ];
  for (const invalid of invalidSetInputs) {
    await assert.rejects(setEnabled.execute(invalid, {}), /必须|不支持|不符合 inputSchema/u);
  }
  const invalidInstallInputs: JsonValue[] = [
    null,
    {},
    { pluginId: "invalid/id", version: "1.0.0" },
    { pluginId: marketPlugin.id, version: "" },
    { pluginId: marketPlugin.id, version: "x".repeat(101) },
    { pluginId: marketPlugin.id, version: "1.0.0", acknowledgeFullMachineAccess: true },
  ];
  for (const invalid of invalidInstallInputs) {
    await assert.rejects(install.execute(invalid, {}), /必须|不支持|不符合 inputSchema/u);
  }
  harness.dispose();
});

await test("plugin Agent integrations propagate domain failures and Invocation cancellation", async () => {
  const domainError = new Error("plugin installation failed");
  const failing = createPluginAgentHarness(
    {
      list: async () => [installedPlugin],
      setEnabled: async () => installedPlugin,
      uninstall: async () => {},
    },
    {
      search: async (request) => marketResult(request),
      listInstalled: async () => [],
      install: async () => {
        throw domainError;
      },
    },
  );
  await assert.rejects(
    requireTool(failing.tools, "plugin_install").execute(
      { pluginId: marketPlugin.id, version: "1.2.0" },
      {},
    ),
    (error: unknown) => error === domainError,
  );
  failing.dispose();

  const preAborted = new AbortController();
  preAborted.abort();
  let preAbortedLists = 0;
  const resource = createInstalledPluginsResource({
    list: async () => {
      preAbortedLists += 1;
      return [installedPlugin];
    },
    setEnabled: async () => installedPlugin,
    uninstall: async () => {},
  });
  await assert.rejects(
    resource.implementation.read(createReadRequest("installed", {}), {
      signal: preAborted.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(preAbortedLists, 0);

  const duringMarketRead = new AbortController();
  const canceledMarket = createPluginMarketResource({
    search: async (request) => {
      duringMarketRead.abort();
      return marketResult(request);
    },
    listInstalled: async () => [],
    install: async () => currentInstallation,
  });
  await assert.rejects(
    canceledMarket.implementation.read(createReadRequest("market", {}), {
      signal: duringMarketRead.signal,
    }),
    { name: "AbortError" },
  );

  const duringManagementList = new AbortController();
  let canceledMutations = 0;
  const canceledManagement = createPluginAgentHarness(
    {
      list: async () => {
        duringManagementList.abort();
        return [installedPlugin];
      },
      setEnabled: async () => {
        canceledMutations += 1;
        return installedPlugin;
      },
      uninstall: async () => {},
    },
    {
      search: async (request) => marketResult(request),
      listInstalled: async () => [],
      install: async () => currentInstallation,
    },
  );
  await assert.rejects(
    requireTool(canceledManagement.tools, "plugin_set-enabled").execute(
      { pluginId: installedPlugin.id, enabled: false },
      { signal: duringManagementList.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(canceledMutations, 0);
  canceledManagement.dispose();

  const afterInstall = new AbortController();
  let completedInstallations = 0;
  const canceledAfterInstall = createPluginAgentHarness(
    {
      list: async () => [installedPlugin],
      setEnabled: async () => installedPlugin,
      uninstall: async () => {},
    },
    {
      search: async (request) => marketResult(request),
      listInstalled: async () => [],
      install: async () => {
        completedInstallations += 1;
        afterInstall.abort();
        return currentInstallation;
      },
    },
  );
  await assert.rejects(
    requireTool(canceledAfterInstall.tools, "plugin_install").execute(
      { pluginId: marketPlugin.id, version: "1.2.0" },
      { signal: afterInstall.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(completedInstallations, 1);
  canceledAfterInstall.dispose();
});

await test("plugin management and market modules register their own Agent capabilities", async () => {
  const managementResources: string[] = [];
  const managementTools: string[] = [];
  const managementContext = createModuleContext(managementResources, managementTools);
  const managementKernel = {
    listThirdPartyPlugins: async () => [installedPlugin],
    setThirdPartyPluginEnabled: async () => installedPlugin,
    uninstallThirdPartyPlugin: async () => {},
  } as unknown as PluginKernel;
  await createPluginManagementModule(managementKernel).apply(managementContext, null);
  assert.deepEqual(managementResources, ["plugin://installed"]);
  assert.deepEqual(managementTools.sort(), ["plugin_set-enabled", "plugin_uninstall"]);

  const marketResources: string[] = [];
  const marketTools: string[] = [];
  const marketContext = createModuleContext(marketResources, marketTools);
  await createPluginMarketModule({
    kernel: managementKernel,
    catalogUrl: "https://registry.test/catalog-v1.json",
    fetchProvider: () => async () => Response.json({ schemaVersion: 1, plugins: [] }),
  }).apply(marketContext, null);
  assert.deepEqual(marketResources, ["plugin://market"]);
  assert.deepEqual(marketTools, ["plugin_install"]);
});

function createModuleContext(resourcePatterns: string[], toolNames: string[]): PluginContext {
  return {
    provide() {},
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
}
