import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  AgentCredentialVault,
  AgentModelCatalog,
  AgentOutputCollector,
  AgentRuntime,
  AgentSessionJournal,
  AgentSessionLocalStore,
  bindAgentHelpResource,
  registerBuiltInAgentProviderTypes,
  bindAgentLocalResource,
  type AgentModelSource,
} from "../components/agent/runtime/src/index.ts";
import {
  defaultAgentModelReasoningLevels,
  interleaveAgentInvocationContent,
} from "../packages/contracts/src/index.ts";
import { registerServerInstanceAgentResources } from "../components/server/instance-manager/src/index.ts";
import {
  AgentProviderTypeRegistry,
  AgentResourceRegistry,
  AgentToolRegistry,
} from "../packages/plugin-system/src/runtime-registries.ts";
import type { JsonValue } from "../packages/plugin-sdk/src/index.ts";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

async function waitForModels(
  catalog: AgentModelCatalog,
  expected: readonly string[],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ids = (await catalog.list()).map(
      ({ connectionId, modelId }) => `${connectionId}/${modelId}`,
    );
    if (ids.length === expected.length && ids.every((id, index) => id === expected[index])) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`模型目录未更新为：${expected.join(", ")}`);
}
async function waitForConnection(
  catalog: AgentModelCatalog,
  connectionId: string,
): Promise<Awaited<ReturnType<AgentModelCatalog["getConfiguration"]>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const configuration = await catalog.getConfiguration();
    if (configuration.connections.some(({ id }) => id === connectionId)) return configuration;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`模型供应商连接未载入：${connectionId}`);
}

function registerProviderTypes(registry: AgentProviderTypeRegistry): void {
  registerBuiltInAgentProviderTypes({
    aiProviderType(definition) {
      return registry.register("test.agent-providers", { type: "global", id: "global" }, definition)
        .id;
    },
  });
}

function createProviderTypes(): AgentProviderTypeRegistry {
  const registry = new AgentProviderTypeRegistry();
  registerProviderTypes(registry);
  return registry;
}

await test("Agent 模型目录创建 models.yml 并读取 Provider Type 配置", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-models-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const catalog = new AgentModelCatalog({
    userDataRoot,
    providerTypes: createProviderTypes(),
    environment: {},
  });
  assert.deepEqual(defaultAgentModelReasoningLevels, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  await catalog.initialize();
  const initial = await readFile(catalog.configPath, "utf8");
  assert.match(initial, /providers: \{\}/);

  await writeFile(
    catalog.configPath,
    [
      "providers:",
      "  local:",
      "    displayName: Local Qwen",
      "    providerType: openai-compatible",
      "    settings:",
      "      baseURL: http://127.0.0.1:11434/v1",
      "    models:",
      "      - id: qwen3-coder",
      "        displayName: Qwen 3 Coder",
      "",
    ].join("\n"),
    "utf8",
  );
  await waitForModels(catalog, ["local/qwen3-coder"]);

  assert.deepEqual(await catalog.list(), [
    {
      connectionId: "local",
      modelId: "qwen3-coder",
      name: "Qwen 3 Coder",
    },
  ]);
  const resolved = await catalog.resolve({ connectionId: "local", modelId: "qwen3-coder" });
  assert.deepEqual(resolved.selection, {
    connectionId: "local",
    modelId: "qwen3-coder",
    reasoningLevel: "high",
  });
  assert.equal(dirname(catalog.configPath), join(userDataRoot, "agent"));
  await catalog.dispose();
});
await test("旧格式 models.yml 不阻断 Agent 启动并可显式重置", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-invalid-models-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const configDirectory = join(userDataRoot, "agent");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "models.yml"),
    [
      "providers:",
      "  legacy:",
      "    api: openai-responses",
      "    apiKey: plaintext-is-not-supported",
      "    models:",
      "      - id: legacy-model",
      "",
    ].join("\n"),
    "utf8",
  );
  const reported: unknown[] = [];
  const catalog = new AgentModelCatalog({
    userDataRoot,
    providerTypes: createProviderTypes(),
    environment: {},
    reportError: (error) => reported.push(error),
  });

  await catalog.initialize();
  context.after(() => catalog.dispose());
  const invalid = await catalog.getConfiguration();
  assert.deepEqual(invalid.connections, []);
  assert.deepEqual(invalid.models, []);
  assert.match(invalid.diagnostics[0] ?? "", /providerType/u);
  assert.equal(reported.length, 1);

  const reset = await catalog.resetConfiguration({ expectedRevision: invalid.revision });
  assert.deepEqual(reset.connections, []);
  assert.deepEqual(reset.diagnostics, []);
  assert.match(await readFile(catalog.configPath, "utf8"), /providers: \{\}/u);
});

await test("models.yml 热更新保留最后有效快照并识别 rename 保存", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-model-watch-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const reported: unknown[] = [];
  const catalog = new AgentModelCatalog({
    userDataRoot,
    providerTypes: createProviderTypes(),
    environment: {},
    watchDebounceMs: 20,
    reportError: (error) => reported.push(error),
  });
  await catalog.initialize();
  context.after(() => catalog.dispose());

  const valid = (modelId: string) =>
    [
      "providers:",
      "  local:",
      "    providerType: openai-compatible",
      "    settings:",
      "      baseURL: http://127.0.0.1:11434/v1",
      "    models:",
      `      - id: ${modelId}`,
      "",
    ].join("\n");
  await writeFile(catalog.configPath, valid("model-a"), "utf8");
  await waitForModels(catalog, ["local/model-a"]);
  const acceptedRevision = (await catalog.getConfiguration()).revision;

  await writeFile(catalog.configPath, "providers:\n  local: [", "utf8");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      (await catalog.getConfiguration()).diagnostics.some((message) => message.includes("无效"))
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(await catalog.list(), [
    { connectionId: "local", modelId: "model-a", name: "model-a" },
  ]);
  assert.equal((await catalog.getConfiguration()).revision, acceptedRevision);
  assert.ok(reported.length > 0);

  const temporary = `${catalog.configPath}.editor.tmp`;
  await writeFile(temporary, valid("model-b"), "utf8");
  await rename(temporary, catalog.configPath);
  await waitForModels(catalog, ["local/model-b"]);
  assert.deepEqual((await catalog.getConfiguration()).diagnostics, []);
});

