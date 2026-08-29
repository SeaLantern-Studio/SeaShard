import type {
  ServerModDownloadResult,
  ServerModProject,
  ServerModProjectDetails,
  ServerModSearchRequest,
  ServerModSearchResult,
  ServerWorldDatapackSnapshot,
  ServerWorldStorageSnapshot,
} from "../packages/contracts/src/index.ts";
import {
  registerServerDatapackAgentIntegration,
  type ServerDatapackAgentRegistrationOptions,
} from "../components/server/instance-manager/src/index.ts";
import {
  registerServerDatapackCatalogAgentIntegration,
  type ServerDatapackCatalogAgentRegistrationOptions,
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
const worldId = "survival";

const worldStorage: ServerWorldStorageSnapshot = {
  instanceId,
  mode: "split",
  currentId: worldId,
  saves: [
    {
      id: worldId,
      groupId: worldId,
      name: "生存世界名称非常非常长",
      dimension: "overworld",
      current: true,
      createdAt: "2026-08-20T10:00:00.000Z",
      updatedAt: "2026-08-28T10:00:00.000Z",
      iconDataUrl: "data:image/png;base64,private-world-icon",
    },
    {
      id: `${worldId}_nether`,
      groupId: worldId,
      name: "Survival Nether",
      dimension: "nether",
      current: true,
      updatedAt: "2026-08-28T10:00:00.000Z",
    },
  ],
  dimensions: [
    {
      id: worldId,
      name: "生存世界名称非常非常长",
      current: true,
      saves: [],
    },
  ],
};

const installedDatapack: ServerWorldDatapackSnapshot = {
  instanceId,
  worldId,
  fileName: "vanilla-tweaks.zip",
  kind: "archive",
  disabled: false,
  description: "Small quality-of-life changes.",
  iconDataUrl: "data:image/png;base64,private-datapack-icon",
  updatedAt: "2026-08-28T11:00:00.000Z",
  resourceSource: {
    source: "modrinth",
    id: "vanilla-tweaks",
    version: "1.4.0",
    iconUrl: "https://cdn.example.invalid/datapack.png",
  },
};

const disabledDatapack: ServerWorldDatapackSnapshot = {
  instanceId,
  worldId,
  fileName: "remote.zip",
  kind: "archive",
  disabled: true,
  description: "Remote data pack.",
  updatedAt: "2026-08-28T12:00:00.000Z",
  resourceSource: {
    source: "curseforge",
    id: "123456",
    version: "2.0.0",
  },
};

const modrinthProject: ServerModProject = {
  resourceType: "datapack",
  source: "modrinth",
  id: "vanilla-tweaks",
  slug: "vanilla-tweaks",
  title: "Vanilla Tweaks",
  iconUrl: "https://cdn.example.invalid/datapack.png",
  description: "Customizable quality-of-life data packs.",
  author: "VanillaTweaks",
  downloads: 100_000,
  follows: 5_000,
  dateModified: "2026-08-20T10:00:00.000Z",
  environment: ["server_only"],
  categories: ["utility"],
  versions: ["1.21.1", "1.21"],
};

const curseForgeProject: ServerModProject = {
  ...modrinthProject,
  source: "curseforge",
  id: "123456",
  slug: "remote-pack",
  title: "Remote Pack",
  author: "Example",
};

const projectDetails: ServerModProjectDetails = {
  resourceType: "datapack",
  source: "modrinth",
  projectId: modrinthProject.id,
  project: modrinthProject,
  body: "0123456789abcdefghijklmnopqrstuvwxyz",
  versions: [
    {
      id: "datapack-141",
      version: "1.4.1",
      gameVersions: ["1.21.1"],
      loaders: ["datapack"],
      fileName: "vanilla-tweaks-1.4.1.zip",
      downloads: 100,
      datePublished: "2026-08-20T10:00:00.000Z",
    },
    {
      id: "datapack-140",
      version: "1.4.0",
      gameVersions: ["1.21"],
      loaders: ["datapack"],
      fileName: "vanilla-tweaks-1.4.0.zip",
      downloads: 90,
      datePublished: "2026-07-20T10:00:00.000Z",
    },
  ],
};

interface DatapackAgentHarness {
  readonly resources: AgentResourceRegistry;
  readonly tools: AgentToolRegistry;
  dispose(): void;
}

function createDatapackAgentHarness(
  installed: ServerDatapackAgentRegistrationOptions,
  catalog: ServerDatapackCatalogAgentRegistrationOptions,
): DatapackAgentHarness {
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
  registerServerDatapackAgentIntegration(context, installed);
  registerServerDatapackCatalogAgentIntegration(context, catalog);
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
  overrides: Partial<ServerDatapackAgentRegistrationOptions> = {},
): ServerDatapackAgentRegistrationOptions {
  const datapacks = [installedDatapack, disabledDatapack];
  return {
    async listInstances() {
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
          updatedAt: "2026-08-28T10:00:00.000Z",
        },
      ];
    },
    async listWorldStorage() {
      return worldStorage;
    },
    async listWorldDatapacks() {
      return datapacks;
    },
    async runWhileServerStopped<T>(
      _instanceId: string,
      _action: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      return operation();
    },
    async setWorldDatapackDisabled(_instanceId, _worldId, fileName, disabled) {
      const current = datapacks.find((datapack) => datapack.fileName === fileName);
      if (!current) throw new Error("missing datapack");
      return { ...current, disabled };
    },
    async deleteWorldDatapack() {},
    ...overrides,
  };
}

