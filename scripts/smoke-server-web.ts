import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerStandaloneHost } from "../packages/host-installation/src/index";
import { startSeaShardHost, type SeaShardHostRuntime } from "../packages/host-runtime/src/index";
import { queryServerRuntime, stopServerRuntime } from "../apps/server/src/runtime-control";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = await mkdtemp(join(tmpdir(), "seashard-server-web-smoke-"));
const sharedDataRoot = join(fixtureRoot, "shared");
const hostDataRoot = join(fixtureRoot, "host");
const controllerDataRoot = join(fixtureRoot, "server-controller");
const databaseWorkerEntry = join(root, "apps/database-worker/dist/index.js");
const pluginHostEntry = join(root, "apps/plugin-host/dist/index.js");
let host: SeaShardHostRuntime | undefined;
let server: ChildProcess | undefined;
let serverStderr = "";

try {
  await registerStandaloneHost(hostDataRoot, "nsis");
  host = await startSeaShardHost({
    dataRoot: hostDataRoot,
    seaShardVersion: "0.0.0",
    packageType: "nsis",
    databaseWorkerEntry,
    pluginHostEntry,
  });
  server = spawn(
    process.execPath,
    [
      join(root, "apps/server/dist/index.js"),
      "run",
      `--shared-data-root=${sharedDataRoot}`,
      `--data-root=${controllerDataRoot}`,
      `--host-data-root=${hostDataRoot}`,
      "--web-port=0",
    ],
    {
      cwd: root,
      env: { ...process.env, SEASHARD_SERVER_DEVELOPMENT: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  server.stderr?.on("data", (chunk: Buffer) => {
    serverStderr += chunk.toString("utf8");
  });

  const ready = await waitForReady(server);
  const runtimeHealth = await queryServerRuntime(controllerDataRoot);
  assert.equal(runtimeHealth?.status, "ready");
  assert.equal(runtimeHealth?.pid, server.pid);
  const page = await fetch(ready.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SeaShard Server/u);

  const setup = await fetch(`${ready.url}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ready.url },
    body: JSON.stringify({ username: "smoke-admin", password: "seashard-smoke-password" }),
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const state = await fetch(`${ready.url}/api/state`, { headers: { Cookie: cookie } });
  assert.equal(state.status, 200);
  const snapshot: unknown = await state.json();
  assert.ok(isRecord(snapshot));
  assert.ok(isRecord(snapshot.host));
  assert.equal(snapshot.host.connected, true);
  const clientBootstrapResponse = await fetch(`${ready.url}/api/client/bootstrap`, {
    headers: { Cookie: cookie },
  });
  assert.equal(clientBootstrapResponse.status, 200);
  const clientBootstrap: unknown = await clientBootstrapResponse.json();
  assert.ok(isRecord(clientBootstrap));
  assert.ok(Array.isArray(clientBootstrap.entries));
  const requiredClientPlugins = [
    "seashard.agent-conversation-ui",
    "seashard.agent-settings-ui",
    "seashard.agent-settings-provider-ui",
    "seashard.game-settings-ui",
    "seashard.server-download-servercore-ui",
    "seashard.server-overview-ui",
    "seashard.server-saves-ui",
    "seashard.server-mods-ui",
    "seashard.server-instance-settings-ui",
    "seashard.server-console-ui",
    "seashard.server-configuration-ui",
  ];
  const entries = clientBootstrap.entries.filter(isRecord);
  for (const pluginId of requiredClientPlugins) {
    assert.ok(
      entries.some((entry) => entry.pluginId === pluginId),
      `缺少 Client Entry：${pluginId}`,
    );
  }
  for (const pluginId of [
    "seashard.server-plugins-ui",
    "seashard.server-players-ui",
    "seashard.server-files-ui",
  ]) {
    assert.ok(
      entries.every((entry) => entry.pluginId !== pluginId),
      `不应发布 Client Entry：${pluginId}`,
    );
  }
  const agentConversation = requireClientEntry(entries, "seashard.agent-conversation-ui");
  const agentModelConfiguration = await callClientService(
    ready.url,
    cookie,
    agentConversation,
    "seashard.agent-model-configuration",
    "getConfiguration",
  );
  assert.ok(isRecord(agentModelConfiguration));
  assert.ok(Array.isArray(agentModelConfiguration.models));
  assert.deepEqual(
    await callClientService(
      ready.url,
      cookie,
      agentConversation,
      "seashard.agent-session",
      "listSessions",
    ),
    [],
  );
  const agentProviderSettings = requireClientEntry(entries, "seashard.agent-settings-provider-ui");
  const providerConfiguration = await callClientService(
    ready.url,
    cookie,
    agentProviderSettings,
    "seashard.agent-model-configuration",
    "getConfiguration",
  );
  assert.ok(isRecord(providerConfiguration));
  assert.ok(Array.isArray(providerConfiguration.providerTypes));
  const agentSettings = requireClientEntry(entries, "seashard.agent-settings-ui");
  assert.ok(
    isRecord(
      await callClientService(ready.url, cookie, agentSettings, "seashard.agent-settings", "get"),
    ),
  );
  const overview = requireClientEntry(entries, "seashard.server-overview-ui");
  assert.deepEqual(
    await callClientService(
      ready.url,
      cookie,
      overview,
      "seashard.server-instance-manager",
      "list",
    ),
    [],
  );
  const javaSettings = requireClientEntry(entries, "seashard.game-settings-ui");
  assert.ok(
    Array.isArray(
      await callClientService(
        ready.url,
        cookie,
        javaSettings,
        "seashard.java-runtime-manager",
        "scan",
      ),
    ),
  );
  const instanceSettings = requireClientEntry(entries, "seashard.server-instance-settings-ui");
  assert.ok(
    isRecord(
      await callClientService(
        ready.url,
        cookie,
        instanceSettings,
        "seashard.server-settings",
        "get",
      ),
    ),
  );

  assert.equal(await stopServerRuntime(controllerDataRoot), true);
  assert.equal(await waitForExit(server), 0);
  server = undefined;
  console.log(`SEASHARD_SERVER_WEB_SMOKE_OK url=${ready.url}`);
} finally {
  await stopProcess(server);
  await host?.dispose();
  host = undefined;
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function callClientService(
  url: string,
  cookie: string,
  entry: Record<string, unknown>,
  contract: string,
  method: string,
  args: readonly unknown[] = [],
): Promise<unknown> {
  const response = await fetch(`${url}/api/client/services`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: url },
    body: JSON.stringify({
      runtimeId: requireString(entry.runtimeId),
      integrity: requireString(entry.integrity),
      contract,
      method,
      args,
    }),
  });
  const payload = await response.text();
  assert.equal(response.status, 200, `${payload}\n${serverStderr}`);
  const result: unknown = JSON.parse(payload);
  assert.ok(isRecord(result));
  return result.resultUndefined ? undefined : result.result;
}

function requireClientEntry(
  entries: readonly Record<string, unknown>[],
  pluginId: string,
): Record<string, unknown> {
  const entry = entries.find((candidate) => candidate.pluginId === pluginId);
  assert.ok(entry, `缺少 Client Entry：${pluginId}`);
  return entry;
}

function waitForReady(child: ChildProcess): Promise<{ readonly url: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Server Web 启动超时\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15_000);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = /SEASHARD_SERVER_WEB_READY url=(https?:\/\/\S+)/u.exec(stdout);
      if (!match) return;
      cleanup();
      resolve({ url: match[1]! });
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Server Web 在就绪前退出：${code === null ? `signal ${signal}` : `code ${code}`}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.send?.("seashard:quit");
  await Promise.race([
    waitForExit(child),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        child.kill();
        resolve();
      }, 3_000),
    ),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new TypeError("expected a non-empty string");
  return value;
}
