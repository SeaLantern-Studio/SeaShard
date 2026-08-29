import type {
  ServerInstalledModSnapshot,
  ServerModDownloadResult,
  ServerModProject,
  ServerModProjectDetails,
  ServerModSearchRequest,
  ServerModSearchResult,
  ServerModSource,
} from "../packages/contracts/src/index.ts";
import {
  registerServerInstalledModAgentIntegration,
  type ServerInstalledModAgentRegistrationOptions,
} from "../components/server/instance-manager/src/index.ts";
import {
  registerServerModCatalogAgentIntegration,
  type ServerModCatalogAgentRegistrationOptions,
} from "../components/server/mod-source/src/index.ts";
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

const installedMod: ServerInstalledModSnapshot = {
  instanceId,
  relativePath: "mods/lithium-fabric-0.14.0.jar",
  fileName: "lithium-fabric-0.14.0.jar",
  name: "Lithium",
  version: "0.14.0",
  description: "A modern optimization mod.",
  iconDataUrl: "data:image/png;base64,private-icon",
  addedAt: "2026-08-27T10:00:00.000Z",
  disabled: false,
  resourceSource: {
    source: "modrinth",
    id: "gvQqBUqZ",
    version: "0.14.0",
    iconUrl: "https://cdn.example.invalid/lithium.png",
  },
};

const disabledMod: ServerInstalledModSnapshot = {
  instanceId,
  relativePath: "mods/ferrite-core.jar.disabled",
  fileName: "ferrite-core.jar.disabled",
  name: "FerriteCore",
  version: "7.0.0",
  addedAt: "2026-08-27T11:00:00.000Z",
  disabled: true,
  resourceSource: { source: "curseforge", id: "429235", version: "7.0.0" },
};

const modrinthProject: ServerModProject = {
  resourceType: "mod",
  source: "modrinth",
  id: "gvQqBUqZ",
  slug: "lithium",
  title: "Lithium",
  iconUrl: "https://cdn.example.invalid/lithium.png",
  description: "A modern optimization mod.",
  author: "CaffeineMC",
  downloads: 1_000_000,
  follows: 40_000,
  dateModified: "2026-08-20T10:00:00.000Z",
  environment: ["client_and_server"],
  categories: ["optimization", "fabric"],
  versions: ["1.21.1", "1.21"],
};

const curseForgeProject: ServerModProject = {
  ...modrinthProject,
  source: "curseforge",
  id: "360438",
  slug: "lithium-reforged",
  title: "Lithium Reforged",
  author: "Example",
};

const projectDetails: ServerModProjectDetails = {
  resourceType: "mod",
  source: "modrinth",
  projectId: modrinthProject.id,
  project: modrinthProject,
  body: "0123456789abcdefghijklmnopqrstuvwxyz",
  versions: [
    {
      id: "fabric-1211",
      version: "0.14.0",
      gameVersions: ["1.21.1"],
      loaders: ["fabric"],
      fileName: "lithium-fabric-0.14.0.jar",
      downloads: 100,
      datePublished: "2026-08-20T10:00:00.000Z",
    },
    {
      id: "fabric-121",
      version: "0.13.0",
      gameVersions: ["1.21"],
      loaders: ["fabric"],
      fileName: "lithium-fabric-0.13.0.jar",
      downloads: 90,
      datePublished: "2026-07-20T10:00:00.000Z",
    },
    {
      id: "neoforge-1211",
      version: "0.14.0",
      gameVersions: ["1.21.1"],
      loaders: ["neoforge"],
      fileName: "lithium-neoforge-0.14.0.jar",
      downloads: 80,
      datePublished: "2026-08-19T10:00:00.000Z",
    },
  ],
};

interface ModAgentHarness {
  readonly resources: AgentResourceRegistry;
  readonly tools: AgentToolRegistry;
  dispose(): void;
}

function createModAgentHarness(
  installed: ServerInstalledModAgentRegistrationOptions,
  catalog: ServerModCatalogAgentRegistrationOptions,
): ModAgentHarness {
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
  registerServerInstalledModAgentIntegration(context, installed);
  registerServerModCatalogAgentIntegration(context, catalog);
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
function requireJsonArray(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a JSON array`);
  return value;
}
function requireJsonString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a JSON string`);
  return value;
}