function defaultCatalogOptions(
  overrides: Partial<ServerDatapackCatalogAgentRegistrationOptions> = {},
): ServerDatapackCatalogAgentRegistrationOptions {
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
        fileName: "vanilla-tweaks-1.4.1.zip",
        destination: "instance",
        downloadedBytes: 123_456,
      };
    },
    async listInstalledDatapacks() {
      return [installedDatapack];
    },
    ...overrides,
  };
}

await test("datapack Agent integration registers catalog, installed resource, and confirmed tools", () => {
  const harness = createDatapackAgentHarness(defaultInstalledOptions(), defaultCatalogOptions());
  assert.deepEqual(
    harness.resources.snapshot().definitions.map((definition) => definition.pattern),
    [
      "server://instances/{instanceId}/worlds/{worldId}/datapacks",
      "server://datapacks/catalog/{source}/{projectId}",
      "server://datapacks/catalog",
    ],
  );
  assert.deepEqual(
    harness.tools.snapshot().map(({ name, definition }) => [name, definition.confirmationLevel]),
    [
      ["server_delete-datapack", 1],
      ["server_install-datapack", 1],
      ["server_set-datapack-disabled", 1],
    ],
  );
  harness.dispose();
});

await test("installed datapack resource publishes actionable IDs without image data", async () => {
  const harness = createDatapackAgentHarness(defaultInstalledOptions(), defaultCatalogOptions());

  const prepared = harness.resources
    .snapshot()
    .prepare(`server://instances/${instanceId}/worlds/${worldId}/datapacks`, {
      query: "remote",
      disabled: true,
      page: 1,
      pageSize: 1,
    });
  assert.deepEqual(await prepared.presentRequest(), [
    { label: "服务器", value: "测试服务器名称非常非…" },
    { label: "世界", value: "生存世界名称非常非常…" },
    { label: "范围", value: "1～1" },
    { label: "搜索", value: "remote" },
    { label: "状态", value: "已禁用" },
  ]);
  assert.deepEqual(
    await harness.resources
      .snapshot()
      .prepare(`server://instances/${instanceId}/worlds/${worldId}/datapacks`, {
        query: "一二三四五六七八九十十一",
      })
      .presentRequest(),
    [
      { label: "服务器", value: "测试服务器名称非常非…" },
      { label: "世界", value: "生存世界名称非常非常…" },
      { label: "范围", value: "1～20" },
      { label: "搜索", value: "一二三四五六七八九十…" },
    ],
  );
  const result = await prepared.read();
  const content = requireJsonObject(result.content, "datapacks");
  assert.deepEqual(content.pagination, {
    page: 1,
    pageSize: 1,
    totalItems: 1,
    totalPages: 1,
    hasMore: false,
  });
  assert.equal(
    requireJsonObject(requireJsonArray(content.items, "items")[0], "datapack").fileName,
    disabledDatapack.fileName,
  );
  assert.deepEqual(await prepared.presentResult(result), [{ value: "1", unit: "个数据包" }]);
  assert.doesNotMatch(
    JSON.stringify(content),
    /iconDataUrl|iconUrl|private-datapack-icon|cdn\.example/u,
  );
  await assert.rejects(
    harness.resources
      .snapshot()
      .read(`server://instances/${instanceId}/worlds/${worldId}/datapacks`, {
        pageSize: 51,
      }),
    /不符合 inputSchema/u,
  );
  harness.dispose();
});