await test("模型连接修改保留未触及 YAML 节点并拒绝旧 revision", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-model-write-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const catalog = new AgentModelCatalog({
    userDataRoot,
    providerTypes: createProviderTypes(),
    environment: {},
    watchDebounceMs: 20,
  });
  await catalog.initialize();
  context.after(() => catalog.dispose());
  await writeFile(
    catalog.configPath,
    [
      "# 保留这条人工注释",
      "futureRoot: true",
      "providers:",
      "  local:",
      "    providerType: openai-compatible",
      "    advancedField: keep-me",
      "    settings:",
      "      baseURL: http://127.0.0.1:11434/v1",
      "    models:",
      "      - id: model-a",
      "",
    ].join("\n"),
    "utf8",
  );
  await waitForModels(catalog, ["local/model-a"]);
  const before = await catalog.getConfiguration();
  const after = await catalog.mutateConnection({
    expectedRevision: before.revision,
    connectionId: "local",
    operations: [
      { op: "set", path: ["displayName"], value: "Local Gateway" },
      { op: "set", path: ["settings", "baseURL"], value: "http://127.0.0.1:11435/v1" },
      {
        op: "set",
        path: ["models"],
        value: [
          {
            id: "model-a",
            settings: {
              maximumContextTokens: 256_000,
              reasoningLevels: ["brief", "deep", "beyond"],
            },
          },
        ],
      },
    ],
  });
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(after.models[0]?.settings, {
    maximumContextTokens: 256_000,
    reasoningLevels: ["brief", "deep", "beyond"],
  });
  const resolved = await catalog.resolve({
    connectionId: "local",
    modelId: "model-a",
    reasoningLevel: "beyond",
  });
  assert.deepEqual(resolved.selection, {
    connectionId: "local",
    modelId: "model-a",
    reasoningLevel: "beyond",
  });
  assert.deepEqual(resolved.providerOptions, {
    local: { reasoningEffort: "beyond" },
  });
  await assert.rejects(
    catalog.resolve({
      connectionId: "local",
      modelId: "model-a",
      reasoningLevel: "unknown",
    }),
    /不支持推理档位/u,
  );
  const source = await readFile(catalog.configPath, "utf8");
  assert.match(source, /# 保留这条人工注释/u);
  assert.match(source, /futureRoot: true/u);
  assert.match(source, /advancedField: keep-me/u);
  assert.match(source, /displayName: Local Gateway/u);
  await assert.rejects(
    catalog.removeConnection({
      expectedRevision: before.revision,
      connectionId: "local",
    }),
    { name: "AgentModelConfigurationConflictError" },
  );
});

await test("Provider Type 暂时缺失时保留连接并在重注册后恢复模型", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-provider-lifecycle-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const providerTypes = new AgentProviderTypeRegistry();
  const catalog = new AgentModelCatalog({
    userDataRoot,
    providerTypes,
    environment: {},
    watchDebounceMs: 20,
  });
  await catalog.initialize();
  context.after(() => catalog.dispose());
  await writeFile(
    catalog.configPath,
    [
      "providers:",
      "  local:",
      "    providerType: openai-compatible",
      "    settings:",
      "      baseURL: http://127.0.0.1:11434/v1",
      "    models:",
      "      - id: model-a",
      "",
    ].join("\n"),
    "utf8",
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await catalog.getConfiguration()).connections.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  let configuration = await catalog.getConfiguration();
  assert.equal(configuration.connections[0]?.available, false);
  assert.deepEqual(configuration.models, []);

  registerProviderTypes(providerTypes);
  await waitForModels(catalog, ["local/model-a"]);
  configuration = await catalog.getConfiguration();
  assert.equal(configuration.connections[0]?.available, true);

  providerTypes.removeRuntime("test.agent-providers");
  await waitForModels(catalog, []);
  configuration = await catalog.getConfiguration();
  assert.equal(configuration.connections[0]?.available, false);
  assert.match(configuration.connections[0]?.diagnostic ?? "", /Provider Type 未注册/u);
});

await test("凭据 Vault 只落盘密文并为模型发现提供临时授权", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-credentials-"));
  const requests: Array<{ readonly url?: string; readonly authorization?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      authorization:
        typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : undefined,
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  context.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const vault = new AgentCredentialVault({
    userDataRoot,
    environment: {},
    cipher: {
      encrypt: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
      decrypt: (value) =>
        Buffer.from(value)
          .toString("utf8")
          .replace(/^encrypted:/u, ""),
    },
  });
  const catalog = new AgentModelCatalog({
    userDataRoot,
    providerTypes: createProviderTypes(),
    credentials: vault,
    watchDebounceMs: 20,
  });
  await catalog.initialize();
  context.after(() => catalog.dispose());
  await writeFile(
    catalog.configPath,
    [
      "providers:",
      "  local:",
      "    providerType: openai-compatible",
      "    credentialId: LOCAL_API_KEY",
      "    settings:",
      `      baseURL: http://127.0.0.1:${address.port}/v1`,
      "    models:",
      "      - id: model-a",
      "",
    ].join("\n"),
    "utf8",
  );
  const missingCredential = await waitForConnection(catalog, "local");
  assert.equal(missingCredential.connections[0]?.credentialConfigured, false);
  assert.equal(missingCredential.connections[0]?.available, false);
  assert.deepEqual(missingCredential.models, []);
  await assert.rejects(
    catalog.discoverModels({
      providerType: "openai-compatible",
      credentialId: "LOCAL_API_KEY",
      settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
    }),
    /凭据尚未配置/u,
  );
  assert.deepEqual(requests, []);

  assert.deepEqual(
    await catalog.discoverModels({
      providerType: "openai-compatible",
      credentialValue: "temporary-secret",
      settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
    }),
    [{ id: "model-a" }, { id: "model-b" }],
  );
  assert.deepEqual(requests, [
    {
      url: "/v1/models",
      authorization: "Bearer temporary-secret",
    },
  ]);
  assert.deepEqual(JSON.parse(await readFile(vault.filePath, "utf8")).entries, {});
  requests.length = 0;
  await assert.rejects(
    catalog.discoverModels({
      providerType: "openai-compatible",
      credentialId: "LOCAL_API_KEY",
      credentialValue: "temporary-secret",
      settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
    }),
    /不能同时使用/u,
  );

  const withCredential = await catalog.writeCredential({
    credentialId: "LOCAL_API_KEY",
    value: "secret-value",
  });
  assert.equal(withCredential.connections[0]?.credentialConfigured, true);
  assert.equal(withCredential.connections[0]?.available, true);
  assert.deepEqual(withCredential.models, [
    { connectionId: "local", modelId: "model-a", name: "model-a" },
  ]);
  const credentialSource = await readFile(vault.filePath, "utf8");
  assert.doesNotMatch(credentialSource, /secret-value/u);
  assert.match(credentialSource, /ZW5jcnlwdGVkOnNlY3JldC12YWx1ZQ==/u);

  assert.deepEqual(
    await catalog.discoverModels({
      providerType: "openai-compatible",
      credentialId: "LOCAL_API_KEY",
      settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
    }),
    [{ id: "model-a" }, { id: "model-b" }],
  );
  assert.deepEqual(requests, [
    {
      url: "/v1/models",
      authorization: "Bearer secret-value",
    },
  ]);

  const withoutCredential = await catalog.removeCredential({ credentialId: "LOCAL_API_KEY" });
  assert.equal(withoutCredential.connections[0]?.credentialConfigured, false);
  assert.equal(withoutCredential.connections[0]?.available, false);
  assert.deepEqual(withoutCredential.models, []);
});

