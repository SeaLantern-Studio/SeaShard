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
  AgentSettingsStore,
  AgentSessionLocalStore,
  bindAgentHelpResource,
  registerBuiltInAgentProviderTypes,
  shouldRefreshConversationTitle,
  bindAgentLocalResource,
  type AgentModelSource,
} from "../components/agent/runtime/src/index.ts";
import { agentWorkspace } from "../frontend/agent/shared/src/index.ts";
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
import type {
  JsonValue,
  PluginStorage,
  PluginStoredDocument,
} from "../packages/plugin-sdk/src/index.ts";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type Models,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

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

class MemoryPluginStorage implements PluginStorage {
  private readonly documents = new Map<string, PluginStoredDocument>();

  async get(key: string): Promise<PluginStoredDocument | undefined> {
    return this.documents.get(key);
  }

  async put(key: string, value: JsonValue): Promise<PluginStoredDocument> {
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

type ScriptedModelResponse =
  | AssistantMessage
  | ((
      context: Context,
      options?: SimpleStreamOptions,
    ) => AssistantMessage | Promise<AssistantMessage>);

function createScriptedModelSource(
  modelId: string,
  responses: readonly ScriptedModelResponse[],
  name = "Test Model",
  reasoningLevels: readonly string[] = defaultAgentModelReasoningLevels,
): {
  readonly modelSource: AgentModelSource;
  readonly calls: Array<{ context: Context; options?: SimpleStreamOptions }>;
  readonly resolutions: Array<{
    readonly connectionId: string;
    readonly modelId: string;
    readonly reasoningLevel?: string;
  }>;
} {
  const faux = fauxProvider({
    api: "test-api",
    provider: "test",
    models: [{ id: modelId, name, reasoning: true, contextWindow: 128_000 }],
  });
  const calls: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
  const resolutions: Array<{
    readonly connectionId: string;
    readonly modelId: string;
    readonly reasoningLevel?: string;
  }> = [];
  faux.setResponses(
    responses.map((response) => (context, options) => {
      calls.push({
        context: JSON.parse(JSON.stringify(context)) as Context,
        ...(options ? { options: JSON.parse(JSON.stringify(options)) as SimpleStreamOptions } : {}),
      });
      return typeof response === "function" ? response(context, options) : response;
    }),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const configuredModel = {
    connectionId: "test",
    modelId,
    name,
    settings: {
      maximumContextTokens: 128_000,
      reasoningLevels,
    },
  };
  return {
    calls,
    resolutions,
    modelSource: {
      initialize: async () => {},
      list: async () => [configuredModel],
      resolve: async (selection) => {
        const resolvedSelection = selection ?? {
          connectionId: configuredModel.connectionId,
          modelId,
        };
        resolutions.push({ ...resolvedSelection });
        return {
          selection: { ...resolvedSelection },
          models,
          model: faux.getModel(),
        };
      },
    },
  };
}

function firstModelMessageText(context: Context): string {
  const content = context.messages[0]?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Extract<(typeof content)[number], { type: "text" }> => {
      return block.type === "text";
    })
    .map((block) => block.text)
    .join("");
}

await test("pi-ai 内建供应商目录完整注册并保留自定义兼容入口", () => {
  const definitions = createProviderTypes().snapshot().definitions;
  assert.deepEqual(
    definitions.map(({ id }) => id),
    [
      "amazon-bedrock",
      "ant-ling",
      "anthropic",
      "azure-openai-responses",
      "baseten",
      "cerebras",
      "cloudflare-ai-gateway",
      "cloudflare-workers-ai",
      "deepseek",
      "fireworks",
      "github-copilot",
      "google",
      "google-vertex",
      "groq",
      "huggingface",
      "kimi-coding",
      "minimax",
      "minimax-cn",
      "mistral",
      "moonshotai",
      "moonshotai-cn",
      "nvidia",
      "openai",
      "openai-codex",
      "openai-compatible",
      "opencode",
      "opencode-go",
      "openrouter",
      "qwen-token-plan",
      "qwen-token-plan-cn",
      "qwen-token-plan-individual",
      "radius",
      "together",
      "vercel-ai-gateway",
      "xai",
      "xiaomi",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-cn",
      "xiaomi-token-plan-sgp",
      "zai",
      "zai-coding-cn",
    ],
  );
  for (const definition of definitions) {
    assert.equal(typeof definition.create, "function");
    if (definition.id !== "openai-compatible" && definition.id !== "radius") {
      assert.ok((definition.catalog?.length ?? 0) > 0, `${definition.id} 应提供模型目录`);
    }
  }
  assert.equal(
    typeof definitions.find(({ id }) => id === "openai-compatible")?.discoverModels,
    "function",
  );
  assert.equal(typeof definitions.find(({ id }) => id === "radius")?.discoverModels, "function");
});

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
  context.after(() => catalog.dispose());
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

  const listedModels = await catalog.list();
  assert.deepEqual(
    listedModels.map(({ settings: _settings, ...model }) => model),
    [
      {
        connectionId: "local",
        modelId: "qwen3-coder",
        name: "Qwen 3 Coder",
      },
    ],
  );
  assert.equal(listedModels[0]?.settings?.api, "openai-completions");
  assert.equal(listedModels[0]?.settings?.maximumContextTokens, 128_000);
  const resolved = await catalog.resolve({ connectionId: "local", modelId: "qwen3-coder" });
  assert.deepEqual(resolved.selection, {
    connectionId: "local",
    modelId: "qwen3-coder",
    reasoningLevel: "low",
  });
  assert.equal(dirname(catalog.configPath), join(userDataRoot, "agent"));
});
await test("Runtime 模型投影保留配置中的推理档位顺序", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-model-order-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const catalog = new AgentModelCatalog({
    userDataRoot,
    providerTypes: createProviderTypes(),
    environment: {},
  });
  await catalog.initialize();
  context.after(() => catalog.dispose());
  const reasoningLevels = ["low", "medium", "high", "xhigh", "max", "ultra"];
  await writeFile(
    catalog.configPath,
    [
      "providers:",
      "  ordered:",
      "    providerType: openai",
      "    settings: {}",
      "    models:",
      "      - id: gpt-5.6-luna",
      "        settings:",
      "          maximumContextTokens: 272000",
      `          reasoningLevels: [${reasoningLevels.join(", ")}]`,
      "",
    ].join("\n"),
    "utf8",
  );
  await waitForModels(catalog, ["ordered/gpt-5.6-luna"]);

  assert.deepEqual((await catalog.list())[0]?.settings?.reasoningLevels, reasoningLevels);
  assert.deepEqual(
    (await catalog.getConfiguration()).connections[0]?.models?.[0]?.settings?.reasoningLevels,
    reasoningLevels,
  );
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
  assert.deepEqual(
    (await catalog.list()).map(({ settings: _settings, ...model }) => model),
    [{ connectionId: "local", modelId: "model-a", name: "model-a" }],
  );
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
  assert.equal(after.models[0]?.settings?.maximumContextTokens, 256_000);
  assert.deepEqual(after.models[0]?.settings?.reasoningLevels, ["brief", "deep", "beyond"]);
  assert.equal(after.models[0]?.settings?.api, "openai-completions");
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
  assert.equal(resolved.reasoning, "medium");
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
  assert.deepEqual(
    withCredential.models.map(({ settings: _settings, ...model }) => model),
    [{ connectionId: "local", modelId: "model-a", name: "model-a" }],
  );
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

await test("同供应商多连接隔离端点、凭据与 Models 容器", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-connection-isolation-"));
  const requests: Array<{ readonly url?: string; readonly authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // 必须读完请求体，OpenAI SDK 才能稳定复用或关闭当前连接。
    }
    requests.push({
      url: request.url,
      authorization:
        typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : undefined,
    });
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const event of openAiResponseEvents(2)) {
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
    environment: {
      OFFICIAL_OPENAI_KEY: "official-secret",
      PROXY_OPENAI_KEY: "proxy-secret",
    },
  });
  await catalog.initialize();
  context.after(() => catalog.dispose());
  await writeFile(
    catalog.configPath,
    [
      "providers:",
      "  official:",
      "    providerType: openai",
      "    credentialId: OFFICIAL_OPENAI_KEY",
      "    settings:",
      `      baseURL: http://127.0.0.1:${address.port}/official/v1`,
      "    models:",
      "      - id: gpt-5.6-sol",
      "  proxy:",
      "    providerType: openai",
      "    credentialId: PROXY_OPENAI_KEY",
      "    settings:",
      `      baseURL: http://127.0.0.1:${address.port}/proxy/v1`,
      "    models:",
      "      - id: gpt-5.6-sol",
      "",
    ].join("\n"),
    "utf8",
  );
  await waitForModels(catalog, ["official/gpt-5.6-sol", "proxy/gpt-5.6-sol"]);

  const official = await catalog.resolve({
    connectionId: "official",
    modelId: "gpt-5.6-sol",
  });
  const proxy = await catalog.resolve({ connectionId: "proxy", modelId: "gpt-5.6-sol" });
  assert.notEqual(official.models, proxy.models);
  assert.match(official.model.baseUrl, /\/official\/v1$/u);
  assert.match(proxy.model.baseUrl, /\/proxy\/v1$/u);

  for (const [index, resolved] of [official, proxy].entries()) {
    const stream = resolved.models.streamSimple(
      resolved.model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: `连接 ${index + 1}` }],
            timestamp: Date.now(),
          },
        ],
      },
      { sessionId: `connection-${index + 1}` },
    );
    let message: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === "done") message = event.message;
    }
    assert.equal(message?.content[0]?.type, "text");
    assert.equal(
      message?.content[0]?.type === "text" ? message.content[0].text : "",
      "当前有 1 个服务器。",
    );
  }
  assert.deepEqual(requests, [
    { url: "/official/v1/responses", authorization: "Bearer official-secret" },

    { url: "/proxy/v1/responses", authorization: "Bearer proxy-secret" },
  ]);
});
await test("Agent 设置默认开启自动总结并持久化关闭状态", async () => {
  const storage = new MemoryPluginStorage();
  const first = new AgentSettingsStore(storage);
  assert.deepEqual(await first.get(), { automaticConversationSummary: true });
  assert.deepEqual(await first.setAutomaticConversationSummary(false), {
    automaticConversationSummary: false,
  });
  const reloaded = new AgentSettingsStore(storage);
  assert.deepEqual(await reloaded.get(), { automaticConversationSummary: false });
});