await test("datapack tools preserve file names, enforce stopped state, and return receipts", async () => {
  const stateChecks: Array<{ instanceId: string; action: string }> = [];
  const setCalls: JsonObject[] = [];
  const deleteCalls: JsonObject[] = [];
  const installed = defaultInstalledOptions({
    async runWhileServerStopped<T>(
      targetInstanceId: string,
      action: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      stateChecks.push({ instanceId: targetInstanceId, action });
      return operation();
    },
    async setWorldDatapackDisabled(targetInstanceId, targetWorldId, fileName, disabled) {
      setCalls.push({ instanceId: targetInstanceId, worldId: targetWorldId, fileName, disabled });
      return { ...installedDatapack, disabled };
    },
    async deleteWorldDatapack(targetInstanceId, targetWorldId, fileName) {
      deleteCalls.push({ instanceId: targetInstanceId, worldId: targetWorldId, fileName });
    },
  });
  const harness = createDatapackAgentHarness(installed, defaultCatalogOptions());
  const disabled = requireJsonObject(
    await requireTool(harness.tools, "server_set-datapack-disabled").execute(
      { instanceId, worldId, fileName: installedDatapack.fileName, disabled: true },
      {},
    ),
    "set datapack receipt",
  );
  assert.equal(requireJsonObject(disabled.before, "before").disabled, false);
  assert.equal(requireJsonObject(disabled.after, "after").disabled, true);
  assert.equal(requireJsonObject(disabled.after, "after").fileName, installedDatapack.fileName);
  assert.deepEqual(setCalls, [
    { instanceId, worldId, fileName: installedDatapack.fileName, disabled: true },
  ]);

  const deleted = requireJsonObject(
    await requireTool(harness.tools, "server_delete-datapack").execute(
      { instanceId, worldId, fileName: installedDatapack.fileName },
      {},
    ),
    "delete datapack receipt",
  );
  assert.equal(requireJsonObject(deleted.before, "before").fileName, installedDatapack.fileName);
  assert.equal(deleted.after, null);
  assert.deepEqual(deleteCalls, [{ instanceId, worldId, fileName: installedDatapack.fileName }]);
  assert.deepEqual(stateChecks, [
    { instanceId, action: "禁用世界数据包" },
    { instanceId, action: "删除世界数据包" },
  ]);
  harness.dispose();

  const activeHarness = createDatapackAgentHarness(
    defaultInstalledOptions({
      async runWhileServerStopped<T>(): Promise<T> {
        throw new Error("需要关停服务器之后才能修改世界数据包。");
      },
    }),
    defaultCatalogOptions(),
  );
  await assert.rejects(
    requireTool(activeHarness.tools, "server_set-datapack-disabled").execute(
      { instanceId, worldId, fileName: installedDatapack.fileName, disabled: true },
      {},
    ),
    /需要关停服务器/u,
  );
  activeHarness.dispose();
});