function defaultInstalledOptions(
  mods: readonly ServerInstalledModSnapshot[] = [installedMod, disabledMod],
): ServerInstalledModAgentRegistrationOptions {
  return {
    async listMods() {
      return mods;
    },
    async setModDisabled(_instanceId, relativePath, disabled) {
      const current = mods.find((mod) => mod.relativePath === relativePath);
      if (!current) throw new Error("missing Mod");
      return {
        ...current,
        relativePath: disabled
          ? `${current.relativePath}.disabled`
          : current.relativePath.replace(/\.disabled$/u, ""),
        fileName: disabled
          ? `${current.fileName}.disabled`
          : current.fileName.replace(/\.disabled$/u, ""),
        disabled,
      };
    },
    async deleteMod() {},
  };
}

function defaultCatalogOptions(
  overrides: Partial<ServerModCatalogAgentRegistrationOptions> = {},
): ServerModCatalogAgentRegistrationOptions {
  return {
    async search(request) {
      const project = request.source === "modrinth" ? modrinthProject : curseForgeProject;
      return { items: [project], offset: request.offset, limit: request.limit, total: 21 };
    },
    async getProjectDetails(source, projectId) {
      return {
        ...projectDetails,
        source,
        projectId,
        project: { ...projectDetails.project, source, id: projectId },
      };
    },
    async installToInstance(input) {
      return {
        ...input,
        fileName: "lithium-fabric-0.14.0.jar",
        destination: "instance",
        downloadedBytes: 123_456,
      };
    },
    async listInstalledMods() {
      return [installedMod];
    },
    ...overrides,
  };
}

await test("Mod Agent integration registers bounded resources and confirmed tools", () => {
  const harness = createModAgentHarness(defaultInstalledOptions(), defaultCatalogOptions());
  assert.deepEqual(
    harness.resources.snapshot().definitions.map((definition) => definition.pattern),
    [
      "server://mods/catalog/{source}/{projectId}",
      "server://instances/{instanceId}/mods",
      "server://mods/catalog",
    ],
  );
  assert.deepEqual(
    harness.tools.snapshot().map(({ name, definition }) => [name, definition.confirmationLevel]),
    [
      ["server_delete-mod", 1],
      ["server_install-mod", 1],
      ["server_set-mod-disabled", 1],
    ],
  );
  harness.dispose();
});

await test("installed Mod resource filters, paginates, and removes image data", async () => {
  const harness = createModAgentHarness(defaultInstalledOptions(), defaultCatalogOptions());
  const prepared = harness.resources.snapshot().prepare(`server://instances/${instanceId}/mods`, {
    query: "ferrite",
    disabled: true,
    page: 1,
    pageSize: 1,
  });
  assert.deepEqual(await prepared.presentRequest(), [
    { value: instanceId },
    { label: "范围", value: "1～1" },
    { label: "搜索", value: "ferrite" },
    { label: "状态", value: "已禁用" },
  ]);
  const result = await prepared.read();
  const content = requireJsonObject(result.content, "installed Mod result");
  assert.deepEqual(content.pagination, {
    page: 1,
    pageSize: 1,
    totalItems: 1,
    totalPages: 1,
    hasMore: false,
  });
  assert.equal(
    requireJsonObject(requireJsonArray(content.items, "installed Mods")[0], "installed Mod")
      .relativePath,
    disabledMod.relativePath,
  );
  assert.deepEqual(await prepared.presentResult(result), [{ value: "1", unit: "个 Mod" }]);
  assert.doesNotMatch(JSON.stringify(content), /iconDataUrl|iconUrl|private-icon|cdn\.example/u);
  await assert.rejects(
    harness.resources.snapshot().read(`server://instances/${instanceId}/mods`, { pageSize: 51 }),
    /不符合 inputSchema/u,
  );
  harness.dispose();
});
await test("installed Mod resource propagates Invocation cancellation into the scanner", async () => {
  let startedScan: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedScan = resolve;
  });
  const installedOptions: ServerInstalledModAgentRegistrationOptions = {
    ...defaultInstalledOptions(),
    async listMods(_instanceId, signal) {
      if (!signal) throw new Error("installed Mod scan is missing its Invocation signal");
      startedScan?.();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const harness = createModAgentHarness(installedOptions, defaultCatalogOptions());
  const controller = new AbortController();
  const reading = harness.resources
    .snapshot()
    .read(`server://instances/${instanceId}/mods`, {}, { signal: controller.signal });
  await started;
  controller.abort(new Error("stop installed Mod scan"));
  await assert.rejects(reading, /stop installed Mod scan/u);
  harness.dispose();
});

