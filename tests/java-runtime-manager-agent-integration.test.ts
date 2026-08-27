import type { JavaInstallationSnapshot } from "../packages/contracts/src/index.ts";
import {
  createJavaInstallationsResource,
  registerJavaRuntimeAgentIntegration,
  type JavaRuntimeAgentRegistrationOptions,
} from "../components/game/java-runtime-manager/src/agent-integration.ts";
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

const automaticJava: JavaInstallationSnapshot = {
  id: "1111111111111111",
  path: "C:/Program Files/Java/automatic/bin/java.exe",
  javaHome: "C:/Program Files/Java/automatic",
  version: "21.0.7+6-LTS",
  majorVersion: 21,
  vendor: "Eclipse Adoptium",
  architecture: "x64",
  is64Bit: true,
  source: "filesystem",
  disabled: false,
};

const manualJava: JavaInstallationSnapshot = {
  id: "2222222222222222",
  path: "D:/Private/Java/manual/bin/java.exe",
  javaHome: "D:/Private/Java/manual",
  version: "17.0.12",
  majorVersion: 17,
  vendor: "Manual Vendor",
  architecture: "arm64",
  is64Bit: true,
  source: "manual",
  disabled: true,
};

interface AgentIntegrationHarness {
  readonly resources: AgentResourceRegistry;
  readonly tools: AgentToolRegistry;
  dispose(): void;
}

function createAgentIntegrationHarness(
  options: JavaRuntimeAgentRegistrationOptions,
): AgentIntegrationHarness {
  const resources = new AgentResourceRegistry();
  const tools = new AgentToolRegistry();
  const disposers: Array<() => void> = [];
  const runtimeId = "test.java-runtime-manager";
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
  registerJavaRuntimeAgentIntegration(context, options);
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
      href: "java://installations",
      scheme: "java",
      path: "installations",
      query: {},
    },
    pathParams: {},
    input,
  } as const;
}