await test("Agent Session Journal 保留新对话标题并投影最近使用的模型", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-sessions-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const journal = new AgentSessionJournal(userDataRoot);
  await journal.initialize();
  const created = await journal.create({ connectionId: "openai", modelId: "gpt-a" });
  assert.equal(created.title, "新对话");

  await journal.appendMessage({
    sessionId: created.header.id,
    invocationId: "invocation-1",
    role: "user",
    content: "hello",
  });
  await journal.appendInvocation(created.header.id, {
    id: "invocation-1",
    state: "completed",
    model: { connectionId: "openai", modelId: "gpt-b" },
    text: "world",
  });

  const snapshot = await journal.snapshot(created.header.id);
  assert.equal(snapshot.title, "新对话");
  assert.deepEqual(snapshot.model, { connectionId: "openai", modelId: "gpt-b" });
  assert.deepEqual(
    snapshot.messages.map(({ role, content }) => ({ role, content })),
    [{ role: "user", content: "hello" }],
  );
  assert.deepEqual(snapshot.toolCalls, []);

  await journal.rename(created.header.id, "服务端规划");
  assert.equal((await journal.snapshot(created.header.id)).title, "服务端规划");
});
await test("Agent Session Journal 复制完整历史并重新分配记录身份", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-session-copy-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const journal = new AgentSessionJournal(userDataRoot);
  await journal.initialize();
  const source = await journal.create({ connectionId: "openai", modelId: "gpt-copy" });
  await journal.rename(source.header.id, "分支起点");
  await journal.appendInvocation(source.header.id, {
    id: "invocation-source",
    state: "completed",
    model: { connectionId: "openai", modelId: "gpt-copy" },
    text: "assistant answer",
  });
  await journal.appendMessage({
    sessionId: source.header.id,
    invocationId: "invocation-source",
    role: "user",
    content: "same question",
  });
  await journal.appendMessage({
    sessionId: source.header.id,
    invocationId: "invocation-source",
    role: "assistant",
    content: "assistant answer",
  });
  await journal.appendToolCall(source.header.id, {
    id: "tool-call-source",
    invocationId: "invocation-source",
    toolName: "read",
    presentation: { title: "读取分支资料" },
    state: "running",
    input: { path: "local://notes/branch.txt" },
    assistantTextOffset: 0,
    startedAt: "2026-08-23T10:00:00.000Z",
  });
  await journal.appendToolCall(source.header.id, {
    id: "tool-call-source",
    invocationId: "invocation-source",
    toolName: "read",
    presentation: { title: "读取分支资料" },
    state: "completed",
    input: { path: "local://notes/branch.txt" },
    output: { content: "branch context" },
    assistantTextOffset: 0,
    startedAt: "2026-08-23T10:00:00.000Z",
    finishedAt: "2026-08-23T10:00:01.000Z",
  });
  const sourceDirectory = join(journal.sessionsRoot, source.storageKey);
  await mkdir(join(sourceDirectory, "notes"));
  await writeFile(join(sourceDirectory, "notes", "branch.txt"), "branch context", "utf8");

  const copied = await journal.copy(source.header.id);
  const sourceLoaded = await journal.get(source.header.id);
  const copiedLoaded = await journal.get(copied.id);
  assert.notEqual(copied.id, source.header.id);
  assert.equal(copied.title, "分支起点");
  assert.deepEqual(
    copiedLoaded.messages.map(({ role, content, timestamp }) => ({ role, content, timestamp })),
    sourceLoaded.messages.map(({ role, content, timestamp }) => ({ role, content, timestamp })),
  );
  assert.deepEqual(
    copiedLoaded.invocations.map(({ state, model, text, error, timestamp }) => ({
      state,
      model,
      text,
      error,
      timestamp,
    })),
    sourceLoaded.invocations.map(({ state, model, text, error, timestamp }) => ({
      state,
      model,
      text,
      error,
      timestamp,
    })),
  );
  assert.notEqual(copiedLoaded.messages[0]?.id, sourceLoaded.messages[0]?.id);
  assert.notEqual(copiedLoaded.invocations[0]?.id, sourceLoaded.invocations[0]?.id);
  assert.equal(copiedLoaded.messages[0]?.invocationId, copiedLoaded.invocations[0]?.id);
  assert.equal(copiedLoaded.toolCalls.length, 1);
  assert.notEqual(copiedLoaded.toolCalls[0]?.id, sourceLoaded.toolCalls[0]?.id);
  assert.equal(copiedLoaded.toolCalls[0]?.invocationId, copiedLoaded.invocations[0]?.id);
  assert.deepEqual(
    {
      toolName: copiedLoaded.toolCalls[0]?.toolName,
      presentation: copiedLoaded.toolCalls[0]?.presentation,
      input: copiedLoaded.toolCalls[0]?.input,
      output: copiedLoaded.toolCalls[0]?.output,
      state: copiedLoaded.toolCalls[0]?.state,
    },
    {
      toolName: sourceLoaded.toolCalls[0]?.toolName,
      presentation: sourceLoaded.toolCalls[0]?.presentation,
      input: sourceLoaded.toolCalls[0]?.input,
      output: sourceLoaded.toolCalls[0]?.output,
      state: sourceLoaded.toolCalls[0]?.state,
    },
  );
  assert.equal(
    await readFile(
      join(journal.sessionsRoot, copiedLoaded.storageKey, "notes", "branch.txt"),
      "utf8",
    ),
    "branch context",
  );

  await journal.delete(source.header.id);
  assert.equal(
    await readFile(
      join(journal.sessionsRoot, copiedLoaded.storageKey, "notes", "branch.txt"),
      "utf8",
    ),
    "branch context",
  );
});