await test("installed Mod tools return real before and after receipts", async () => {
  const setCalls: JsonObject[] = [];
  const deleteCalls: JsonObject[] = [];
  const installedOptions: ServerInstalledModAgentRegistrationOptions = {
    ...defaultInstalledOptions([installedMod]),
    async setModDisabled(targetInstanceId, relativePath, disabled) {
      setCalls.push({ instanceId: targetInstanceId, relativePath, disabled });
      return { ...installedMod, relativePath: `${relativePath}.disabled`, disabled };
    },
    async deleteMod(targetInstanceId, relativePath) {
      deleteCalls.push({ instanceId: targetInstanceId, relativePath });
    },
  };
  const harness = createModAgentHarness(installedOptions, defaultCatalogOptions());
  const disabled = requireJsonObject(
    await requireTool(harness.tools, "server_set-mod-disabled").execute(
      { instanceId, relativePath: installedMod.relativePath, disabled: true },
      {},
    ),
    "set Mod receipt",
  );
  assert.equal(requireJsonObject(disabled.before, "before").disabled, false);
  assert.equal(requireJsonObject(disabled.after, "after").disabled, true);
  assert.equal(
    requireJsonObject(disabled.after, "after").relativePath,
    `${installedMod.relativePath}.disabled`,
  );
  assert.deepEqual(setCalls, [
    { instanceId, relativePath: installedMod.relativePath, disabled: true },
  ]);

  const deleted = requireJsonObject(
    await requireTool(harness.tools, "server_delete-mod").execute(
      { instanceId, relativePath: installedMod.relativePath },
      {},
    ),
    "delete Mod receipt",
  );
  assert.equal(requireJsonObject(deleted.before, "before").name, installedMod.name);
  assert.equal(deleted.after, null);
  assert.deepEqual(deleteCalls, [{ instanceId, relativePath: installedMod.relativePath }]);
  await assert.rejects(
    requireTool(harness.tools, "server_delete-mod").execute(
      { instanceId, relativePath: "mods/missing.jar" },
      {},
    ),
    /不存在 Mod/u,
  );
  harness.dispose();
});

await test("all-source Mod catalog uses exact page and pageSize per source", async () => {
  const searchCalls: ServerModSearchRequest[] = [];
  const catalog = defaultCatalogOptions({
    async search(request): Promise<ServerModSearchResult> {
      searchCalls.push(request);
      if (request.source === "curseforge") throw new Error("upstream private failure");
      return {
        items: [modrinthProject],
        offset: request.offset,
        limit: request.limit,
        total: 9,
      };
    },
  });
  const harness = createModAgentHarness(defaultInstalledOptions(), catalog);
  const prepared = harness.resources.snapshot().prepare("server://mods/catalog", {
    source: "all",
    query: "lithium",
    gameVersion: "1.21.1",
    loader: "fabric",
    page: 3,
    pageSize: 4,
  });
  const result = await prepared.read();
  assert.deepEqual(searchCalls, [
    {
      resourceType: "mod",
      source: "modrinth",
      query: "lithium",
      tag: "",
      index: "relevance",
      gameVersion: "1.21.1",
      loader: "fabric",
      offset: 8,
      limit: 4,
    },
    {
      resourceType: "mod",
      source: "curseforge",
      query: "lithium",
      tag: "",
      index: "relevance",
      gameVersion: "1.21.1",
      loader: "fabric",
      offset: 8,
      limit: 4,
    },
  ]);
  const content = requireJsonObject(result.content, "catalog result");
  const sources = requireJsonArray(content.sources, "catalog sources");
  const modrinth = requireJsonObject(sources[0], "Modrinth group");
  const curseForge = requireJsonObject(sources[1], "CurseForge group");
  assert.deepEqual(modrinth.pagination, {
    page: 3,
    pageSize: 4,
    totalItems: 9,
    totalPages: 3,
    hasMore: false,
  });
  assert.equal(
    requireJsonObject(requireJsonArray(modrinth.items, "Modrinth items")[0], "catalog item").source,
    "modrinth",
  );
  assert.equal(curseForge.source, "curseforge");
  assert.equal(curseForge.unavailableReason, "CurseForge 当前查询失败");
  assert.doesNotMatch(JSON.stringify(content), /iconUrl|cdn\.example|upstream private failure/u);
  assert.match(
    requireJsonString(content.externalContentNotice, "external content notice"),
    /第三方|提示词注入/u,
  );
  assert.deepEqual(await prepared.presentResult(result), [{ value: "1", unit: "个 Mod" }]);
  harness.dispose();
});

