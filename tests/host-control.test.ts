import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  connectHostControlClient,
  HostControlRpcError,
  hostControlProtocolVersion,
  readHostControlDescriptor,
  resolveHostControlLocation,
  startHostControlServer,
} from "../packages/host-control/src/index.ts";
import {
  AgentResourceRegistry,
  AgentToolRegistry,
  type PluginKernel,
} from "../packages/plugin-system/src/index.ts";
import { ServerHostAgentExtensionGateway } from "../apps/server/src/host-agent-extension-gateway.ts";
import type { ServerLocalHostConnection } from "../apps/server/src/local-host.ts";
import type {
  AgentResourceDefinition,
  AgentToolDefinition,
} from "../packages/plugin-sdk/src/index.ts";
import { DesktopHostConnections } from "../apps/desktop/src/main/desktop-host-connections.ts";
import {
  findHostPrompt,
  shouldShowHostChrome,
} from "../apps/desktop/src/renderer/host-connections.ts";

await test("Host allows concurrent readers and transfers one write controller", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-host-control-"));
  const writes: string[] = [];
  const server = await startHostControlServer({
    dataRoot,
    seaShardVersion: "1.3.0",
    packageType: "deb",
    handlers: {
      describeServices: () => [{ contract: "test.control", methods: ["getValue", "writeValue"] }],
      async callService(call) {
        if (call.method === "writeValue") {
          const value = call.args[0];
          if (typeof value !== "string") throw new TypeError("writeValue expects a string");
          writes.push(value);
        }
        return call.method === "getValue" ? "visible" : undefined;
      },
      isMutation(call) {
        return call.method === "writeValue";
      },
    },
  });
  const first = await connectHostControlClient({
    dataRoot,
    identity: { sessionId: "desktop-first", label: "Desktop First" },
  });
  const second = await connectHostControlClient({
    dataRoot,
    identity: { sessionId: "desktop-second", label: "Desktop Second" },
  });

  try {
    const firstService = first.service<{
      getValue(): Promise<string>;
      writeValue(value: string): Promise<void>;
    }>("test.control");
    const secondService = second.service<{
      getValue(): Promise<string>;
      writeValue(value: string): Promise<void>;
    }>("test.control");

    assert.equal(first.hasControl, true);
    assert.equal(first.hostVersion, "1.3.0");
    assert.equal(first.hostPackageType, "deb");
    assert.equal(second.hasControl, false);
    assert.deepEqual(await first.describeServices(), [
      { contract: "test.control", methods: ["getValue", "writeValue"] },
    ]);
    assert.equal(await secondService.getValue(), "visible");
    await assert.rejects(
      secondService.writeValue("blocked"),
      (error: unknown) => error instanceof HostControlRpcError && error.code === "CONTROL_REQUIRED",
    );

    const requestedBySecond = await second.requestControl();
    assert.equal(requestedBySecond.pending?.requester.sessionId, second.identity.sessionId);
    await first.confirmControl(requestedBySecond.pending!.requestId);
    assert.equal(second.hasControl, true);
    await secondService.writeValue("second");
    await assert.rejects(
      firstService.writeValue("stale-first"),
      (error: unknown) => error instanceof HostControlRpcError && error.code === "CONTROL_REQUIRED",
    );

    const requestedByFirst = await first.requestControl();
    assert.equal(requestedByFirst.pending?.requester.sessionId, first.identity.sessionId);
    await first.confirmControl(requestedByFirst.pending!.requestId);
    assert.equal(first.hasControl, true);
    await firstService.writeValue("first");
    assert.deepEqual(writes, ["second", "first"]);

    first.dispose();
    await waitFor(() => second.hasControl);
    await secondService.writeValue("reassigned");
    assert.deepEqual(writes, ["second", "first", "reassigned"]);
  } finally {
    first.dispose();
    second.dispose();
    await server.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("Host Agent extensions preserve write control and project into Server Agent", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-host-agent-control-"));
  const toolDefinition: AgentToolDefinition = {
    namespace: "server",
    name: "start",
    title: "启动服务器",
    description: "启动一个已登记的服务器。",
    confirmationLevel: 1,
    inputSchema: {
      type: "object",
      properties: { instanceId: { type: "string" } },
      required: ["instanceId"],
      additionalProperties: false,
    },
  };
  const resourceDefinition: AgentResourceDefinition = {
    pattern: "server://instances",
    description: "读取服务器列表。",
    inputSchema: { type: "object", additionalProperties: false },
    outputDescription: "返回服务器列表。",
    presentation: { title: "读取服务器" },
  };
  const executions: unknown[] = [];
  const server = await startHostControlServer({
    dataRoot,
    handlers: {
      describeServices: () => [],
      async callService() {
        return undefined;
      },
      isMutation: () => false,
      describeAgentExtensions: () => ({
        tools: [{ name: "server_start", definition: toolDefinition }],
        resources: [resourceDefinition],
      }),
      isAgentToolMutation: (name) => name === "server_start",
      executeAgentTool: async ({ name, input }) => {
        executions.push(input);
        return { name, input };
      },
      readAgentResource: async ({ path, input }) => ({
        mimeType: "application/json",
        content: { path, input, instances: [] },
      }),
      presentAgentResourceRequest: async () => [{ label: "范围", value: "全部服务器" }],
      presentAgentResourceResult: async () => [{ value: "0", unit: "个服务器" }],
    },
  });
  const holder = await connectHostControlClient({
    dataRoot,
    identity: { sessionId: "agent-holder", label: "Agent Holder" },
  });
  const reader = await connectHostControlClient({
    dataRoot,
    identity: { sessionId: "agent-reader", label: "Agent Reader" },
  });

  try {
    const directory = await reader.describeAgentExtensions();
    assert.deepEqual(
      directory.tools.map(({ name }) => name),
      ["server_start"],
    );
    assert.deepEqual(
      directory.resources.map(({ pattern }) => pattern),
      ["server://instances"],
    );
    assert.deepEqual(await reader.readAgentResource("server://instances", {}), {
      mimeType: "application/json",
      content: { path: "server://instances", input: {}, instances: [] },
    });
    await assert.rejects(
      reader.executeAgentTool("server_start", { instanceId: "example" }),
      (error: unknown) => error instanceof HostControlRpcError && error.code === "CONTROL_REQUIRED",
    );
    assert.deepEqual(await holder.executeAgentTool("server_start", { instanceId: "example" }), {
      name: "server_start",
      input: { instanceId: "example" },
    });

    const agentTools = new AgentToolRegistry();
    const agentResources = new AgentResourceRegistry();
    const gatewayHost = {
      describeAgentExtensions: () => Promise.resolve(directory),
      executeAgentTool: (name: string, input: unknown) => Promise.resolve({ name, input }),
      readAgentResource: (path: string, input: unknown) =>
        Promise.resolve({
          mimeType: "application/json",
          content: { path, input, instances: [] },
        }),
      presentAgentResourceRequest: () => Promise.resolve([{ label: "范围", value: "全部服务器" }]),
      presentAgentResourceResult: () => Promise.resolve([{ value: "0", unit: "个服务器" }]),
    } as unknown as ServerLocalHostConnection;
    const gateway = await ServerHostAgentExtensionGateway.register(
      { agentTools, agentResources } as unknown as PluginKernel,
      gatewayHost,
    );
    assert.ok(gateway);
    assert.deepEqual(
      agentTools.snapshot().map(({ name }) => name),
      ["server_start"],
    );
    assert.deepEqual(await agentTools.snapshot()[0]!.execute({ instanceId: "gateway" }, {}), {
      name: "server_start",
      input: { instanceId: "gateway" },
    });
    assert.deepEqual(await agentResources.snapshot().read("server://instances", {}), {
      mimeType: "application/json",
      content: { path: "server://instances", input: {}, instances: [] },
    });
    gateway.dispose();
    assert.equal(agentTools.countRuntime(), 0);
    assert.equal(agentResources.countRuntime(), 0);
    const oldHost = {
      describeAgentExtensions: () =>
        Promise.reject(
          new HostControlRpcError("UNSUPPORTED_ACTION", "installed Host does not expose Agent"),
        ),
    } as unknown as ServerLocalHostConnection;
    assert.equal(
      await ServerHostAgentExtensionGateway.register(
        { agentTools, agentResources } as unknown as PluginKernel,
        oldHost,
      ),
      undefined,
    );
    assert.equal(agentTools.countRuntime(), 0);
    assert.equal(agentResources.countRuntime(), 0);
    assert.deepEqual(executions, [{ instanceId: "example" }]);
  } finally {
    holder.dispose();
    reader.dispose();
    await server.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("current Controller accepts old Host descriptors within protocol version one", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-host-old-descriptor-"));
  try {
    const location = await resolveHostControlLocation(dataRoot);
    await writeFile(
      location.descriptorPath,
      `${JSON.stringify({
        protocolVersion: hostControlProtocolVersion,
        socketPath: location.socketPath,
        descriptorPath: location.descriptorPath,
        token: "a".repeat(64),
        pid: 42,
        startedAt: "2026-09-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const descriptor = await readHostControlDescriptor(dataRoot);
    assert.equal(descriptor?.seaShardVersion, undefined);
    assert.equal(descriptor?.packageType, undefined);

    await writeFile(
      location.descriptorPath,
      `${JSON.stringify({ ...descriptor, protocolVersion: hostControlProtocolVersion + 1 })}\n`,
      "utf8",
    );
    await assert.rejects(readHostControlDescriptor(dataRoot), /invalid SeaShard Host descriptor/u);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("Desktop projects Host conflicts as read-only and hides normal local control", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-desktop-host-"));
  const server = await startHostControlServer({
    dataRoot,
    handlers: {
      describeServices: () => [],
      async callService() {
        return undefined;
      },
      isMutation() {
        return false;
      },
    },
  });
  const first = await connectHostControlClient({
    dataRoot,
    identity: { sessionId: "desktop-first", label: "Desktop First" },
  });
  const second = await connectHostControlClient({
    dataRoot,
    identity: { sessionId: "desktop-second", label: "Desktop Second" },
  });
  const connections = new DesktopHostConnections({
    controllerSessionId: second.identity.sessionId,
    initialInstallation: "installed",
    initialClient: second,
    connectLocal: () =>
      connectHostControlClient({
        dataRoot,
        identity: second.identity,
      }),
    readLocalInstallation: async () => "installed",
    installLocal: async () => "external",
  });
  try {
    const occupied = connections.getSnapshot();
    assert.equal(occupied.hosts[0]?.state, "read-only");
    assert.equal(occupied.hosts[0]?.holder?.sessionId, first.identity.sessionId);
    assert.equal(shouldShowHostChrome(occupied), true);
    assert.equal(findHostPrompt(occupied)?.kind, "occupied");

    const acknowledged = connections.acknowledgeConflict("local");
    assert.equal(findHostPrompt(acknowledged), undefined);

    const requested = await connections.requestControl("local");
    assert.equal(findHostPrompt(requested)?.kind, "outgoing");
    const requestId = requested.hosts[0]?.pending?.requestId;
    assert.ok(requestId);
    const rejected = await connections.rejectControl("local", requestId!);
    assert.equal(rejected.hosts[0]?.state, "read-only");
    assert.equal(rejected.hosts[0]?.pending, undefined);
    assert.equal(findHostPrompt(rejected), undefined);

    const requestedAgain = await connections.requestControl("local");
    const nextRequestId = requestedAgain.hosts[0]?.pending?.requestId;
    assert.ok(nextRequestId);
    const controlled = await connections.confirmControl("local", nextRequestId!);
    assert.equal(controlled.hosts[0]?.state, "control");
    assert.equal(shouldShowHostChrome(controlled), false);
    assert.equal(findHostPrompt(controlled), undefined);

    const disconnected = await connections.disconnect("local");
    assert.equal(disconnected.hosts[0]?.state, "disconnected");
    assert.equal(findHostPrompt(disconnected)?.kind, "unavailable");
  } finally {
    connections.dispose();
    first.dispose();
    await server.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("Desktop guides installation without starting a missing Host", async () => {
  let installGuides = 0;
  const connections = new DesktopHostConnections({
    controllerSessionId: "desktop-missing",
    initialInstallation: "missing",
    initialError: "本机尚未安装 SeaShard Host",
    connectLocal: async () => {
      throw new Error("Host must remain stopped");
    },
    readLocalInstallation: async () => "missing",
    installLocal: async () => {
      installGuides += 1;
      return "external";
    },
  });
  try {
    const missing = connections.getSnapshot();
    assert.equal(missing.hosts[0]?.installation, "missing");
    assert.equal(findHostPrompt(missing)?.kind, "missing");

    const guided = await connections.install("local");
    assert.equal(installGuides, 1);
    assert.equal(findHostPrompt(guided), undefined);
  } finally {
    connections.dispose();
  }
});

await test("Desktop keeps a first-launch Host installer failure visible", async () => {
  const connections = new DesktopHostConnections({
    controllerSessionId: "desktop-install-failed",
    initialInstallation: "missing",
    initialError: "本机尚未安装 SeaShard Host",
    connectLocal: async () => {
      throw new Error("Host must remain stopped");
    },
    readLocalInstallation: async () => "missing",
    installLocal: async () => {
      throw new Error("Host Runtime 解包失败");
    },
  });
  try {
    await assert.rejects(connections.install("local"), /Host Runtime 解包失败/u);
    const failed = connections.getSnapshot().hosts[0];
    assert.equal(failed?.state, "error");
    assert.equal(failed?.error, "Host Runtime 解包失败");
  } finally {
    connections.dispose();
  }
});

await test("Desktop reconnects immediately after the bundled Host installer reports ready", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-desktop-host-install-"));
  const server = await startHostControlServer({
    dataRoot,
    handlers: {
      describeServices: () => [],
      async callService() {
        return undefined;
      },
      isMutation() {
        return false;
      },
    },
  });
  const connections = new DesktopHostConnections({
    controllerSessionId: "desktop-installed",
    initialInstallation: "missing",
    initialError: "本机尚未安装 SeaShard Host",
    connectLocal: () =>
      connectHostControlClient({
        dataRoot,
        identity: { sessionId: "desktop-installed", label: "Desktop Installed" },
      }),
    readLocalInstallation: async () => "installed",
    installLocal: async () => "installed",
  });
  try {
    const installed = await connections.install("local");
    assert.equal(installed.hosts[0]?.installation, "installed");
    assert.equal(installed.hosts[0]?.state, "control");
    assert.equal(findHostPrompt(installed), undefined);
  } finally {
    connections.dispose();
    await server.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Host control state did not converge");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