await test("Agent local:// 只读取当前 Session 并拒绝路径逃逸", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-local-resource-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const journal = new AgentSessionJournal(userDataRoot);
  await journal.initialize();
  const session = await journal.create({ connectionId: "test", modelId: "local-resource" });
  const sessionDirectory = join(journal.sessionsRoot, session.storageKey);
  await mkdir(join(sessionDirectory, "notes"));
  await writeFile(join(sessionDirectory, "a.txt"), "alpha", "utf8");
  const fileLines = Array.from({ length: 800 }, (_, index) => `line-${index + 1}`);
  await writeFile(join(sessionDirectory, "notes", "lines.txt"), fileLines.join("\n"), "utf8");

  const resources = bindAgentLocalResource(
    new AgentResourceRegistry().snapshot(),
    new AgentSessionLocalStore(sessionDirectory),
  );
  assert.deepEqual(
    resources.definitions.map(({ pattern }) => pattern),
    ["local://"],
  );
  const rootRead = resources.prepare("local://", {});
  assert.equal(rootRead.definition.presentation?.title, "读取local://");
  assert.equal(await rootRead.presentRequest(), undefined);
  const rootResult = await rootRead.read();
  assert.deepEqual(rootResult.content, {
    entries: [
      { name: "a.txt", kind: "file" },
      { name: "notes", kind: "directory" },
    ],
    pagination: {
      offset: 1,
      limit: 2,
      totalEntries: 2,
      hasMore: false,
    },
  });
  assert.deepEqual(await rootRead.presentResult(rootResult), [{ value: "2", unit: "个结果" }]);

  const rangedRead = resources.prepare("local://notes/lines.txt", {
    ranges: [
      { start: 1, length: 10 },
      { start: 500, length: 11 },
      { start: 700, length: 1 },
    ],
  });
  assert.equal(
    rangedRead.definition.presentation?.title,
    "读取local://notes/lines.txt第1~10行，第500~510行，第700行",
  );
  const rangedResult = await rangedRead.read();
  assert.equal(
    rangedResult.content,
    [
      "[Lines 1-10]",
      ...fileLines.slice(0, 10),
      "",
      "[Lines 500-510]",
      ...fileLines.slice(499, 510),
      "",
      "[Line 700]",
      fileLines[699],
    ].join("\n"),
  );
  assert.equal(await rangedRead.presentResult(rangedResult), undefined);
  assert.throws(
    () => resources.prepare("local://notes/lines.txt", { offset: 1, limit: 10 }),
    /input 包含未知参数/u,
  );
  await assert.rejects(
    resources.prepare("local://notes", { ranges: [{ start: 1, length: 1 }] }).read(),
    /目录不支持 ranges/u,
  );
  assert.throws(
    () => resources.prepare("local://%2E%2E/secret.txt", {}),
    /local:\/\/ 路径段不合法/u,
  );
  assert.throws(() => resources.prepare("local://C:%5Csecret.txt", {}), /local:\/\/ 路径段不合法/u);

  const outsideDirectory = join(userDataRoot, "outside");
  await mkdir(outsideDirectory);
  await writeFile(join(outsideDirectory, "secret.txt"), "secret", "utf8");
  await symlink(
    outsideDirectory,
    join(sessionDirectory, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    resources.prepare("local://escape/secret.txt", {}).read(),
    /禁止读取符号链接或 Junction/u,
  );
});

await test("Agent local:// 读取持久化前端卡片 payload", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-local-presentation-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const model = new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "local-read-1",
              toolName: "read",
              input: '{"path":"local://","input":{}}',
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "会话目录为空。" },
            { type: "text-end", id: "answer" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage,
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "local-read-2",
              toolName: "read",
              input:
                '{"path":"local://111.txt","input":{"ranges":[{"start":1,"length":10},{"start":500,"length":11},{"start":700,"length":1}]}}',
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "answer-2" },
            { type: "text-delta", id: "answer-2", delta: "已读取多个范围。" },
            { type: "text-end", id: "answer-2" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage,
            },
          ],
        }),
      },
    ],
  });
  const modelSource: AgentModelSource = {
    initialize: async () => {},
    list: async () => [],
    resolve: async () => ({
      selection: { connectionId: "test", modelId: "local-presentation" },
      languageModel: model,
    }),
  };
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: modelSource,
    toolSource: new AgentToolRegistry(),
    resourceSource: new AgentResourceRegistry(),
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());

  const reference = await runtime.startSession({
    initialMessage: { text: "查看当前会话目录。" },
    mode: "agent",
  });
  const invocation = await waitForInvocation(runtime, reference.invocationId);
  assert.equal(invocation.contextTokens, 2);
  assert.deepEqual(invocation.toolCalls[0]?.presentation, {
    title: "读取local://",
    resultPayload: [{ value: "0", unit: "个结果" }],
  });

  const session = await runtime.journal.get(reference.sessionId);
  const fileLines = Array.from({ length: 800 }, (_, index) => `line-${index + 1}`);
  await writeFile(
    join(runtime.journal.sessionsRoot, session.storageKey, "111.txt"),
    fileLines.join("\n"),
  );
  const fileReference = await runtime.sendMessage({
    sessionId: reference.sessionId,
    message: { text: "一次读取第 1～10、500～510 和 700 行。" },
    mode: "agent",
  });
  const fileInvocation = await waitForInvocation(runtime, fileReference.invocationId);
  assert.deepEqual(fileInvocation.toolCalls[0]?.presentation, {
    title: "读取local://111.txt第1~10行，第500~510行，第700行",
  });
  assert.equal(
    typeof fileInvocation.toolCalls[0]?.output === "string" &&
      fileInvocation.toolCalls[0].output.includes("[Lines 500-510]"),
    true,
  );
  const persistedSession = await runtime.getSession(reference.sessionId);
  assert.equal(persistedSession.toolCalls.length, 2);
  assert.equal(persistedSession.contextTokens, 2);
});