await test("single-source Mod catalog and project detail keep source concrete", async () => {
  const searchSources: ServerModSource[] = [];
  const detailCalls: Array<{ source: ServerModSource; projectId: string }> = [];
  const catalog = defaultCatalogOptions({
    async search(request) {
      searchSources.push(request.source);
      return { items: [curseForgeProject], offset: request.offset, limit: request.limit, total: 1 };
    },
    async getProjectDetails(source, projectId) {
      detailCalls.push({ source, projectId });
      return projectDetails;
    },
  });
  const harness = createModAgentHarness(defaultInstalledOptions(), catalog);
  const search = await harness.resources.snapshot().read("server://mods/catalog", {
    source: "curseforge",
    page: 1,
    pageSize: 2,
  });
  assert.deepEqual(searchSources, ["curseforge"]);
  const sourceGroups = requireJsonArray(
    requireJsonObject(search.content, "search").sources,
    "source groups",
  );
  assert.equal(requireJsonObject(sourceGroups[0], "source group").source, "curseforge");

  const details = await harness.resources
    .snapshot()
    .read("server://mods/catalog/modrinth/gvQqBUqZ", {
      gameVersion: "1.21.1",
      loader: "fabric",
      page: 1,
      pageSize: 1,
      bodyStart: 2,
      bodyLength: 4,
    });
  const detail = requireJsonObject(details.content, "detail");
  assert.deepEqual(detailCalls, [{ source: "modrinth", projectId: "gvQqBUqZ" }]);
  assert.equal(detail.body, "2345");
  assert.deepEqual(detail.bodyRange, {
    start: 2,
    length: 4,
    totalCharacters: projectDetails.body.length,
    hasMore: true,
  });
  assert.equal(
    requireJsonObject(requireJsonArray(detail.versions, "versions")[0], "version").versionId,
    "fabric-1211",
  );
  assert.equal(
    requireJsonObject(requireJsonArray(detail.versions, "versions")[0], "version").version,
    "0.14.0",
  );
  assert.match(
    requireJsonString(detail.externalContentNotice, "external content notice"),
    /第三方|提示词注入/u,
  );
  assert.deepEqual(detail.versionPagination, {
    page: 1,
    pageSize: 1,
    totalItems: 1,
    totalPages: 1,
    hasMore: false,
  });
  assert.doesNotMatch(JSON.stringify(detail), /iconUrl|cdn\.example/u);
  await assert.rejects(
    harness.resources.snapshot().read("server://mods/catalog/all/gvQqBUqZ", {}),
    /source 必须是 modrinth 或 curseforge/u,
  );
  harness.dispose();
});