await test("Java Agent resource is bounded, filterable, projected, and lifecycle-bound", async () => {
  let scanCalls = 0;
  const additionalInstallations: JavaInstallationSnapshot[] = Array.from(
    { length: 60 },
    (_, index) => ({
      ...automaticJava,
      id: (index + 256).toString(16).padStart(16, "0"),
      path: `E:/Java/${index}/bin/java.exe`,
      javaHome: `E:/Java/${index}`,
      version: "8.0.452",
      majorVersion: 8,
      source: "registry",
    }),
  );
  const harness = createAgentIntegrationHarness({
    scan: async () => {
      scanCalls += 1;
      return [automaticJava, manualJava, ...additionalInstallations];
    },
    setDisabled: async () => true,
    remove: async () => true,
  });

  const snapshot = harness.resources.snapshot();
  assert.deepEqual(
    snapshot.definitions.map(({ pattern }) => pattern),
    ["java://installations"],
  );
  assert.equal(snapshot.definitions[0]?.presentation?.title, "读取 Java 安装");
  assert.match(snapshot.definitions[0]?.description ?? "", /不包含.*绝对路径/u);
  assert.deepEqual(
    harness.tools.snapshot().map(({ name }) => name),
    ["java_forget-manual", "java_set-disabled"],
  );

  const prepared = snapshot.prepare("java://installations", {
    page: 1,
    pageSize: 10,
    majorVersion: 21,
    source: "filesystem",
    disabled: false,
  });
  assert.deepEqual(await prepared.presentRequest(), [
    { value: "1～10" },
    { label: "版本", value: "Java 21" },
    { label: "来源", value: "文件系统" },
    { label: "状态", value: "已启用" },
  ]);
  const result = await prepared.read();
  assert.equal(scanCalls, 1);
  assert.deepEqual(result, {
    mimeType: "application/json",
    content: {
      items: [
        {
          id: automaticJava.id,
          version: automaticJava.version,
          majorVersion: 21,
          vendor: automaticJava.vendor,
          architecture: "x64",
          is64Bit: true,
          source: "filesystem",
          disabled: false,
        },
      ],
      pagination: {
        page: 1,
        pageSize: 10,
        totalItems: 1,
        totalPages: 1,
        hasMore: false,
      },
    },
  });
  assert.deepEqual(await prepared.presentResult(result), [{ value: "1", unit: "个结果" }]);
  assert.doesNotMatch(
    JSON.stringify(result.content),
    /javaHome|["']path["']|Program Files|D:\/Private|E:\/Java/u,
  );

  const maximumPage = await snapshot.read("java://installations", {
    page: 1,
    pageSize: 50,
  });
  assert.equal(
    typeof maximumPage.content === "object" &&
      maximumPage.content !== null &&
      !Array.isArray(maximumPage.content) &&
      Array.isArray(maximumPage.content.items)
      ? maximumPage.content.items.length
      : -1,
    50,
  );
  assert.equal(scanCalls, 2);

  const invalidResourceInputs: JsonValue[] = [
    null,
    { unknown: true },
    { page: 0 },
    { page: 10_001 },
    { pageSize: 0 },
    { pageSize: 51 },
    { majorVersion: 0 },
    { majorVersion: 256 },
    { source: "" },
    { disabled: null },
  ];
  for (const invalid of invalidResourceInputs) {
    assert.throws(() => snapshot.prepare("java://installations", invalid), /不符合 inputSchema/u);
  }
  assert.doesNotThrow(() =>
    snapshot.prepare("java://installations", {
      page: 10_000,
      pageSize: 50,
      majorVersion: 255,
    }),
  );

  const resource = createJavaInstallationsResource({
    scan: async () => [automaticJava],
    setDisabled: async () => true,
    remove: async () => true,
  });
  await assert.rejects(
    resource.implementation.read(createReadRequest({ unknown: true }), {}),
    /未知字段/u,
  );
  await assert.rejects(resource.implementation.read(createReadRequest(null), {}), /必须是对象/u);

  const stalePrepared = snapshot.prepare("java://installations", {});
  const staleTool = requireTool(harness.tools, "java_set-disabled");
  harness.dispose();
  assert.equal(harness.resources.snapshot().definitions.length, 0);
  assert.equal(harness.tools.snapshot().length, 0);
  await assert.rejects(stalePrepared.read(), /Agent 资源已停止/u);
  await assert.rejects(
    staleTool.execute({ installationId: automaticJava.id, disabled: true }, {}),
    /Agent 工具已停止/u,
  );
});

await test("Java Agent tools validate stable IDs and reuse each domain transaction once", async () => {
  const disabledCalls: Array<{ readonly installationId: string; readonly disabled: boolean }> = [];
  const removedPaths: string[] = [];
  let scanCalls = 0;
  const harness = createAgentIntegrationHarness({
    scan: async () => {
      scanCalls += 1;
      return [automaticJava, manualJava];
    },
    setDisabled: async (installationId, disabled) => {
      disabledCalls.push({ installationId, disabled });
      return disabled;
    },
    remove: async (path) => {
      removedPaths.push(path);
      return true;
    },
  });

  const setDisabled = requireTool(harness.tools, "java_set-disabled");
  assert.deepEqual(
    await setDisabled.execute({ installationId: automaticJava.id, disabled: true }, {}),
    {
      installation: {
        id: automaticJava.id,
        version: automaticJava.version,
        majorVersion: automaticJava.majorVersion,
        vendor: automaticJava.vendor,
        architecture: automaticJava.architecture,
        is64Bit: automaticJava.is64Bit,
        source: automaticJava.source,
        disabled: true,
      },
      changed: true,
    },
  );
  assert.deepEqual(disabledCalls, [{ installationId: automaticJava.id, disabled: true }]);
  assert.equal(scanCalls, 1);

  const forgetManual = requireTool(harness.tools, "java_forget-manual");
  const forgotten = await forgetManual.execute({ installationId: manualJava.id }, {});
  assert.deepEqual(removedPaths, [manualJava.path]);
  assert.equal(scanCalls, 2);
  assert.deepEqual(forgotten, {
    installation: {
      id: manualJava.id,
      version: manualJava.version,
      majorVersion: manualJava.majorVersion,
      vendor: manualJava.vendor,
      architecture: manualJava.architecture,
      is64Bit: manualJava.is64Bit,
      source: manualJava.source,
      disabled: manualJava.disabled,
    },
    removed: true,
    localFilesDeleted: false,
  });
  assert.doesNotMatch(JSON.stringify(forgotten), /D:\/Private|javaHome|["']path["']/u);

  const invalidSetInputs: JsonValue[] = [
    null,
    {},
    { installationId: "", disabled: true },
    { installationId: "a".repeat(17), disabled: true },
    { installationId: automaticJava.id, disabled: null },
    { installationId: automaticJava.id, disabled: true, unknown: true },
  ];
  for (const invalid of invalidSetInputs) {
    await assert.rejects(setDisabled.execute(invalid, {}), /必须|未知字段|不符合 inputSchema/u);
  }
  assert.deepEqual(disabledCalls, [{ installationId: automaticJava.id, disabled: true }]);

  await assert.rejects(
    forgetManual.execute({ installationId: automaticJava.id }, {}),
    /不是手动记录/u,
  );
  await assert.rejects(
    forgetManual.execute({ installationId: "ffffffffffffffff" }, {}),
    /Java 安装不存在/u,
  );
  assert.deepEqual(removedPaths, [manualJava.path]);
  harness.dispose();
});

await test("Java Agent integration propagates domain failures and cancellation", async () => {
  const domainError = new Error("persist disabled state failed");
  let mutationCalls = 0;
  const failing = createAgentIntegrationHarness({
    scan: async () => [automaticJava, manualJava],
    setDisabled: async () => {
      mutationCalls += 1;
      throw domainError;
    },
    remove: async () => false,
  });
  await assert.rejects(
    requireTool(failing.tools, "java_set-disabled").execute(
      { installationId: automaticJava.id, disabled: true },
      {},
    ),
    (error: unknown) => error === domainError,
  );
  assert.equal(mutationCalls, 1);
  await assert.rejects(
    requireTool(failing.tools, "java_forget-manual").execute({ installationId: manualJava.id }, {}),
    /手动记录已不存在/u,
  );
  failing.dispose();

  const preAborted = new AbortController();
  preAborted.abort();
  let preAbortedScanCalls = 0;
  const resource = createJavaInstallationsResource({
    scan: async () => {
      preAbortedScanCalls += 1;
      return [automaticJava];
    },
    setDisabled: async () => true,
    remove: async () => true,
  });
  await assert.rejects(
    resource.implementation.read(createReadRequest({}), { signal: preAborted.signal }),
    { name: "AbortError" },
  );
  assert.equal(preAbortedScanCalls, 0);

  const duringScan = new AbortController();
  let canceledMutationCalls = 0;
  const canceled = createAgentIntegrationHarness({
    scan: async () => {
      duringScan.abort();
      return [automaticJava];
    },
    setDisabled: async () => {
      canceledMutationCalls += 1;
      return true;
    },
    remove: async () => true,
  });
  await assert.rejects(
    requireTool(canceled.tools, "java_set-disabled").execute(
      { installationId: automaticJava.id, disabled: true },
      { signal: duringScan.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(canceledMutationCalls, 0);
  canceled.dispose();

  const afterMutation = new AbortController();
  let completedMutationCalls = 0;
  const canceledAfterMutation = createAgentIntegrationHarness({
    scan: async () => [automaticJava],
    setDisabled: async () => {
      completedMutationCalls += 1;
      afterMutation.abort();
      return true;
    },
    remove: async () => true,
  });
  await assert.rejects(
    requireTool(canceledAfterMutation.tools, "java_set-disabled").execute(
      { installationId: automaticJava.id, disabled: true },
      { signal: afterMutation.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(completedMutationCalls, 1);
  canceledAfterMutation.dispose();

  const scanError = new Error("Java scan failed");
  const failingResource = createJavaInstallationsResource({
    scan: async () => {
      throw scanError;
    },
    setDisabled: async () => true,
    remove: async () => true,
  });
  await assert.rejects(
    failingResource.implementation.read(createReadRequest({}), {}),
    (error: unknown) => error === scanError,
  );
});