await test("Agent help:// 从冻结 Registry 快照生成工具与资源说明", async (context) => {
  const sessionRoot = await mkdtemp(join(tmpdir(), "seashard-agent-help-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(sessionRoot, { recursive: true, force: true });
  });

  const tools = new AgentToolRegistry();
  const toolRegistration = tools.register(
    "test.server-runtime",
    { type: "global", id: "global" },
    {
      namespace: "server",
      name: "startserver",
      title: "启动服务器",
      description: "启动一个已经创建的服务器实例。",
      inputSchema: {
        type: "object",
        properties: {
          instanceId: {
            type: "string",
            description: "服务器实例 ID。",
          },
        },
        required: ["instanceId"],
        additionalProperties: false,
      },
      outputDescription: "返回服务器启动后的当前状态。",
      examples: [{ instanceId: "survival" }],
    },
    async (input) => input,
  );
  const resources = new AgentResourceRegistry();
  const resourceRegistration = resources.register(
    "test.server-runtime",
    { type: "global", id: "global" },
    "server://instances/{instanceId}",
    {
      description: "读取指定服务器实例的状态。",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      outputDescription: "返回服务器实例当前状态。",
      examples: [{}],
      help: "该资源只读取状态；启动操作使用 server_startserver。",
      implementation: {
        read({ pathParams }) {
          return {
            mimeType: "application/json",
            content: { instanceId: pathParams.instanceId ?? "", state: "stopped" },
          };
        },
      },
    },
  );

  const localStore = new AgentSessionLocalStore(sessionRoot);
  const frozen = bindAgentHelpResource(
    bindAgentLocalResource(resources.snapshot(), localStore),
    tools.snapshot(),
  );
  const readMarkdown = async (
    snapshot: ReturnType<typeof bindAgentHelpResource>,
    path: string,
  ): Promise<string> => {
    const result = await snapshot.prepare(path, {}).read();
    assert.equal(result.mimeType, "text/markdown; charset=utf-8");
    assert.equal(typeof result.content, "string");
    return result.content as string;
  };

  const root = await readMarkdown(frozen, "help://");
  assert.match(root, /help:\/\/tool/u);
  assert.match(root, /help:\/\/resource/u);

  const toolHelp = await readMarkdown(frozen, "help://tool/server/startserver");
  assert.match(toolHelp, /Function Call：`server_startserver`/u);
  assert.match(toolHelp, /"instanceId"/u);
  assert.match(toolHelp, /"survival"/u);
  assert.match(toolHelp, /返回服务器启动后的当前状态/u);

  const localHelp = await readMarkdown(frozen, "help://resource/local");
  assert.match(localHelp, /`local:\/\/`/u);
  assert.match(localHelp, /"ranges"/u);
  assert.match(localHelp, /"maximum": 2000/u);
  assert.match(localHelp, /每组使用一基 start/u);

  const serverHelp = await readMarkdown(frozen, "help://resource/server");
  assert.match(serverHelp, /server:\/\/instances\/\{instanceId\}/u);
  assert.match(serverHelp, /路径参数[\s\S]*`instanceId`/u);
  assert.match(serverHelp, /server_startserver/u);

  assert.deepEqual(frozen.prepare("help://", {}).definition.presentation, {
    title: "获取帮助",
    icon: "help",
  });
  assert.deepEqual(frozen.prepare("help://resource", {}).definition.presentation, {
    title: "获取帮助: resources",
    icon: "help",
  });
  assert.deepEqual(frozen.prepare("help://resource/server", {}).definition.presentation, {
    title: "获取帮助: server",
    icon: "help",
  });
  assert.throws(
    () => frozen.prepare("help://resource/local", { unexpected: true }),
    /help:\/\/ input 包含未知参数/u,
  );
  await assert.rejects(
    () => frozen.prepare("help://tool/server/missing", {}).read(),
    /Agent 帮助资源不存在/u,
  );

  // 已冻结的 Invocation 继续保留原目录；新 Invocation 只读取注销后的 Registry 状态。
  toolRegistration.dispose();
  resourceRegistration.dispose();
  assert.match(await readMarkdown(frozen, "help://tool/server/startserver"), /server_startserver/u);
  const next = bindAgentHelpResource(
    bindAgentLocalResource(resources.snapshot(), localStore),
    tools.snapshot(),
  );
  assert.doesNotMatch(await readMarkdown(next, "help://tool"), /help:\/\/tool\/server/u);
  await assert.rejects(
    () => next.prepare("help://resource/server", {}).read(),
    /Agent 帮助资源不存在/u,
  );
});

await test("Agent Output Collector 保存长文本和结构化输出", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-output-collector-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const journal = new AgentSessionJournal(userDataRoot);
  await journal.initialize();
  const session = await journal.create({ connectionId: "test", modelId: "output-collector" });
  const store = new AgentSessionLocalStore(join(journal.sessionsRoot, session.storageKey));
  const collector = new AgentOutputCollector(store);

  const text = Array.from({ length: 240 }, (_, index) => `${index + 1}: ${"x".repeat(500)}`).join(
    "\n",
  );
  const textSummary = await collector.collect(text, "large-text");
  assert.equal(typeof textSummary, "string");
  assert.equal((textSummary as string).startsWith("1: "), true);
  assert.equal((textSummary as string).includes("240: "), false);
  assert.equal(
    (textSummary as string).endsWith(
      'Content is too long. Use read with path "local://tool-output/call-large-text.txt" to view the complete output.',
    ),
    true,
  );
  assert.equal(
    await readFile(join(store.sessionDirectory, "tool-output", "call-large-text.txt"), "utf8"),
    text,
  );

  const structured = { items: [text, text] };
  const structuredSummary = await collector.collect(structured, "large-json");
  assert.equal(typeof structuredSummary, "string");
  assert.equal((structuredSummary as string).startsWith('{\n  "items": ['), true);
  assert.equal(
    (structuredSummary as string).endsWith(
      'Content is too long. Use read with path "local://tool-output/call-large-json.json" to view the complete output.',
    ),
    true,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(store.sessionDirectory, "tool-output", "call-large-json.json"), "utf8"),
    ),
    structured,
  );
  assert.deepEqual(await collector.collect({ ok: true }, "small-json"), { ok: true });
});

