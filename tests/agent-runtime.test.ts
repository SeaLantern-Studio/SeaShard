import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { AgentModelCatalog, AgentSessionJournal } from "../components/agent/runtime/src/index.ts";

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

  await journal.rename(created.header.id, "服务端规划");
  assert.equal((await journal.snapshot(created.header.id)).title, "服务端规划");
});
