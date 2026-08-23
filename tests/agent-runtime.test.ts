import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  AgentModelCatalog,
  AgentRuntime,
  AgentSessionJournal,
  type AgentModelSource,
} from "../components/agent/runtime/src/index.ts";
import { registerServerInstanceAgentResources } from "../components/server/instance-manager/src/index.ts";
import {
  AgentResourceRegistry,
  AgentToolRegistry,
} from "../packages/plugin-system/src/runtime-registries.ts";
import type { JsonValue } from "../packages/plugin-sdk/src/index.ts";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

await test("Agent 模型目录创建 models.yml 并读取 OMP 风格配置", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-models-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(userDataRoot, { recursive: true, force: true });
  });

  const catalog = new AgentModelCatalog({ userDataRoot, environment: {} });
  await catalog.initialize();
  const initial = await readFile(catalog.configPath, "utf8");
  assert.match(initial, /providers: \{\}/);

  await writeFile(
    catalog.configPath,
    [
      "providers:",
      "  local:",
      "    baseUrl: http://127.0.0.1:11434/v1",
      "    auth: none",
      "    api: openai-completions",
      "    models:",
      "      - id: qwen3-coder",
      "        name: Qwen 3 Coder",
      "",
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(await catalog.list(), [
    {
      connectionId: "local",
      modelId: "qwen3-coder",
      name: "Qwen 3 Coder",
      api: "openai-completions",
    },
  ]);
  const resolved = await catalog.resolve({ connectionId: "local", modelId: "qwen3-coder" });
  assert.deepEqual(resolved.selection, { connectionId: "local", modelId: "qwen3-coder" });
  assert.equal(dirname(catalog.configPath), join(userDataRoot, "agent"));
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
      startedAt: "2026-08-23T07:51:50.000Z",
      finishedAt: "2026-08-23T07:51:51.000Z",
    },
  ]);
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
    api: "openai-responses" as const,
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

await test("Agent 模式执行工具闭环并持久化工具活动", async (context) => {
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
    api: "openai-responses" as const,
  };
  const modelSource: AgentModelSource = {
    initialize: async () => {},
    list: async () => [configuredModel],
    resolve: async () => ({
      selection: { connectionId: configuredModel.connectionId, modelId: configuredModel.modelId },
      languageModel: model,
    }),
  };
  let executions = 0;
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
      executions += 1;
      return input;
    },
  );

  const reference = await runtime.startSession({
    initialMessage: { text: "回显 probe。" },
    mode: "agent",
  });
  const invocation = await waitForInvocation(runtime, reference.invocationId);
  assert.equal(invocation.state, "completed");
  assert.equal(invocation.text, "回显完成。");
  assert.equal(executions, 1);
  assert.equal(model.doStreamCalls.length, 2);
  assert.deepEqual(
    model.doStreamCalls[0]?.tools?.map(({ name }) => name),
    ["test_echo"],
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
      startedAt: invocation.toolCalls[0]?.startedAt,
      finishedAt: invocation.toolCalls[0]?.finishedAt,
    },
  ]);

  const session = await runtime.getSession(reference.sessionId);
  assert.deepEqual(session.toolCalls, invocation.toolCalls);
  assert.deepEqual(
    session.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "回显 probe。" },
      { role: "assistant", content: "回显完成。" },
    ],
  );
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

  const catalog = new AgentModelCatalog({ userDataRoot, environment: {} });
  await catalog.initialize();
  await writeFile(
    catalog.configPath,
    [
      "providers:",
      "  test:",
      `    baseUrl: http://127.0.0.1:${address.port}/v1`,
      "    apiKey: test-key",
      "    api: openai-responses",
      "    models:",
      "      - id: gpt-5.6-sol",
      "        name: GPT-5.6 Sol",
      "",
    ].join("\n"),
    "utf8",
  );
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
  });
  const invocation = await waitForInvocation(runtime, reference.invocationId);
  assert.equal(invocation.state, "completed");
  assert.equal(invocation.text, "当前有 1 个服务器。");
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(({ store }) => store),
    [false, false],
  );
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