await test("Agent Session Journal 为无展示字段的读取记录补默认标题", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-damaged-tool-call-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const journal = new AgentSessionJournal(userDataRoot);
  await journal.initialize();
  const created = await journal.create({ connectionId: "openai", modelId: "gpt-a" });
  await journal.appendMessage({
    sessionId: created.header.id,
    invocationId: "invocation-1",
    role: "user",
    content: "保留这条消息",
  });
  await journal.appendInvocation(created.header.id, {
    id: "invocation-1",
    state: "completed",
    model: { connectionId: "openai", modelId: "gpt-a" },
    text: "已保留",
  });
  await appendFile(
    join(journal.sessionsRoot, `${created.storageKey}.jsonl`),
    `${JSON.stringify({
      type: "tool-call",
      timestamp: "2026-08-23T07:51:51.000Z",
      id: "legacy-read-1",
      invocationId: "invocation-1",
      toolName: "read",
      title: "读取资源",
      state: "completed",
      input: { path: "server://instances" },
      output: [],
      assistantTextOffset: 0,
      startedAt: "2026-08-23T07:51:50.000Z",
      finishedAt: "2026-08-23T07:51:51.000Z",
    })}\n`,
    "utf8",
  );

  const snapshot = await journal.snapshot(created.header.id);
  assert.deepEqual(
    snapshot.messages.map(({ content }) => content),
    ["保留这条消息"],
  );
  assert.deepEqual(snapshot.toolCalls, [
    {
      id: "legacy-read-1",
      invocationId: "invocation-1",
      toolName: "read",
      presentation: { title: "读取资源" },
      state: "completed",
      input: { path: "server://instances" },
      output: [],
      assistantTextOffset: 0,
      startedAt: "2026-08-23T07:51:50.000Z",
      finishedAt: "2026-08-23T07:51:51.000Z",
    },
  ]);
  await journal.appendToolCall(created.header.id, {
    id: "help-read-1",
    invocationId: "invocation-1",
    toolName: "read",
    presentation: { title: "获取帮助: server", icon: "help" },
    state: "completed",
    input: { path: "help://resource/server", input: {} },
    output: "# `server://` 资源",
    assistantTextOffset: 0,
    startedAt: "2026-08-23T07:52:00.000Z",
    finishedAt: "2026-08-23T07:52:01.000Z",
  });
  assert.deepEqual(
    (await journal.snapshot(created.header.id)).toolCalls.find(({ id }) => id === "help-read-1")
      ?.presentation,
    { title: "获取帮助: server", icon: "help" },
  );
  assert.deepEqual(
    (await journal.list()).map(({ id }) => id),
    [created.header.id],
  );
});

await test("Agent 通用 read 工具保留领域分页并持久化展示投影", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-read-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const usage = {
    inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined },
  };
  const model = new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "resource-read-1",
              toolName: "read",
              input: '{"path":"server://instances","input":{"offset":2,"limit":1}}',
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "读取到了第二个服务器。" },
            { type: "text-end", id: "answer" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage,
            },
          ],
        }),
      },
    ],
  });
  const configuredModel = {
    connectionId: "test",
    modelId: "resource-model",
    name: "Resource Model",
  };
  const modelSource: AgentModelSource = {
    initialize: async () => {},
    list: async () => [configuredModel],
    resolve: async () => ({
      selection: { connectionId: configuredModel.connectionId, modelId: configuredModel.modelId },
      languageModel: model,
    }),
  };
  const resources = new AgentResourceRegistry();
  resources.register(
    "test.server-manager",
    { type: "global", id: "global" },
    "server://instances",
    {
      description: "读取服务器实例列表。",
      inputSchema: {
        type: "object",
        properties: {
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1 },
        },
        required: ["offset", "limit"],
        additionalProperties: false,
      },
      outputDescription: "返回完整实例条目和分页信息。",
      presentation: { title: "读取服务器实例" },
      implementation: {
        async read({ input }) {
          const options = input as { offset: number; limit: number };
          const instances = ["Paper", "Fabric", "Vanilla"];
          const items = instances.slice(options.offset - 1, options.offset - 1 + options.limit);
          return {
            mimeType: "application/json",
            content: {
              items,
              pagination: {
                offset: options.offset,
                limit: options.limit,
                total: instances.length,
                hasMore: options.offset - 1 + items.length < instances.length,
              },
            },
          };
        },
        presentRequest({ input }) {
          const options = input as { offset: number; limit: number };
          return [{ value: `${options.offset}～${options.offset + options.limit - 1}` }];
        },
        presentResult(_request, result) {
          const content = result.content as unknown as { items: readonly JsonValue[] };
          return [{ value: String(content.items.length), unit: "个结果" }];
        },
      },
    },
  );
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: modelSource,
    toolSource: new AgentToolRegistry(),
    resourceSource: resources,
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());

  const reference = await runtime.startSession({
    initialMessage: { text: "读取第二个服务器。" },
    mode: "agent",
  });
  const invocation = await waitForInvocation(runtime, reference.invocationId);
  assert.equal(invocation.state, "completed");
  assert.equal(invocation.text, "读取到了第二个服务器。");
  assert.equal(model.doStreamCalls.length, 2);
  assert.deepEqual(
    model.doStreamCalls[0]?.tools?.map(({ name }) => name),
    ["read"],
  );
  const readToolMetadata = JSON.stringify(model.doStreamCalls[0]?.tools);
  assert.match(readToolMetadata, /server:\/\/instances/u);
  assert.match(readToolMetadata, /读取服务器实例列表/u);
  assert.match(readToolMetadata, /不要猜测或使用列表外/u);
  assert.match(readToolMetadata, /help:\/\//u);
  assert.deepEqual(invocation.toolCalls, [
    {
      id: "resource-read-1",
      invocationId: reference.invocationId,
      toolName: "read",
      presentation: {
        title: "读取服务器实例",
        requestPayload: [{ value: "2～2" }],
        resultPayload: [{ value: "1", unit: "个结果" }],
      },
      state: "completed",
      input: {
        path: "server://instances",
        input: { offset: 2, limit: 1 },
      },
      output: {
        items: ["Fabric"],
        pagination: { offset: 2, limit: 1, total: 3, hasMore: true },
      },
      assistantTextOffset: 0,
      startedAt: invocation.toolCalls[0]?.startedAt,
      finishedAt: invocation.toolCalls[0]?.finishedAt,
    },
  ]);
});

await test("Agent 资源展示投影失败不会中断读取", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-presenter-failure-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const model = new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "presenter-failure-1",
              toolName: "read",
              input: '{"path":"test://presenter-failure","input":{}}',
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "读取完成。" },
            { type: "text-end", id: "answer" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage,
            },
          ],
        }),
      },
    ],
  });
  const modelSource: AgentModelSource = {
    initialize: async () => {},
    list: async () => [],
    resolve: async () => ({
      selection: { connectionId: "test", modelId: "presenter-failure-model" },
      languageModel: model,
    }),
  };
  const resources = new AgentResourceRegistry();
  resources.register(
    "test.presenter-failure",
    { type: "global", id: "global" },
    "test://presenter-failure",
    {
      description: "验证展示投影故障隔离。",
      inputSchema: { type: "object", additionalProperties: false },
      implementation: {
        async read() {
          return { mimeType: "application/json", content: { ok: true } };
        },
        presentRequest() {
          return [{ value: "测试请求" }];
        },
        presentResult() {
          throw new Error("fixture presenter failed");
        },
      },
    },
  );
  const reported: unknown[] = [];
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: modelSource,
    toolSource: new AgentToolRegistry(),
    resourceSource: resources,
    reportError: (error) => reported.push(error),
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());

  const reference = await runtime.startSession({
    initialMessage: { text: "读取测试资源。" },
    mode: "agent",
  });
  const invocation = await waitForInvocation(runtime, reference.invocationId);
  assert.equal(invocation.state, "completed");
  assert.deepEqual(invocation.toolCalls[0]?.output, { ok: true });
  assert.deepEqual(invocation.toolCalls[0]?.presentation, {
    title: "读取资源",
    requestPayload: [{ value: "测试请求" }],
  });
  assert.deepEqual(
    reported.map((error) => (error instanceof Error ? error.message : String(error))),
    ["fixture presenter failed"],
  );
});

