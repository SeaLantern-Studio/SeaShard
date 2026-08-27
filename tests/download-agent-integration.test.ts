import {
  createDownloadModule,
  createDownloadTasksResource,
  downloadContract,
  registerDownloadAgentIntegration,
  type DownloadAgentRegistrationOptions,
  type DownloadTaskSnapshot,
} from "../components/network/download/src/index.ts";
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

const activeTask: DownloadTaskSnapshot = {
  id: "task-active",
  url: "https://private.example.test/download?token=secret",
  destinationPath: "C:/Users/Alice/Private/mod.jar",
  state: "downloading",
  downloadedBytes: 512,
  totalBytes: 1_024,
  connections: 4,
  progress: 50,
  createdAt: "2026-08-27T10:00:00.000Z",
  metadata: { kind: "server-mod", userVisible: true, privateToken: "secret" },
};

const completedTask: DownloadTaskSnapshot = {
  ...activeTask,
  id: "task-completed",
  destinationPath: "D:/Games/SeaShard/paper.jar",
  state: "completed",
  downloadedBytes: 2_048,
  totalBytes: 2_048,
  connections: 8,
  progress: 100,
  createdAt: "2026-08-27T10:01:00.000Z",
  finishedAt: "2026-08-27T10:02:00.000Z",
};

const failedTask: DownloadTaskSnapshot = {
  ...activeTask,
  id: "task-failed",
  destinationPath: "E:/Private/failed.zip",
  state: "failed",
  downloadedBytes: 0,
  totalBytes: 4_096,
  progress: 0,
  createdAt: "2026-08-27T10:03:00.000Z",
  finishedAt: "2026-08-27T10:03:01.000Z",
  error: "EACCES: denied E:/Private/failed.zip",
};

const hiddenTask: DownloadTaskSnapshot = {
  ...activeTask,
  id: "task-hidden",
  destinationPath: "C:/SeaShard/cache/icon.png",
  metadata: { kind: "server-core-icon" },
};

interface AgentIntegrationHarness {
  readonly resources: AgentResourceRegistry;
  readonly tools: AgentToolRegistry;
  dispose(): void;
}

function createAgentIntegrationHarness(
  options: DownloadAgentRegistrationOptions,
): AgentIntegrationHarness {
  const resources = new AgentResourceRegistry();
  const tools = new AgentToolRegistry();
  const disposers: Array<() => void> = [];
  const runtimeId = "test.download";
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
  registerDownloadAgentIntegration(context, options);
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
      href: "download://tasks",
      scheme: "download",
      path: "tasks",
      query: {},
    },
    pathParams: {},
    input,
  } as const;
}