await test("自动标题首轮并行总结用户问题并按 3–5 轮 AI 回答刷新", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-auto-title-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  let answerNumber = 0;
  const responder: ScriptedModelResponse = (modelContext) => {
    const prompt = firstModelMessageText(modelContext);
    if (prompt.includes("【用户问题开始】")) {
      return fauxAssistantMessage("# 「首轮规划标题。」");
    }
    if (prompt.includes("【AI 回答开始】")) {
      return fauxAssistantMessage("**阶段实现标题！**");
    }
    answerNumber += 1;
    return fauxAssistantMessage(`第${answerNumber}轮 AI 回答`);
  };
  const { modelSource, calls, resolutions } = createScriptedModelSource(
    "title-model",
    Array.from({ length: 16 }, () => responder),
    "Title Model",
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: modelSource,
    settingsSource: {
      get: async () => ({ automaticConversationSummary: true }),
    },
    toolSource: new AgentToolRegistry(),
    resourceSource: new AgentResourceRegistry(),
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());

  const firstQuestion = "如何规划一个新的 Minecraft 服务端？";
  const firstReference = await runtime.startSession({
    initialMessage: { text: firstQuestion },
    mode: "chat",
    model: { connectionId: "test", modelId: "title-model", reasoningLevel: "high" },
  });
  await waitForInvocation(runtime, firstReference.invocationId);
  assert.equal((await runtime.getSession(firstReference.sessionId)).title, "首轮规划标题");
  assert.deepEqual(resolutions.slice(0, 2), [
    { connectionId: "test", modelId: "title-model", reasoningLevel: "high" },
    { connectionId: "test", modelId: "title-model", reasoningLevel: "low" },
  ]);

  let refreshTurn = 2;
  while (!shouldRefreshConversationTitle(firstReference.sessionId, refreshTurn)) {
    refreshTurn += 1;
  }
  assert.ok(refreshTurn >= 4 && refreshTurn <= 6);
  for (let turn = 2; turn <= refreshTurn; turn += 1) {
    const reference = await runtime.sendMessage({
      sessionId: firstReference.sessionId,
      message: { text: `第${turn}轮用户问题` },
      mode: "chat",
    });
    await waitForInvocation(runtime, reference.invocationId);
  }
  assert.equal((await runtime.getSession(firstReference.sessionId)).title, "阶段实现标题");

  const summaryPrompts = calls
    .map(({ context: modelContext }) => firstModelMessageText(modelContext))
    .filter((prompt) => prompt.includes("你是对话标题生成器"));
  assert.equal(summaryPrompts.length, 2);
  assert.match(summaryPrompts[0] ?? "", new RegExp(firstQuestion, "u"));
  assert.doesNotMatch(summaryPrompts[0] ?? "", /第1轮 AI 回答/u);
  assert.match(summaryPrompts[1] ?? "", new RegExp(`第${refreshTurn}轮 AI 回答`, "u"));
  assert.doesNotMatch(summaryPrompts[1] ?? "", new RegExp(`第${refreshTurn}轮用户问题`, "u"));

  const refreshTurns = Array.from({ length: 30 }, (_, index) => index + 2).filter((turn) =>
    shouldRefreshConversationTitle(firstReference.sessionId, turn),
  );
  const intervals = refreshTurns.map((turn, index) =>
    index === 0 ? turn - 1 : turn - (refreshTurns[index - 1] ?? turn),
  );
  assert.ok(intervals.length >= 5);
  assert.equal(
    intervals.every((interval) => interval >= 3 && interval <= 5),
    true,
  );
});