await test("Agent 模式按文本偏移持久化多次工具活动", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-tools-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const usage = {
    inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined },
  };
  const model = new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "first-analysis" },
            { type: "text-delta", id: "first-analysis", delta: "先检查。" },
            { type: "text-end", id: "first-analysis" },
            {
              type: "tool-call",
              toolCallId: "echo-1",
              toolName: "test_echo",
              input: '{"value":"probe"}',
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "second-analysis" },
            { type: "text-delta", id: "second-analysis", delta: "继续检查。" },
            { type: "text-end", id: "second-analysis" },
            {
              type: "tool-call",
              toolCallId: "echo-2",
              toolName: "test_echo",
              input: '{"value":"next"}',
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "回显完成。" },
            { type: "text-end", id: "answer" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage,
            },
          ],
        }),
      },
    ],
  });
  const configuredModel = {
    connectionId: "test",
    modelId: "tool-model",
    name: "Tool Model",
  };
  const modelSource: AgentModelSource = {
    initialize: async () => {},
    list: async () => [configuredModel],
    resolve: async () => ({
      selection: { connectionId: configuredModel.connectionId, modelId: configuredModel.modelId },
      languageModel: model,
    }),
  };
  const executions: JsonValue[] = [];
  const toolRegistry = new AgentToolRegistry();
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: modelSource,
    toolSource: toolRegistry,
    resourceSource: new AgentResourceRegistry(),
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());
  // Runtime 构造完成后再注册，证明 Invocation 读取的是实时 Registry 快照。
  toolRegistry.register(
    "test.echo",
    { type: "global", id: "global" },
    {
      namespace: "test",
      name: "echo",
      title: "测试回显",
      description: "回显输入内容。",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    async (input) => {
      executions.push(input);
      return input;
    },
  );

  const reference = await runtime.startSession({
    initialMessage: { text: "连续回显两次。" },
    mode: "agent",
  });
  const invocation = await waitForInvocation(runtime, reference.invocationId);
  assert.equal(invocation.state, "completed");
  assert.equal(invocation.text, "先检查。继续检查。回显完成。");
  assert.deepEqual(executions, [{ value: "probe" }, { value: "next" }]);
  assert.equal(model.doStreamCalls.length, 3);
  assert.deepEqual(
    model.doStreamCalls[0]?.tools?.map(({ name }) => name),
    ["read", "test_echo"],
  );
  assert.deepEqual(invocation.toolCalls, [
    {
      id: "echo-1",
      invocationId: reference.invocationId,
      toolName: "test_echo",
      presentation: { title: "测试回显" },
      state: "completed",
      input: { value: "probe" },
      output: { value: "probe" },
      assistantTextOffset: "先检查。".length,
      startedAt: invocation.toolCalls[0]?.startedAt,
      finishedAt: invocation.toolCalls[0]?.finishedAt,
    },
    {
      id: "echo-2",
      invocationId: reference.invocationId,
      toolName: "test_echo",
      presentation: { title: "测试回显" },
      state: "completed",
      input: { value: "next" },
      output: { value: "next" },
      assistantTextOffset: "先检查。继续检查。".length,
      startedAt: invocation.toolCalls[1]?.startedAt,
      finishedAt: invocation.toolCalls[1]?.finishedAt,
    },
  ]);
  assert.deepEqual(
    interleaveAgentInvocationContent(invocation.text, invocation.toolCalls).map((part) =>
      part.kind === "text"
        ? { kind: part.kind, content: part.content }
        : { kind: part.kind, id: part.call.id },
    ),
    [
      { kind: "text", content: "先检查。" },
      { kind: "tool", id: "echo-1" },
      { kind: "text", content: "继续检查。" },
      { kind: "tool", id: "echo-2" },
      { kind: "text", content: "回显完成。" },
    ],
  );

  const session = await runtime.getSession(reference.sessionId);
  assert.deepEqual(session.toolCalls, invocation.toolCalls);
  assert.deepEqual(
    session.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "连续回显两次。" },
      { role: "assistant", content: "先检查。继续检查。回显完成。" },
    ],
  );
});

await test("Agent 工具长输出以前缀和英文 local 指令进入模型上下文", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-bounded-tool-output-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const model = new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "large-1",
              toolName: "test_large",
              input: "{}",
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "长输出已保存。" },
            { type: "text-end", id: "answer" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage,
            },
          ],
        }),
      },
    ],
  });
  const modelSource: AgentModelSource = {
    initialize: async () => {},
    list: async () => [],
    resolve: async () => ({
      selection: { connectionId: "test", modelId: "bounded-output" },
      languageModel: model,
    }),
  };
  const largeOutput = Array.from(
    { length: 240 },
    (_, index) => `${index + 1}: ${"z".repeat(500)}`,
  ).join("\n");
  const tools = new AgentToolRegistry();
  tools.register(
    "test.large",
    { type: "global", id: "global" },
    {
      namespace: "test",
      name: "large",
      title: "生成长输出",
      description: "生成用于边界验证的长文本。",
      inputSchema: { type: "object", additionalProperties: false },
    },
    async () => largeOutput,
  );
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: modelSource,
    toolSource: tools,
    resourceSource: new AgentResourceRegistry(),
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());

  const reference = await runtime.startSession({
    initialMessage: { text: "生成长输出。" },
    mode: "agent",
  });
  const invocation = await waitForInvocation(runtime, reference.invocationId);
  const output = invocation.toolCalls[0]?.output;
  assert.equal(typeof output, "string");
  assert.equal((output as string).startsWith("1: "), true);
  assert.equal(
    (output as string).endsWith(
      'Content is too long. Use read with path "local://tool-output/call-large-1.txt" to view the complete output.',
    ),
    true,
  );
  const session = await runtime.journal.get(reference.sessionId);
  assert.equal(
    await readFile(
      join(runtime.journal.sessionsRoot, session.storageKey, "tool-output", "call-large-1.txt"),
      "utf8",
    ),
    largeOutput,
  );
  assert.match(JSON.stringify(model.doStreamCalls[1]), /local:\/\/tool-output\/call-large-1\.txt/u);
});