await test("install Mod fixes resourceType and returns bounded installation receipts", async () => {
  const installCalls: JsonObject[] = [];
  let listCall = 0;
  const newlyInstalled: ServerInstalledModSnapshot = {
    ...installedMod,
    relativePath: "mods/lithium-fabric-0.15.0.jar",
    fileName: "lithium-fabric-0.15.0.jar",
    version: "0.15.0",
  };
  const catalog = defaultCatalogOptions({
    async installToInstance(input): Promise<ServerModDownloadResult> {
      installCalls.push({ ...input });
      return {
        ...input,
        fileName: newlyInstalled.fileName,
        destination: "instance",
        downloadedBytes: 654_321,
      };
    },
    async listInstalledMods() {
      listCall += 1;
      return listCall === 1
        ? [installedMod, disabledMod]
        : [installedMod, disabledMod, newlyInstalled];
    },
  });
  const harness = createModAgentHarness(defaultInstalledOptions(), catalog);
  const receipt = requireJsonObject(
    await requireTool(harness.tools, "server_install-mod").execute(
      {
        source: "modrinth",
        projectId: "gvQqBUqZ",
        versionId: "version-2",
        instanceId,
      },
      {},
    ),
    "install receipt",
  );
  assert.deepEqual(installCalls, [
    {
      source: "modrinth",
      resourceType: "mod",
      projectId: "gvQqBUqZ",
      versionId: "version-2",
      instanceId,
    },
  ]);
  assert.equal(requireJsonObject(receipt.before, "before").totalItems, 1);
  assert.equal(requireJsonObject(receipt.after, "after").totalItems, 2);
  assert.deepEqual(receipt.download, {
    source: "modrinth",
    projectId: "gvQqBUqZ",
    versionId: "version-2",
    fileName: newlyInstalled.fileName,
    instanceId,
    downloadedBytes: 654_321,
  });
  assert.doesNotMatch(JSON.stringify(receipt), /destination|url|sha1|sha256|sha512|icon/u);
  await assert.rejects(
    requireTool(harness.tools, "server_install-mod").execute(
      { source: "all", projectId: "gvQqBUqZ", versionId: "version-2", instanceId },
      {},
    ),
    /不符合 inputSchema|source/u,
  );
  harness.dispose();
});
await test("install Mod resolves a unique readable version and rejects ambiguity", async () => {
  const installCalls: JsonObject[] = [];
  const catalog = defaultCatalogOptions({
    async installToInstance(input): Promise<ServerModDownloadResult> {
      installCalls.push({ ...input });
      return {
        ...input,
        fileName: "lithium.jar",
        destination: "instance",
        downloadedBytes: 1,
      };
    },
    async listInstalledMods() {
      return [];
    },
  });
  const harness = createModAgentHarness(defaultInstalledOptions(), catalog);
  await requireTool(harness.tools, "server_install-mod").execute(
    {
      source: "modrinth",
      projectId: "gvQqBUqZ",
      version: "0.13.0",
      instanceId,
    },
    {},
  );
  assert.equal(installCalls[0]?.versionId, "fabric-121");
  await assert.rejects(
    requireTool(harness.tools, "server_install-mod").execute(
      {
        source: "modrinth",
        projectId: "gvQqBUqZ",
        version: "0.14.0",
        instanceId,
      },
      {},
    ),
    /多个同名版本/u,
  );
  await assert.rejects(
    requireTool(harness.tools, "server_install-mod").execute(
      {
        source: "modrinth",
        projectId: "gvQqBUqZ",
        versionId: "fabric-121",
        version: "0.13.0",
        instanceId,
      },
      {},
    ),
    /不符合 inputSchema|必须且只能/u,
  );
  harness.dispose();
});

await test("Invocation cancellation stops waiting without canceling Mod installation", async () => {
  let finishInstallation: ((value: ServerModDownloadResult) => void) | undefined;
  let startedInstallation: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedInstallation = resolve;
  });
  const installation = new Promise<ServerModDownloadResult>((resolve) => {
    finishInstallation = resolve;
  });
  const catalog = defaultCatalogOptions({
    async installToInstance() {
      startedInstallation?.();
      return installation;
    },
  });
  const harness = createModAgentHarness(defaultInstalledOptions(), catalog);
  const controller = new AbortController();
  const execution = requireTool(harness.tools, "server_install-mod").execute(
    {
      source: "modrinth",
      projectId: "gvQqBUqZ",
      versionId: "version-2",
      instanceId,
    },
    { signal: controller.signal },
  );
  await started;
  controller.abort(new Error("Invocation stopped"));
  await assert.rejects(execution, /Invocation stopped/u);
  finishInstallation?.({
    source: "modrinth",
    resourceType: "mod",
    projectId: "gvQqBUqZ",
    versionId: "version-2",
    fileName: "lithium.jar",
    destination: "instance",
    instanceId,
    downloadedBytes: 123,
  });
  await installation;
  harness.dispose();
});

await test("disposed Mod Agent registrations reject stale snapshots", async () => {
  const harness = createModAgentHarness(defaultInstalledOptions(), defaultCatalogOptions());
  const prepared = harness.resources
    .snapshot()
    .prepare(`server://instances/${instanceId}/mods`, {});
  const staleTool = requireTool(harness.tools, "server_delete-mod");
  harness.dispose();
  await assert.rejects(prepared.read(), /Agent 资源已停止/u);
  await assert.rejects(
    staleTool.execute({ instanceId, relativePath: installedMod.relativePath }, {}),
    /Agent 工具已停止/u,
  );
});