await test("首轮标题在主 Invocation 仍运行时进入轮询快照", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-live-title-"));
  let releaseMain!: () => void;
  const mainGate = new Promise<void>((resolve) => {
    releaseMain = resolve;
  });
  const responder: ScriptedModelResponse = async (modelContext) => {
    const prompt = firstModelMessageText(modelContext);
    if (prompt.includes("【用户问题开始】")) {
      return fauxAssistantMessage("运行中标题");
    }
    await mainGate;
    return fauxAssistantMessage("主回答完成");
  };
  const { modelSource } = createScriptedModelSource(
    "live-title-model",
    [responder, responder],
    "Live Title Model",
    ["low", "high"],
  );
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: modelSource,
    settingsSource: {
      get: async () => ({ automaticConversationSummary: true }),
    },
    toolSource: new AgentToolRegistry(),
    resourceSource: new AgentResourceRegistry(),
  });
  await runtime.initialize();
  context.after(async () => {
    releaseMain();
    await runtime.dispose();
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const reference = await runtime.startSession({
    initialMessage: { text: "生成一个需要较长时间回答的问题。" },
    mode: "chat",
    model: { connectionId: "test", modelId: "live-title-model", reasoningLevel: "high" },
  });
  const running = await waitForInvocationSessionTitle(runtime, reference.invocationId);
  assert.equal(running.state, "running");
  assert.equal(running.sessionTitle, "运行中标题");
  assert.equal((await runtime.getSession(reference.sessionId)).title, "运行中标题");

  releaseMain();
  const completed = await waitForInvocation(runtime, reference.invocationId);
  assert.equal(completed.state, "completed");
  assert.equal(completed.sessionTitle, "运行中标题");
});