await test("OpenAI Responses 工具结果会触发第二次上游请求", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-responses-loop-"));
  const requests: Array<Record<string, unknown>> = [];
  const expectedResourceItems = [
    {
      id: "server-1",
      name: "Paper",
      storageMode: "managed",
      source: "downloaded",
      modLoader: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T01:00:00.000Z",
      serverType: "paper",
      gameVersion: "1.21.1",
    },
  ];
  const expectedToolOutput = {
    items: expectedResourceItems,
    pagination: {
      page: 1,
      pageSize: 10,
      totalItems: 1,
      totalPages: 1,
      hasMore: false,
    },
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push(JSON.parse(body) as Record<string, unknown>);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const event of openAiResponseEvents(requests.length)) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  context.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const address = server.address();
  assert(address && typeof address === "object");

  const catalog = new AgentModelCatalog({
    userDataRoot,
    providerTypes: createProviderTypes(),
    environment: { TEST_OPENAI_API_KEY: "test-key" },
  });
  await catalog.initialize();
  await writeFile(
    catalog.configPath,
    [
      "providers:",
      "  test:",
      "    providerType: openai",
      "    credentialId: TEST_OPENAI_API_KEY",
      "    settings:",
      `      baseURL: http://127.0.0.1:${address.port}/v1`,
      "    models:",
      "      - id: gpt-5.6-sol",
      "        displayName: GPT-5.6 Sol",
      "        settings:",
      "          maximumContextTokens: 256000",
      "          reasoningLevels: [low, high, max]",
    ].join("\n"),
    "utf8",
  );
  await waitForModels(catalog, ["test/gpt-5.6-sol"]);
  const resourceRegistry = new AgentResourceRegistry();
  registerServerInstanceAgentResources(
    {
      agentResources(resources) {
        for (const [pattern, resource] of Object.entries(resources)) {
          resourceRegistry.register(
            "test.server-instance-manager",
            { type: "global", id: "global" },
            pattern,
            resource,
          );
        }
      },
    },
    {
      listInstances: async () => [
        {
          id: "server-1",
          name: "Paper",
          rootPath: "C:/SeaShard/servers/server-1",
          coreJarPath: "C:/SeaShard/servers/server-1/paper.jar",
          storageMode: "managed",
          source: "downloaded",
          modLoader: null,
          serverType: "paper",
          gameVersion: "1.21.1",
          createdAt: "2026-08-21T00:00:00.000Z",
          updatedAt: "2026-08-21T01:00:00.000Z",
        },
      ],
    },
  );
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: catalog,
    toolSource: new AgentToolRegistry(),
    resourceSource: resourceRegistry,
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());

  const reference = await runtime.startSession({
    initialMessage: { text: "我有哪些服务器？" },
    mode: "agent",
    model: { connectionId: "test", modelId: "gpt-5.6-sol", reasoningLevel: "max" },
  });
  const invocation = await waitForInvocation(runtime, reference.invocationId);
  assert.equal(invocation.state, "completed");
  assert.equal(invocation.text, "当前有 1 个服务器。");
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(({ store }) => store),
    [false, false],
  );
  assert.deepEqual(
    requests.map(({ reasoning }) => (reasoning as Record<string, unknown> | undefined)?.effort),
    ["max", "max"],
  );
  assert.equal((await runtime.getSession(reference.sessionId)).model.reasoningLevel, "max");
  assert.equal(invocation.model.reasoningLevel, "max");
  assert.deepEqual(requests[0]?.include, ["reasoning.encrypted_content"]);
  const upstreamToolMetadata = JSON.stringify(requests[0]?.tools);
  assert.match(upstreamToolMetadata, /server:\/\/instances/u);
  assert.match(upstreamToolMetadata, /已登记的服务器实例/u);

  const secondInput = requests[1]?.input;
  assert(Array.isArray(secondInput));
  const continuation = secondInput.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object" && "type" in item),
  );
  assert.deepEqual(continuation.slice(0, 2), [
    {
      type: "reasoning",
      id: "reasoning-1",
      encrypted_content: "encrypted-reasoning-context",
      summary: [],
    },
    {
      type: "function_call",
      call_id: "server-read-1",
      name: "read",
      arguments: '{"path":"server://instances","input":{}}',
    },
  ]);
  assert.equal(continuation[2]?.type, "function_call_output");
  assert.equal(continuation[2]?.call_id, "server-read-1");
  assert.equal(typeof continuation[2]?.output, "string");
  assert.deepEqual(JSON.parse(continuation[2]?.output as string), expectedToolOutput);
});

function openAiResponseEvents(requestNumber: number): readonly Record<string, unknown>[] {
  const response = {
    id: `response-${requestNumber}`,
    created_at: 1_755_734_400,
    model: "gpt-5.6-sol",
    service_tier: null,
  };
  const completed = {
    type: "response.completed",
    response: {
      incomplete_details: null,
      usage: {
        input_tokens: 1,
        input_tokens_details: null,
        output_tokens: 1,
        output_tokens_details: null,
      },
      reasoning: null,
      service_tier: null,
    },
  };
  if (requestNumber === 1) {
    const reasoning = {
      type: "reasoning",
      id: "reasoning-1",
      encrypted_content: "encrypted-reasoning-context",
      summary: [],
    };
    const call = {
      type: "function_call",
      id: "function-call-1",
      call_id: "server-read-1",
      name: "read",
      arguments: '{"path":"server://instances","input":{}}',
    };
    return [
      { type: "response.created", response },
      { type: "response.output_item.added", output_index: 0, item: reasoning },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...reasoning, status: "completed" },
      },
      { type: "response.output_item.added", output_index: 1, item: call },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { ...call, status: "completed" },
      },
      completed,
    ];
  }
  return [
    { type: "response.created", response },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "message-1", phase: "final_answer" },
    },
    {
      type: "response.output_text.delta",
      item_id: "message-1",
      output_index: 0,
      delta: "当前有 1 个服务器。",
      logprobs: null,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "message-1", phase: "final_answer" },
    },
    completed,
  ];
}

async function waitForInvocation(
  runtime: AgentRuntime,
  invocationId: string,
): Promise<Awaited<ReturnType<AgentRuntime["getInvocation"]>>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const invocation = await runtime.getInvocation(invocationId);
    if (invocation.state !== "running") return invocation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Agent Invocation did not finish");
}
