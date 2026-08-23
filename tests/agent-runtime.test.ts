import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { registerServerInstanceAgentTools } from "../components/server/instance-manager/src/index.ts";
import { AgentToolRegistry } from "../packages/plugin-system/src/runtime-registries.ts";
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
              toolCallId: "server-list-1",
              toolName: "server_list",
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
            { type: "text-delta", id: "answer", delta: "当前有 1 个服务器。" },
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
  });
  await runtime.initialize();
  context.after(() => runtime.dispose());
  // Runtime 构造完成后再注册，证明 Invocation 读取的是实时 Registry 快照。
  toolRegistry.register(
    "test.server-manager",
    { type: "global", id: "global" },
    {
      namespace: "server",
      name: "list",
      title: "读取服务器列表",
      description: "读取已登记的服务器实例。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      executions += 1;
      return [{ id: "server-1", name: "Paper" }];
    },
  );

  const reference = await runtime.startSession({
    initialMessage: { text: "我有哪些服务器？" },
    mode: "agent",
  });
  const invocation = await waitForInvocation(runtime, reference.invocationId);
  assert.equal(invocation.state, "completed");
  assert.equal(invocation.text, "当前有 1 个服务器。");
  assert.equal(executions, 1);
  assert.equal(model.doStreamCalls.length, 2);
  assert.deepEqual(invocation.toolCalls, [
    {
      id: "server-list-1",
      invocationId: reference.invocationId,
      toolName: "server_list",
      title: "读取服务器列表",
      state: "completed",
      input: {},
      output: [{ id: "server-1", name: "Paper" }],
      startedAt: invocation.toolCalls[0]?.startedAt,
      finishedAt: invocation.toolCalls[0]?.finishedAt,
    },
  ]);

  const session = await runtime.getSession(reference.sessionId);
  assert.deepEqual(session.toolCalls, invocation.toolCalls);
  assert.deepEqual(
    session.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "我有哪些服务器？" },
      { role: "assistant", content: "当前有 1 个服务器。" },
    ],
  );
});

await test("OpenAI Responses 工具结果会触发第二次上游请求", async (context) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "seashard-agent-responses-loop-"));
  const requests: Array<Record<string, unknown>> = [];
  const expectedToolOutput = [
    {
      id: "server-1",
      name: "Paper",
      storageMode: "managed",
      source: "downloaded",
      modLoader: null,
      serverType: "paper",
      gameVersion: "1.21.1",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T01:00:00.000Z",
    },
  ];
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
  const toolRegistry = new AgentToolRegistry();
  registerServerInstanceAgentTools(
    {
      agentTool(definition, execute) {
        return toolRegistry.register(
          "test.server-instance-manager",
          { type: "global", id: "global" },
          definition,
          execute,
        ).id;
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
    toolSource: toolRegistry,
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
      call_id: "server-list-1",
      name: "server_list",
      arguments: "{}",
    },
  ]);
  assert.equal(continuation[2]?.type, "function_call_output");
  assert.equal(continuation[2]?.call_id, "server-list-1");
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
      call_id: "server-list-1",
      name: "server_list",
      arguments: "{}",
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