await test("download Agent resource is visible-only, bounded, projected, and lifecycle-bound", async () => {
  let listCalls = 0;
  const additionalTasks: DownloadTaskSnapshot[] = Array.from({ length: 60 }, (_, index) => ({
    ...completedTask,
    id: `task-${String(index).padStart(3, "0")}`,
    destinationPath: `C:/Users/Alice/Private/file-${index}.jar`,
    createdAt: `2026-08-27T11:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const unsafeIdTask: DownloadTaskSnapshot = {
    ...activeTask,
    id: "unsafe/task",
    destinationPath: "C:/Private/unsafe.jar",
  };
  const tasks = [
    activeTask,
    completedTask,
    failedTask,
    hiddenTask,
    unsafeIdTask,
    ...additionalTasks,
  ];
  const harness = createAgentIntegrationHarness({
    listTasks: () => {
      listCalls += 1;
      return tasks;
    },
    snapshot: () => undefined,
    cancel: async () => false,
  });

  const snapshot = harness.resources.snapshot();
  assert.deepEqual(
    snapshot.definitions.map(({ pattern }) => pattern),
    ["download://tasks"],
  );
  assert.equal(snapshot.definitions[0]?.presentation?.title, "读取下载任务");
  assert.match(
    snapshot.definitions[0]?.description ?? "",
    /不包含.*URL.*metadata.*宿主绝对目标路径/u,
  );
  assert.deepEqual(
    harness.tools.snapshot().map(({ name }) => name),
    ["download_cancel"],
  );
  assert.equal(harness.tools.snapshot()[0]?.definition.confirmationLevel, 1);

  const prepared = snapshot.prepare("download://tasks", {
    page: 1,
    pageSize: 20,
    state: "downloading",
  });
  assert.deepEqual(await prepared.presentRequest(), [
    { value: "1～20" },
    { label: "状态", value: "下载中" },
  ]);
  const result = await prepared.read();
  assert.equal(listCalls, 1);
  assert.deepEqual(result, {
    mimeType: "application/json",
    content: {
      items: [
        {
          id: activeTask.id,
          fileName: "mod.jar",
          fileNameTruncated: false,
          state: "downloading",
          downloadedBytes: 512,
          totalBytes: 1_024,
          progress: 50,
          connections: 4,
          createdAt: activeTask.createdAt,
          hasError: false,
        },
      ],
      pagination: {
        page: 1,
        pageSize: 20,
        totalItems: 1,
        totalPages: 1,
        hasMore: false,
      },
    },
  });
  assert.deepEqual(await prepared.presentResult(result), [{ value: "1", unit: "个任务" }]);
  assert.doesNotMatch(
    JSON.stringify(result.content),
    /private\.example|token|metadata|destinationPath|Users\/Alice|Private|EACCES/u,
  );

  const maximumPage = await snapshot.read("download://tasks", { page: 1, pageSize: 50 });
  const maximumContent = maximumPage.content;
  if (!maximumContent || typeof maximumContent !== "object" || Array.isArray(maximumContent)) {
    throw new TypeError("download resource output must be an object");
  }
  const maximumItems = maximumContent.items;
  if (!Array.isArray(maximumItems)) throw new TypeError("download resource output must have items");
  assert.equal(maximumItems.length, 50);
  const newestItem = maximumItems[0];
  assert.equal(
    newestItem && typeof newestItem === "object" && !Array.isArray(newestItem)
      ? newestItem.id
      : undefined,
    "task-059",
  );
  assert.equal(listCalls, 2);

  const invalidInputs: JsonValue[] = [
    null,
    { unknown: true },
    { page: 0 },
    { page: 10_001 },
    { pageSize: 0 },
    { pageSize: 51 },
    { state: "running" },
    { state: null },
  ];
  for (const invalid of invalidInputs) {
    assert.throws(() => snapshot.prepare("download://tasks", invalid), /不符合 inputSchema/u);
  }
  assert.doesNotThrow(() =>
    snapshot.prepare("download://tasks", { page: 10_000, pageSize: 50, state: "cancelled" }),
  );

  const resource = createDownloadTasksResource({
    listTasks: () => [activeTask],
    snapshot: () => activeTask,
    cancel: async () => true,
  });
  await assert.rejects(
    resource.implementation.read(createReadRequest({ unknown: true }), {}),
    /不支持参数/u,
  );
  await assert.rejects(resource.implementation.read(createReadRequest(null), {}), /必须是对象/u);

  const stalePrepared = snapshot.prepare("download://tasks", {});
  const staleTool = requireTool(harness.tools, "download_cancel");
  harness.dispose();
  assert.equal(harness.resources.snapshot().definitions.length, 0);
  assert.equal(harness.tools.snapshot().length, 0);
  await assert.rejects(stalePrepared.read(), /Agent 资源已停止/u);
  await assert.rejects(staleTool.execute({ taskId: activeTask.id }, {}), /Agent 工具已停止/u);
});

await test("download_cancel reuses one visible task cancellation and hides Host details", async () => {
  let tasks: DownloadTaskSnapshot[] = [activeTask, completedTask, hiddenTask];
  const cancelCalls: string[] = [];
  const harness = createAgentIntegrationHarness({
    listTasks: () => tasks,
    snapshot: (taskId) => tasks.find((task) => task.id === taskId),
    cancel: async (taskId) => {
      cancelCalls.push(taskId);
      tasks = tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              state: "cancelled",
              finishedAt: "2026-08-27T10:00:01.000Z",
              error: "download cancelled at C:/Users/Alice/Private/mod.jar",
            }
          : task,
      );
      return true;
    },
  });
  const tool = requireTool(harness.tools, "download_cancel");

  assert.deepEqual(await tool.execute({ taskId: activeTask.id }, {}), {
    task: {
      id: activeTask.id,
      fileName: "mod.jar",
      fileNameTruncated: false,
      state: "cancelled",
      downloadedBytes: 512,
      totalBytes: 1_024,
      progress: 50,
      connections: 4,
      createdAt: activeTask.createdAt,
      finishedAt: "2026-08-27T10:00:01.000Z",
      hasError: false,
    },
    cancelled: true,
  });
  assert.deepEqual(cancelCalls, [activeTask.id]);

  const completed = await tool.execute({ taskId: completedTask.id }, {});
  assert.equal(
    completed && typeof completed === "object" && !Array.isArray(completed)
      ? completed.cancelled
      : undefined,
    false,
  );
  assert.deepEqual(cancelCalls, [activeTask.id]);
  assert.doesNotMatch(
    JSON.stringify([completed, await tool.execute({ taskId: activeTask.id }, {})]),
    /destinationPath|private\.example|Users\/Alice|metadata|download cancelled/u,
  );

  await assert.rejects(tool.execute({ taskId: hiddenTask.id }, {}), /用户可见下载任务不存在/u);
  const invalidInputs: JsonValue[] = [
    null,
    {},
    { taskId: "" },
    { taskId: "unsafe/task" },
    { taskId: "a".repeat(129) },
    { taskId: activeTask.id, unknown: true },
  ];
  for (const invalid of invalidInputs) {
    await assert.rejects(tool.execute(invalid, {}), /必须|不支持|不符合 inputSchema/u);
  }
  assert.deepEqual(cancelCalls, [activeTask.id]);
  harness.dispose();
});

await test("download Agent integration propagates failures and cancellation", async () => {
  const domainError = new Error("cancel pipeline failed");
  const failing = createAgentIntegrationHarness({
    listTasks: () => [activeTask],
    snapshot: () => activeTask,
    cancel: async () => {
      throw domainError;
    },
  });
  await assert.rejects(
    requireTool(failing.tools, "download_cancel").execute({ taskId: activeTask.id }, {}),
    (error: unknown) => error === domainError,
  );
  failing.dispose();

  const preAborted = new AbortController();
  preAborted.abort();
  let preAbortedListCalls = 0;
  const resource = createDownloadTasksResource({
    listTasks: () => {
      preAbortedListCalls += 1;
      return [activeTask];
    },
    snapshot: () => activeTask,
    cancel: async () => true,
  });
  await assert.rejects(
    resource.implementation.read(createReadRequest({}), { signal: preAborted.signal }),
    { name: "AbortError" },
  );
  assert.equal(preAbortedListCalls, 0);

  const duringList = new AbortController();
  let canceledCalls = 0;
  const canceled = createAgentIntegrationHarness({
    listTasks: () => {
      duringList.abort();
      return [activeTask];
    },
    snapshot: () => activeTask,
    cancel: async () => {
      canceledCalls += 1;
      return true;
    },
  });
  await assert.rejects(
    requireTool(canceled.tools, "download_cancel").execute(
      { taskId: activeTask.id },
      { signal: duringList.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(canceledCalls, 0);
  canceled.dispose();

  const afterCancel = new AbortController();
  let completedCancellations = 0;
  const canceledAfterMutation = createAgentIntegrationHarness({
    listTasks: () => [activeTask],
    snapshot: () => ({ ...activeTask, state: "cancelled" }),
    cancel: async () => {
      completedCancellations += 1;
      afterCancel.abort();
      return true;
    },
  });
  await assert.rejects(
    requireTool(canceledAfterMutation.tools, "download_cancel").execute(
      { taskId: activeTask.id },
      { signal: afterCancel.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(completedCancellations, 1);
  canceledAfterMutation.dispose();
});

await test("download module registers Agent capabilities beside the shared download service", async () => {
  const resourcePatterns: string[] = [];
  const toolNames: string[] = [];
  const providers = new Map<string, unknown>();
  const context = {
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

  const dispose = await createDownloadModule().apply(context, null);
  assert.ok(providers.has(downloadContract));
  assert.deepEqual(resourcePatterns, ["download://tasks"]);
  assert.deepEqual(toolNames, ["download_cancel"]);
  if (typeof dispose === "function") await dispose();
});