await test("datapack catalog fixes resource type, uses exact paging, and rejects loader input", async () => {
  const searchCalls: ServerModSearchRequest[] = [];
  const catalog = defaultCatalogOptions({
    async search(request): Promise<ServerModSearchResult> {
      searchCalls.push(request);
      const project = request.source === "modrinth" ? modrinthProject : curseForgeProject;
      return { items: [project], offset: request.offset, limit: request.limit, total: 9 };
    },
  });
  const harness = createDatapackAgentHarness(defaultInstalledOptions(), catalog);
  assert.deepEqual(
    await harness.resources
      .snapshot()
      .prepare("server://datapacks/catalog", {
        source: "all",
        query: "一二三四五六七八九十十一",
      })
      .presentRequest(),
    [
      { value: "一二三四五六七八九十…" },
      { label: "来源", value: "全部来源" },
      { label: "范围", value: "1～10" },
    ],
  );
  const result = await harness.resources.snapshot().read("server://datapacks/catalog", {
    source: "all",
    query: "vanilla",
    gameVersion: "1.21.1",
    page: 3,
    pageSize: 4,
  });
  assert.deepEqual(searchCalls, [
    {
      resourceType: "datapack",
      source: "modrinth",
      query: "vanilla",
      tag: "",
      index: "relevance",
      gameVersion: "1.21.1",
      loader: "",
      offset: 8,
      limit: 4,
    },
    {
      resourceType: "datapack",
      source: "curseforge",
      query: "vanilla",
      tag: "",
      index: "relevance",
      gameVersion: "1.21.1",
      loader: "",
      offset: 8,
      limit: 4,
    },
  ]);
  const content = requireJsonObject(result.content, "catalog");
  assert.equal(requireJsonArray(content.sources, "sources").length, 2);
  assert.match(
    requireJsonString(content.externalContentNotice, "external content notice"),
    /第三方|提示词注入/u,
  );
  assert.doesNotMatch(JSON.stringify(content), /iconUrl|cdn\.example/u);
  await assert.rejects(
    harness.resources.snapshot().read("server://datapacks/catalog", { loader: "fabric" }),
    /不符合 inputSchema/u,
  );
  harness.dispose();
});

await test("datapack detail filters only by game version and install binds the target world", async () => {
  const installCalls: JsonObject[] = [];
  let listCall = 0;
  const newlyInstalled: ServerWorldDatapackSnapshot = {
    ...installedDatapack,
    fileName: "vanilla-tweaks-1.4.1.zip",
    resourceSource: { source: "modrinth", id: "vanilla-tweaks", version: "1.4.1" },
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
    async listInstalledDatapacks() {
      listCall += 1;
      return listCall === 1 ? [installedDatapack] : [installedDatapack, newlyInstalled];
    },
  });
  const harness = createDatapackAgentHarness(defaultInstalledOptions(), catalog);
  const details = await harness.resources
    .snapshot()
    .read("server://datapacks/catalog/modrinth/vanilla-tweaks", {
      gameVersion: "1.21.1",
      page: 1,
      pageSize: 10,
      bodyStart: 2,
      bodyLength: 4,
    });
  const detailContent = requireJsonObject(details.content, "details");
  const version = requireJsonObject(
    requireJsonArray(detailContent.versions, "versions")[0],
    "version",
  );
  assert.equal(version.versionId, "datapack-141");
  assert.equal(version.version, "1.4.1");
  assert.equal("loaders" in version, false);
  assert.equal(detailContent.body, "2345");

  const receipt = requireJsonObject(
    await requireTool(harness.tools, "server_install-datapack").execute(
      {
        source: "modrinth",
        projectId: "vanilla-tweaks",
        version: "1.4.1",
        instanceId,
        worldId,
      },
      {},
    ),
    "install datapack receipt",
  );
  assert.deepEqual(installCalls, [
    {
      source: "modrinth",
      resourceType: "datapack",
      projectId: "vanilla-tweaks",
      versionId: "datapack-141",
      instanceId,
      worldId,
    },
  ]);
  assert.equal(requireJsonObject(receipt.before, "before").totalItems, 1);
  assert.equal(requireJsonObject(receipt.after, "after").totalItems, 2);
  assert.deepEqual(receipt.download, {
    source: "modrinth",
    projectId: "vanilla-tweaks",
    versionId: "datapack-141",
    fileName: newlyInstalled.fileName,
    instanceId,
    worldId,
    downloadedBytes: 654_321,
  });
  assert.doesNotMatch(JSON.stringify(receipt), /destination|url|sha1|sha256|sha512|icon/u);
  await assert.rejects(
    requireTool(harness.tools, "server_install-datapack").execute(
      {
        source: "modrinth",
        projectId: "vanilla-tweaks",
        versionId: "datapack-141",
        instanceId,
        worldId: "worlds-outer/worlds-inner",
      },
      {},
    ),
    /不符合 inputSchema|世界 ID 不合法/u,
  );
  harness.dispose();
});
