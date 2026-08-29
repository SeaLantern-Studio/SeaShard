import {
  registerServerRuntimeAgentIntegration,
  type ServerRuntimeAgentRegistrationOptions,
} from "../components/server/runtime/src/agent-integration.ts";
import type {
  AgentResourceMap,
  AgentToolDefinition,
  AgentToolHandler,
  JsonValue,
  PluginContext,
} from "../packages/plugin-sdk/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { vanillaInstance } from "./server-runtime-fixtures.ts";

await test("server runtime registers isolated Agent resources and correlated tools", async () => {
  let resources: AgentResourceMap = {};
  const tools = new Map<
    string,
    { readonly definition: AgentToolDefinition; readonly execute: AgentToolHandler }
  >();
  const commands: string[] = [];
  const waitTimeouts: number[] = [];
  const consoleLines = [
    createConsoleLine(49, "system", "first retained line"),
    createConsoleLine(50, "input", "> help"),
    createConsoleLine(51, "stdout", "command output"),
    createConsoleLine(52, "stderr", "last retained line"),
  ];
  const options: ServerRuntimeAgentRegistrationOptions = {
    listInstances: async () => [vanillaInstance],
    getRuntime: () => ({
      instanceId: vanillaInstance.id,
      state: "running",
      pid: 4_242,
      startedAt: "2026-08-24T17:09:00.000Z",
    }),
    getLogs: () => consoleLines,
    start: async () => ({
      snapshot: {
        instanceId: vanillaInstance.id,
        state: "running",
        pid: 4_242,
        startedAt: "2026-08-24T17:09:00.000Z",
      },
      startedLogSequence: 53,
    }),
    stop: async () => ({
      snapshot: {
        instanceId: vanillaInstance.id,
        state: "stopping",
        pid: 4_242,
        startedAt: "2026-08-24T17:09:00.000Z",
      },
      stopCommandLogSequence: 54,
    }),
    sendCommand: async (_instanceId, command) => {
      commands.push(command);
      return { accepted: true, commandLogSequence: 55 };
    },
    waitUntilReady: async (_instanceId, waitOptions) => {
      waitTimeouts.push(waitOptions.timeoutMs);
      return {
        snapshot: {
          instanceId: vanillaInstance.id,
          state: "running",
          startedAt: "2026-08-24T17:09:00.000Z",
        },
        readyLogSequence: 56,
        readyAt: "2026-08-24T17:09:08.000Z",
        readyMarker: '[Server thread/INFO]: Done (8.000s)! For help, type "help"',
      };
    },
    waitUntilStopped: async (_instanceId, waitOptions) => {
      waitTimeouts.push(waitOptions.timeoutMs);
      return {
        snapshot: {
          instanceId: vanillaInstance.id,
          state: "stopped",
          startedAt: "2026-08-24T17:09:00.000Z",
          stoppedAt: "2026-08-24T17:10:00.000Z",
          exitCode: 0,
        },
      };
    },
  };
  const context: Pick<PluginContext, "agentResources" | "agentTool"> = {
    agentResources(registered) {
      resources = registered;
    },
    agentTool(definition, execute) {
      const name = `${definition.namespace}_${definition.name}`;
      tools.set(name, { definition, execute });
      return name;
    },
  };

  registerServerRuntimeAgentIntegration(context, options);

  assert.deepEqual(Object.keys(resources).sort(), [
    "server://instances/{instanceId}/logs",
    "server://instances/{instanceId}/runtime",
  ]);
  assert.deepEqual([...tools.keys()].sort(), [
    "server_send-command",
    "server_start",
    "server_stop",
    "server_wait-ready",
    "server_wait-stopped",
  ]);

  const runtimeResource = resources["server://instances/{instanceId}/runtime"]!;
  assert.deepEqual(
    await runtimeResource.implementation.presentRequest?.(createReadRequest("runtime", {})),
    [{ label: "服务器", value: vanillaInstance.name }],
  );
  const runtimeText = await runtimeResource.implementation.read(
    createReadRequest("runtime", {}),
    {},
  );
  assert.equal(runtimeText.mimeType, "text/plain; charset=utf-8");
  assert.equal(
    runtimeText.content,
    [
      "Server name: 1.21.1-vanilla",
      "Instance ID: instance-vanilla",
      "State: running",
      "Accepting commands: yes",
      "Started at: 2026-08-24T17:09:00.000Z",
    ].join("\n"),
  );
  const runtimeJson = await runtimeResource.implementation.read(
    createReadRequest("runtime", { json: true }),
    {},
  );
  assert.deepEqual(runtimeJson.content, {
    instanceId: vanillaInstance.id,
    name: vanillaInstance.name,
    state: "running",
    acceptingCommands: true,
    startedAt: "2026-08-24T17:09:00.000Z",
  });

  const logsResource = resources["server://instances/{instanceId}/logs"]!;
  assert.deepEqual(
    await logsResource.implementation.presentRequest?.(
      createReadRequest("logs", { afterSequence: 49, limit: 2 }),
    ),
    [
      { label: "服务器", value: vanillaInstance.name },
      { label: "上限", value: "2", unit: "行" },
    ],
  );
  const logsText = await logsResource.implementation.read(
    createReadRequest("logs", { afterSequence: 49, limit: 2 }),
    {},
  );
  assert.equal(
    logsText.content,
    [
      "Server name: 1.21.1-vanilla",
      "Instance ID: instance-vanilla",
      "49 earlier lines omitted",
      "50: [2026-08-24 17:09:50][input] > help",
      "51: [2026-08-24 17:09:51][stdout] command output",
      "1 later lines omitted",
    ].join("\n"),
  );
  const logsJson = await logsResource.implementation.read(
    createReadRequest("logs", { afterSequence: 50, limit: 1, json: true }),
    {},
  );
  assert.deepEqual(logsJson.content, {
    instanceId: vanillaInstance.id,
    name: vanillaInstance.name,
    items: [
      {
        sequence: 51,
        stream: "stdout",
        text: "command output",
        timestamp: "2026-08-24T17:09:51.000Z",
        truncated: false,
      },
    ],
    pagination: {
      firstSequence: 51,
      lastSequence: 51,
      earlierLineCount: 50,
      laterLineCount: 1,
    },
  });

  assert.equal(
    await executeTool(tools, "server_start", { instanceId: vanillaInstance.id }),
    [
      "Server name: 1.21.1-vanilla",
      "Instance ID: instance-vanilla",
      "State: running",
      "Started at: 2026-08-24T17:09:00.000Z",
      "Startup log sequence: 53",
    ].join("\n"),
  );
  assert.deepEqual(
    await executeTool(tools, "server_stop", { instanceId: vanillaInstance.id, json: true }),
    {
      instanceId: vanillaInstance.id,
      name: vanillaInstance.name,
      state: "stopping",
      stopCommandLogSequence: 54,
    },
  );
  assert.equal(tools.get("server_wait-ready")?.definition.confirmationLevel, 0);
  assert.equal(tools.get("server_wait-stopped")?.definition.confirmationLevel, 0);
  assert.equal(
    await executeTool(tools, "server_wait-ready", {
      instanceId: vanillaInstance.id,
      timeoutSeconds: 7,
    }),
    [
      "Server name: 1.21.1-vanilla",
      "Instance ID: instance-vanilla",
      "Ready: yes",
      "State: running",
      "Ready at: 2026-08-24T17:09:08.000Z",
      "Ready log sequence: 56",
      'Readiness marker: [Server thread/INFO]: Done (8.000s)! For help, type "help"',
    ].join("\n"),
  );
  assert.deepEqual(
    await executeTool(tools, "server_wait-stopped", {
      instanceId: vanillaInstance.id,
      json: true,
    }),
    {
      instanceId: vanillaInstance.id,
      name: vanillaInstance.name,
      state: "stopped",
      startedAt: "2026-08-24T17:09:00.000Z",
      stoppedAt: "2026-08-24T17:10:00.000Z",
      exitCode: 0,
    },
  );
  assert.equal(
    await executeTool(tools, "server_send-command", {
      instanceId: vanillaInstance.id,
      command: "  list  ",
    }),
    [
      "Server name: 1.21.1-vanilla",
      "Instance ID: instance-vanilla",
      "Command accepted: yes",
      "Command log sequence: 55",
    ].join("\n"),
  );
  assert.deepEqual(commands, ["list"]);
  assert.deepEqual(waitTimeouts, [7_000, 300_000]);
});

function createConsoleLine(
  sequence: number,
  stream: "stdout" | "stderr" | "input" | "system",
  text: string,
) {
  return {
    sequence,
    instanceId: vanillaInstance.id,
    stream,
    text,
    timestamp: `2026-08-24T17:09:${sequence}.000Z`,
  } as const;
}

function createReadRequest(path: "runtime" | "logs", input: JsonValue) {
  return {
    uri: {
      href: `server://instances/${vanillaInstance.id}/${path}`,
      scheme: "server",
      path: `instances/${vanillaInstance.id}/${path}`,
      query: {},
    },
    pathParams: { instanceId: vanillaInstance.id },
    input,
  } as const;
}

async function executeTool(
  tools: ReadonlyMap<string, { readonly execute: AgentToolHandler }>,
  name: string,
  input: JsonValue,
): Promise<JsonValue> {
  const tool = tools.get(name);
  assert.ok(tool, `missing Agent tool ${name}`);
  return tool.execute(input, {});
}