await test("Agent 工作区立即应用运行快照携带的 Session 标题", () => {
  const previousSessions = agentWorkspace.persistedSessions.value;
  try {
    agentWorkspace.persistedSessions.value = [
      {
        id: "live-title-session",
        title: "新对话",
        model: { connectionId: "test", modelId: "live-title-model" },
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    ];
    agentWorkspace.applySessionTitle("live-title-session", "运行中标题");
    assert.equal(agentWorkspace.conversations.value[0]?.title, "运行中标题");
  } finally {
    agentWorkspace.persistedSessions.value = previousSessions;
  }
});

await test("关闭自动总结时只执行主模型调用并保留新对话标题", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-auto-title-off-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const { modelSource, calls } = createScriptedModelSource("title-off-model", [
    fauxAssistantMessage("主回答"),
  ]);
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: modelSource,
    settingsSource: {
      get: async () => ({ automaticConversationSummary: false }),
    },
    toolSource: new AgentToolRegistry(),
    resourceSource: new AgentResourceRegistry(),
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());
  const reference = await runtime.startSession({
    initialMessage: { text: "不需要自动标题。" },
    mode: "chat",
  });
  await waitForInvocation(runtime, reference.invocationId);
  assert.equal(calls.length, 1);
  assert.equal((await runtime.getSession(reference.sessionId)).title, "新对话");
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
await test("Agent Session Journal 原子升级第一版消息记录", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-session-v1-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const sessionsRoot = join(userDataRoot, "agent", "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const timestamp = "2026-08-23T10:00:00.000Z";
  const storageKey = "v1-session";
  const titleSlot = Buffer.alloc(256, 0x20);
  Buffer.from(
    JSON.stringify({ type: "title", v: 1, title: "第一版对话", updatedAt: timestamp }),
    "utf8",
  ).copy(titleSlot);
  titleSlot[255] = 0x0a;
  const records = [
    {
      type: "session",
      version: 1,
      id: "session-v1",
      timestamp,
      title: "第一版对话",
      model: { connectionId: "openai", modelId: "gpt-v1" },
    },
    {
      type: "message",
      id: "message-v1",
      invocationId: "invocation-v1",
      role: "assistant",
      content: "旧消息继续可读",
      timestamp,
    },
    {
      type: "invocation",
      id: "invocation-v1",
      state: "completed",
      model: { connectionId: "openai", modelId: "gpt-v1" },
      text: "旧消息继续可读",
      contextTokens: 42,
      timestamp,
    },
  ];
  const journalPath = join(sessionsRoot, `${storageKey}.jsonl`);
  await writeFile(
    journalPath,
    Buffer.concat([
      titleSlot,
      Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8"),
    ]),
  );

  const journal = new AgentSessionJournal(userDataRoot);
  await journal.initialize();
  await journal.initialize();
  const migrated = await readFile(journalPath);
  assert.equal(migrated.subarray(0, 256).equals(titleSlot), true);
  const migratedRecords = migrated
    .subarray(256)
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(migratedRecords[0]?.version, 2);
  assert.deepEqual(migratedRecords[1]?.contentBlocks, [{ type: "text", text: "旧消息继续可读" }]);
  const snapshot = await journal.snapshot("session-v1");
  assert.equal(snapshot.title, "第一版对话");
  assert.equal(snapshot.contextTokens, 42);
  assert.deepEqual(snapshot.messages[0]?.contentBlocks, [{ type: "text", text: "旧消息继续可读" }]);
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
  const richBlocks = [
    { type: "reasoning" as const, text: "先检查分支资料" },
    { type: "text" as const, text: "assistant answer" },
    { type: "tool-call" as const, toolCallId: "tool-call-source" },
  ];
  const provider = {
    api: "openai-responses",
    provider: "openai",
    requestedModel: "gpt-copy",
    responseModel: "gpt-copy-2026-08-01",
    responseId: "response-copy",
    stopReason: "toolUse",
    rawStopReason: "completed",
    diagnostics: [{ route: "official" }],
  };
  const usage = {
    input: 120,
    output: 40,
    cacheRead: 20,
    cacheWrite: 5,
    cacheWrite1h: 2,
    reasoning: 12,
    totalTokens: 185,
    cost: {
      input: 0.001,
      output: 0.002,
      cacheRead: 0.0001,
      cacheWrite: 0.0002,
      total: 0.0033,
    },
  };
  await journal.appendInvocation(source.header.id, {
    id: "invocation-source",
    state: "completed",
    model: { connectionId: "openai", modelId: "gpt-copy" },
    text: "assistant answer",
    contentBlocks: richBlocks,
    provider,
    usage,
    contextTokens: 185,
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
    contentBlocks: richBlocks,
    provider,
    usage,
    providerContent: [
      {
        type: "thinking",
        thinking: "先检查分支资料",
        thinkingSignature: "private-thinking-signature",
      },
      {
        type: "text",
        text: "assistant answer",
        textSignature: "private-text-signature",
      },
      {
        type: "toolCall",
        id: "tool-call-source",
        name: "read",
        arguments: { path: "local://notes/branch.txt", input: {} },
        thoughtSignature: "private-tool-signature",
      },
    ],
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
  const copiedAssistant = copiedLoaded.messages[1];
  assert.deepEqual(copiedAssistant?.provider, provider);
  assert.deepEqual(copiedAssistant?.usage, usage);
  assert.equal(
    copiedAssistant?.contentBlocks.find((block) => block.type === "tool-call")?.toolCallId,
    copiedLoaded.toolCalls[0]?.id,
  );
  assert.equal(
    copiedAssistant?.providerContent?.find((block) => block.type === "toolCall")?.id,
    copiedLoaded.toolCalls[0]?.id,
  );
  assert.equal(
    copiedAssistant?.providerContent?.find((block) => block.type === "thinking")?.thinkingSignature,
    "private-thinking-signature",
  );
  assert.equal(
    copiedLoaded.invocations[0]?.contentBlocks?.find((block) => block.type === "tool-call")
      ?.toolCallId,
    copiedLoaded.toolCalls[0]?.id,
  );
  const publicSnapshotSource = JSON.stringify(await journal.snapshot(source.header.id));
  assert.doesNotMatch(
    publicSnapshotSource,
    /providerContent|private-(thinking|text|tool)-signature/u,
  );
  assert.match(publicSnapshotSource, /"reasoning":12/u);
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

  const { modelSource } = createScriptedModelSource("local-presentation", [
    fauxAssistantMessage(
      fauxToolCall("read", { path: "local://", input: {} }, { id: "local-read-1" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("会话目录为空。"),
    fauxAssistantMessage(
      fauxToolCall(
        "read",
        {
          path: "local://111.txt",
          input: {
            ranges: [
              { start: 1, length: 10 },
              { start: 500, length: 11 },
              { start: 700, length: 1 },
            ],
          },
        },
        { id: "local-read-2" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("已读取多个范围。"),
  ]);
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
  assert.ok((invocation.contextTokens ?? 0) > 0);
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
  assert.equal(persistedSession.contextTokens, fileInvocation.contextTokens);
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

  const { modelSource, calls } = createScriptedModelSource(
    "resource-model",
    [
      fauxAssistantMessage(
        fauxToolCall(
          "read",
          { path: "server://instances", input: { offset: 2, limit: 1 } },
          { id: "resource-read-1" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("读取到了第二个服务器。"),
    ],
    "Resource Model",
  );
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
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[0]?.context.tools?.map(({ name }) => name),
    ["ask", "todo", "read"],
  );
  const readToolMetadata = JSON.stringify(calls[0]?.context.tools);
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

  const { modelSource } = createScriptedModelSource("presenter-failure-model", [
    fauxAssistantMessage(
      fauxToolCall(
        "read",
        { path: "test://presenter-failure", input: {} },
        { id: "presenter-failure-1" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("读取完成。"),
  ]);
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

  const { modelSource, calls } = createScriptedModelSource(
    "tool-model",
    [
      fauxAssistantMessage(
        [
          fauxThinking("规划第一步"),
          fauxText("先检查。"),
          fauxToolCall("test_echo", { value: "probe" }, { id: "echo-1" }),
          fauxText("继续检查。"),
          fauxToolCall("test_echo", { value: "next" }, { id: "echo-2" }),
          fauxText("检查完成。"),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("回显完成。"),
    ],
    "Tool Model",
  );
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
  assert.equal(invocation.text, "先检查。继续检查。检查完成。回显完成。");
  assert.deepEqual(executions, [{ value: "probe" }, { value: "next" }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[0]?.context.tools?.map(({ name }) => name),
    ["ask", "todo", "read", "test_echo"],
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
      { kind: "text", content: "检查完成。回显完成。" },
    ],
  );

  const session = await runtime.getSession(reference.sessionId);
  assert.deepEqual(session.toolCalls, invocation.toolCalls);
  assert.deepEqual(
    session.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "连续回显两次。" },
      { role: "assistant", content: "先检查。继续检查。检查完成。" },
      { role: "assistant", content: "回显完成。" },
    ],
  );
  assert.deepEqual(session.messages[1]?.contentBlocks, [
    { type: "reasoning", text: "规划第一步" },
    { type: "text", text: "先检查。" },
    { type: "tool-call", toolCallId: "echo-1" },
    { type: "text", text: "继续检查。" },
    { type: "tool-call", toolCallId: "echo-2" },
    { type: "text", text: "检查完成。" },
  ]);
  assert.equal(session.messages[1]?.provider?.provider, "test");
  assert.ok((session.messages[1]?.usage?.totalTokens ?? 0) > 0);
});

await test("Agent Ask 支持预设选项与固定自定义回答", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-ask-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const { modelSource } = createScriptedModelSource("ask-model", [
    fauxAssistantMessage(
      fauxToolCall(
        "ask",
        {
          question: "选择服务器环境",
          options: ["开发环境", "生产环境"],
        },
        { id: "ask-option" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("已采用预设环境。"),
    fauxAssistantMessage(
      fauxToolCall(
        "ask",
        {
          question: "填写环境名称",
          options: ["本地", "远程"],
        },
        { id: "ask-custom" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("已采用自定义环境。"),
  ]);
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: modelSource,
    toolSource: new AgentToolRegistry(),
    resourceSource: new AgentResourceRegistry(),
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());

  const optionReference = await runtime.startSession({
    initialMessage: { text: "询问环境。" },
    mode: "agent",
  });
  const optionInteraction = await waitForInvocationInteraction(
    runtime,
    optionReference.invocationId,
  );
  assert.equal(optionInteraction.interaction?.type, "ask");
  assert.deepEqual(
    optionInteraction.interaction?.type === "ask"
      ? {
          question: optionInteraction.interaction.question,
          options: optionInteraction.interaction.options,
        }
      : undefined,
    {
      question: "选择服务器环境",
      options: ["开发环境", "生产环境"],
    },
  );
  await runtime.respondToInteraction({
    invocationId: optionReference.invocationId,
    response: {
      interactionId: optionInteraction.interaction!.id,
      type: "ask-option",
      optionIndex: 1,
    },
  });
  const optionInvocation = await waitForInvocation(runtime, optionReference.invocationId);
  assert.equal(optionInvocation.interaction, undefined);
  assert.deepEqual(optionInvocation.toolCalls[0]?.output, {
    answer: "生产环境",
    source: "option",
  });

  const customReference = await runtime.sendMessage({
    sessionId: optionReference.sessionId,
    message: { text: "再询问一次。" },
    mode: "agent",
  });
  const customInteraction = await waitForInvocationInteraction(
    runtime,
    customReference.invocationId,
  );
  await runtime.respondToInteraction({
    invocationId: customReference.invocationId,
    response: {
      interactionId: customInteraction.interaction!.id,
      type: "ask-custom",
      value: "灰度环境",
    },
  });
  const customInvocation = await waitForInvocation(runtime, customReference.invocationId);
  assert.deepEqual(customInvocation.toolCalls[0]?.output, {
    answer: "灰度环境",
    source: "custom",
  });
});

await test("Agent TODO 原子替换任务清单并投影当前进度", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-todo-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const { modelSource } = createScriptedModelSource("todo-model", [
    fauxAssistantMessage(
      fauxToolCall(
        "todo",
        {
          items: [
            { content: "梳理契约", status: "in_progress" },
            { content: "实现界面", status: "pending" },
            { content: "运行验证", status: "pending" },
          ],
        },
        { id: "todo-initial" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall(
        "todo",
        {
          items: [
            { content: "梳理契约", status: "completed" },
            { content: "实现界面", status: "in_progress" },
            { content: "运行验证", status: "pending" },
          ],
        },
        { id: "todo-progress" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("任务继续执行。"),
    fauxAssistantMessage(
      fauxToolCall(
        "todo",
        {
          items: [
            { content: "重复当前任务", status: "in_progress" },
            { content: "第二个当前任务", status: "in_progress" },
          ],
        },
        { id: "todo-invalid" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("无效清单已拒绝。"),
  ]);
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: modelSource,
    toolSource: new AgentToolRegistry(),
    resourceSource: new AgentResourceRegistry(),
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());

  const reference = await runtime.startSession({
    initialMessage: { text: "按计划执行任务。" },
    mode: "agent",
  });
  const invocation = await waitForInvocation(runtime, reference.invocationId);
  assert.deepEqual(invocation.todo?.items, [
    { content: "梳理契约", status: "completed" },
    { content: "实现界面", status: "in_progress" },
    { content: "运行验证", status: "pending" },
  ]);
  assert.ok(invocation.todo?.updatedAt);
  assert.deepEqual(
    invocation.toolCalls.map(({ presentation, output }) => ({
      title: presentation.title,
      output,
    })),
    [
      {
        title: "更新 TODO",
        output: { completed: 0, total: 3, current: "梳理契约" },
      },
      {
        title: "更新 TODO",
        output: { completed: 1, total: 3, current: "实现界面" },
      },
    ],
  );
  const completedSession = await runtime.getSession(reference.sessionId);
  assert.deepEqual(completedSession.todo?.items, invocation.todo?.items);
  assert.ok(completedSession.todo?.updatedAt);

  const reloadedJournal = new AgentSessionJournal(userDataRoot);
  await reloadedJournal.initialize();
  const reloadedSession = await reloadedJournal.snapshot(reference.sessionId);
  assert.deepEqual(reloadedSession.todo, completedSession.todo);

  const invalidReference = await runtime.startSession({
    initialMessage: { text: "提交无效清单。" },
    mode: "agent",
  });
  const invalidInvocation = await waitForInvocation(runtime, invalidReference.invocationId);
  assert.equal(invalidInvocation.todo, undefined);
  assert.equal(invalidInvocation.toolCalls[0]?.state, "failed");
  assert.match(invalidInvocation.toolCalls[0]?.error ?? "", /同时只能有一个 in_progress 任务/u);
});

await test("Agent 三档权限按工具确认级别裁决执行", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-confirmations-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const { modelSource } = createScriptedModelSource("confirmation-model", [
    fauxAssistantMessage(
      fauxToolCall("test_level0", { request: "default" }, { id: "level0-default" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("零级完成。"),
    fauxAssistantMessage(fauxToolCall("test_level1", { request: "deny" }, { id: "level1-deny" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("一级拒绝已处理。"),
    fauxAssistantMessage(
      fauxToolCall("test_level1", { request: "approve" }, { id: "level1-approve" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("一级允许已处理。"),
    fauxAssistantMessage(fauxToolCall("test_level1", { request: "edit" }, { id: "level1-edit" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("编辑模式一级完成。"),
    fauxAssistantMessage(fauxToolCall("test_level2", { request: "edit" }, { id: "level2-edit" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("编辑模式二级完成。"),
    fauxAssistantMessage(fauxToolCall("test_level2", { request: "yolo" }, { id: "level2-yolo" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("YOLO 二级完成。"),
  ]);
  const tools = new AgentToolRegistry();
  const executions: string[] = [];
  const registerTool = (name: string, confirmationLevel?: 1 | 2): void => {
    tools.register(
      `test.${name}`,
      { type: "global", id: "global" },
      {
        namespace: "test",
        name,
        title: `权限工具 ${name}`,
        description: "记录权限裁决后的执行。",
        ...(confirmationLevel === undefined ? {} : { confirmationLevel }),
        inputSchema: {
          type: "object",
          properties: { request: { type: "string" } },
          required: ["request"],
          additionalProperties: false,
        },
      },
      async (input) => {
        assert.equal(typeof input, "object");
        const request = (input as { request: string }).request;
        executions.push(`${name}:${request}`);
        return { request };
      },
    );
  };
  registerTool("level0");
  registerTool("level1", 1);
  registerTool("level2", 2);
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: modelSource,
    toolSource: tools,
    resourceSource: new AgentResourceRegistry(),
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());

  const level0 = await runtime.startSession({
    initialMessage: { text: "执行零级。" },
    mode: "agent",
  });
  const level0Invocation = await waitForInvocation(runtime, level0.invocationId);
  assert.equal(level0Invocation.interaction, undefined);
  assert.deepEqual(executions, ["level0:default"]);

  const denied = await runtime.startSession({
    initialMessage: { text: "只读模式拒绝一级。" },
    mode: "agent",
    permissionMode: "read-only",
  });
  const deniedInteraction = await waitForInvocationInteraction(runtime, denied.invocationId);
  assert.equal(
    deniedInteraction.interaction?.type === "tool-confirmation"
      ? deniedInteraction.interaction.confirmationLevel
      : undefined,
    1,
  );
  await runtime.respondToInteraction({
    invocationId: denied.invocationId,
    response: {
      interactionId: deniedInteraction.interaction!.id,
      type: "tool-confirmation",
      approved: false,
    },
  });
  const deniedInvocation = await waitForInvocation(runtime, denied.invocationId);
  assert.equal(deniedInvocation.toolCalls[0]?.state, "failed");
  assert.match(deniedInvocation.toolCalls[0]?.error ?? "", /用户拒绝执行工具/u);
  assert.deepEqual(executions, ["level0:default"]);

  const approved = await runtime.startSession({
    initialMessage: { text: "只读模式允许一级。" },
    mode: "agent",
    permissionMode: "read-only",
  });
  const approvedInteraction = await waitForInvocationInteraction(runtime, approved.invocationId);
  await runtime.respondToInteraction({
    invocationId: approved.invocationId,
    response: {
      interactionId: approvedInteraction.interaction!.id,
      type: "tool-confirmation",
      approved: true,
    },
  });
  await waitForInvocation(runtime, approved.invocationId);
  assert.deepEqual(executions, ["level0:default", "level1:approve"]);

  const editLevel1 = await runtime.startSession({
    initialMessage: { text: "编辑模式执行一级。" },
    mode: "agent",
    permissionMode: "edit",
  });
  const editLevel1Invocation = await waitForInvocation(runtime, editLevel1.invocationId);
  assert.equal(editLevel1Invocation.interaction, undefined);
  assert.deepEqual(executions, ["level0:default", "level1:approve", "level1:edit"]);

  const editLevel2 = await runtime.startSession({
    initialMessage: { text: "编辑模式确认二级。" },
    mode: "agent",
    permissionMode: "edit",
  });
  const editLevel2Interaction = await waitForInvocationInteraction(
    runtime,
    editLevel2.invocationId,
  );
  assert.equal(
    editLevel2Interaction.interaction?.type === "tool-confirmation"
      ? editLevel2Interaction.interaction.confirmationLevel
      : undefined,
    2,
  );
  await runtime.respondToInteraction({
    invocationId: editLevel2.invocationId,
    response: {
      interactionId: editLevel2Interaction.interaction!.id,
      type: "tool-confirmation",
      approved: true,
    },
  });
  await waitForInvocation(runtime, editLevel2.invocationId);

  const yoloLevel2 = await runtime.startSession({
    initialMessage: { text: "YOLO 模式执行二级。" },
    mode: "agent",
    permissionMode: "yolo",
  });
  const yoloLevel2Invocation = await waitForInvocation(runtime, yoloLevel2.invocationId);
  assert.equal(yoloLevel2Invocation.interaction, undefined);
  assert.deepEqual(executions, [
    "level0:default",
    "level1:approve",
    "level1:edit",
    "level2:edit",
    "level2:yolo",
  ]);
});

await test("取消多工具批次后不再分派剩余工具", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-cancel-tool-batch-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const { modelSource } = createScriptedModelSource("cancel-tool-model", [
    fauxAssistantMessage(
      [
        fauxToolCall("test_cancel", { order: "first" }, { id: "cancel-tool-1" }),
        fauxToolCall("test_cancel", { order: "second" }, { id: "cancel-tool-2" }),
      ],
      { stopReason: "toolUse" },
    ),
  ]);
  let notifyFirstToolStarted!: () => void;
  const firstToolStarted = new Promise<void>((resolve) => {
    notifyFirstToolStarted = resolve;
  });
  const executions: JsonValue[] = [];
  const tools = new AgentToolRegistry();
  tools.register(
    "test.cancel-tool-batch",
    { type: "global", id: "global" },
    {
      namespace: "test",
      name: "cancel",
      title: "取消批次",
      description: "验证取消后不会继续执行同一批次中的后续工具。",
      inputSchema: {
        type: "object",
        properties: { order: { type: "string" } },
        required: ["order"],
        additionalProperties: false,
      },
    },
    async (input, { signal }) => {
      if (!signal) throw new Error("Agent 工具调用必须提供取消信号");
      executions.push(input);
      if (executions.length === 1) {
        notifyFirstToolStarted();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return input;
    },
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
    initialMessage: { text: "依次调用两个工具。" },
    mode: "agent",
  });
  await firstToolStarted;
  await runtime.cancelInvocation(reference.invocationId);
  const invocation = await waitForInvocation(runtime, reference.invocationId);
  assert.equal(invocation.state, "cancelled");
  assert.deepEqual(executions, [{ order: "first" }]);
  assert.equal(invocation.toolCalls.length, 1);
  assert.equal(invocation.toolCalls[0]?.id, "cancel-tool-1");
  assert.equal(invocation.toolCalls[0]?.state, "cancelled");
});

await test("失败响应不覆盖最近成功的上下文占用", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-context-fallback-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const { modelSource } = createScriptedModelSource("context-fallback-model", [
    fauxAssistantMessage("成功响应。"),
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "fixture provider failure",
    }),
  ]);
  const reported: unknown[] = [];
  const runtime = new AgentRuntime({
    userDataRoot,
    modelCatalog: modelSource,
    toolSource: new AgentToolRegistry(),
    resourceSource: new AgentResourceRegistry(),
    reportError: (error) => reported.push(error),
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());

  const firstReference = await runtime.startSession({
    initialMessage: { text: "建立成功的上下文统计。" },
    mode: "chat",
  });
  const firstInvocation = await waitForInvocation(runtime, firstReference.invocationId);
  assert.equal(firstInvocation.state, "completed");
  assert.ok((firstInvocation.contextTokens ?? 0) > 0);

  const failedReference = await runtime.sendMessage({
    sessionId: firstReference.sessionId,
    message: { text: "触发供应商失败。" },
    mode: "chat",
  });
  const failedInvocation = await waitForInvocation(runtime, failedReference.invocationId);
  assert.equal(failedInvocation.state, "failed");
  assert.equal(failedInvocation.contextTokens, undefined);
  assert.equal(
    (await runtime.getSession(firstReference.sessionId)).contextTokens,
    firstInvocation.contextTokens,
  );
  assert.equal(reported.length, 1);
});

await test("异常的成功响应 Token 不会破坏 Session Journal", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-invalid-context-usage-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const invalidTotals = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  const faux = fauxProvider({
    api: "test-api",
    provider: "test",
    models: [
      {
        id: "invalid-context-model",
        name: "Invalid Context Model",
        contextWindow: 128_000,
      },
    ],
  });
  const model = faux.getModel();
  let responseIndex = 0;
  const models = {
    streamSimple() {
      const totalTokens = invalidTotals[responseIndex++];
      assert.notEqual(totalTokens, undefined);
      const base = fauxAssistantMessage("响应内容保持可读。");
      const message: AssistantMessage = {
        ...base,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...base.usage, totalTokens },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    },
  } as unknown as Models;
  const modelSource: AgentModelSource = {
    initialize: async () => {},
    list: async () => [
      {
        connectionId: "test",
        modelId: model.id,
        name: model.name,
      },
    ],
    resolve: async () => ({
      selection: { connectionId: "test", modelId: model.id },
      models,
      model,
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

  for (const totalTokens of invalidTotals) {
    const reference = await runtime.startSession({
      initialMessage: { text: `验证异常 Token：${String(totalTokens)}` },
      mode: "chat",
    });
    const invocation = await waitForInvocation(runtime, reference.invocationId);
    assert.equal(invocation.state, "completed");
    assert.equal(invocation.contextTokens, undefined);
    const session = await runtime.getSession(reference.sessionId);
    assert.equal(session.contextTokens, undefined);
    assert.equal(session.messages.at(-1)?.content, "响应内容保持可读。");
  }
});

await test("pi-ai 工具循环继续使用 SeaShard 严格输入校验", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-strict-tool-input-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });
  const { modelSource, calls } = createScriptedModelSource("strict-tool-model", [
    fauxAssistantMessage(
      fauxToolCall("test_echo", { value: "probe", unexpected: true }, { id: "strict-tool-call" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("已识别无效工具参数。"),
  ]);
  let executions = 0;
  const tools = new AgentToolRegistry();
  tools.register(
    "test.strict-tool",
    { type: "global", id: "global" },
    {
      namespace: "test",
      name: "echo",
      title: "严格回显",
      description: "验证工具参数保持 SeaShard 严格校验。",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    async (input) => {
      executions += 1;
      return input;
    },
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
    initialMessage: { text: "调用严格工具。" },
    mode: "agent",
  });
  const invocation = await waitForInvocation(runtime, reference.invocationId);
  assert.equal(invocation.state, "completed");
  assert.equal(invocation.text, "已识别无效工具参数。");
  assert.equal(executions, 0);
  assert.equal(invocation.toolCalls[0]?.state, "failed");
  assert.match(invocation.toolCalls[0]?.error ?? "", /未知字段|additional/u);
  assert.equal(calls.length, 2);
  const followupContext = JSON.stringify(calls[1]?.context);
  assert.match(followupContext, /strict-tool-call/u);
  assert.match(followupContext, /未知字段|additional/u);
});

await test("Agent 工具长输出以前缀和英文 local 指令进入模型上下文", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-bounded-tool-output-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const { modelSource, calls } = createScriptedModelSource("bounded-output", [
    fauxAssistantMessage(fauxToolCall("test_large", {}, { id: "large-1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("长输出已保存。"),
  ]);
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
  assert.match(JSON.stringify(calls[1]?.context), /local:\/\/tool-output\/call-large-1\.txt/u);
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
  assert.deepEqual(
    {
      api: invocation.provider?.api,
      provider: invocation.provider?.provider,
      requestedModel: invocation.provider?.requestedModel,
      responseModel: invocation.provider?.responseModel,
      responseId: invocation.provider?.responseId,
      stopReason: invocation.provider?.stopReason,
      rawStopReason: invocation.provider?.rawStopReason,
    },
    {
      api: "openai-responses",
      provider: "openai",
      requestedModel: "gpt-5.6-sol",
      responseModel: undefined,
      responseId: "response-2",
      stopReason: "stop",
      rawStopReason: "completed",
    },
  );
  assert.deepEqual(
    {
      input: invocation.usage?.input,
      output: invocation.usage?.output,
      cacheRead: invocation.usage?.cacheRead,
      cacheWrite: invocation.usage?.cacheWrite,
      totalTokens: invocation.usage?.totalTokens,
    },
    { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4 },
  );
  const persisted = await runtime.getSession(reference.sessionId);
  assert.deepEqual(
    persisted.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "我有哪些服务器？" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "当前有 1 个服务器。" },
    ],
  );
  assert.equal(persisted.messages[1]?.provider?.responseId, "response-1");
  assert.doesNotMatch(JSON.stringify(persisted), /encrypted-reasoning-context/u);
  const internal = await runtime.journal.get(reference.sessionId);
  assert.match(
    internal.messages[1]?.providerContent?.find((block) => block.type === "thinking")
      ?.thinkingSignature ?? "",
    /encrypted-reasoning-context/u,
  );
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
      status: "completed",
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
      ...response,
      status: "completed",
      output: [],
      incomplete_details: null,
      usage: {
        input_tokens: 1,
        input_tokens_details: null,
        output_tokens: 1,
        output_tokens_details: null,
        total_tokens: 2,
      },
      reasoning: null,
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
      item: {
        type: "message",
        id: "message-1",
        phase: "final_answer",
        status: "completed",
        content: [{ type: "output_text", text: "当前有 1 个服务器。", annotations: [] }],
      },
    },
    completed,
  ];
}

async function waitForInvocationInteraction(
  runtime: AgentRuntime,
  invocationId: string,
): Promise<Awaited<ReturnType<AgentRuntime["getInvocation"]>>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const invocation = await runtime.getInvocation(invocationId);
    if (invocation.interaction) return invocation;
    if (invocation.state !== "running") {
      throw new Error("Agent Invocation finished before requesting interaction");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Agent Invocation did not request interaction");
}
async function waitForInvocationSessionTitle(
  runtime: AgentRuntime,
  invocationId: string,
): Promise<Awaited<ReturnType<AgentRuntime["getInvocation"]>>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const invocation = await runtime.getInvocation(invocationId);
    if (invocation.sessionTitle) return invocation;
    if (invocation.state !== "running") {
      throw new Error("Agent Invocation finished before publishing its Session title");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Agent Invocation did not publish its Session title");
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
