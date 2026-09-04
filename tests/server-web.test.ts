import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SQLiteDatabaseBroker } from "../components/data/database-sqlite/src/index.ts";
import {
  serverCoreIconHost,
  serverCoreIconScheme,
  serverCoreSourceContract,
  serverInstanceIconHost,
  serverInstanceManagerContract,
  type ServerConsoleLine,
  type ServerInstanceSnapshot,
  type ServerRuntimeSnapshot,
} from "../packages/contracts/src/index.ts";
import type {
  ServerWebAppearanceSettings,
  ServerWebAppearanceSnapshot,
  ServerWebBootstrapSnapshot,
  ServerWebStateSnapshot,
} from "../packages/server-web-api/src/index.ts";
import type { PluginKernel } from "../packages/plugin-system/src/index.ts";
import type { ClientUiServiceAdapterContext } from "../packages/ui-runtime/src/index.ts";
import {
  createServerWebServiceAdapters,
  ServerWebEvents,
} from "../apps/server-web/src/client-runtime.ts";
import { ServerAdministratorAuth } from "../apps/server/src/web/auth.ts";
import {
  defaultServerWebAppearanceSettings,
  ServerWebAppearanceStore,
} from "../apps/server/src/web/appearance-store.ts";
import { startServerWeb, type ServerWebAppearanceSource } from "../apps/server/src/web/server.ts";
import type { ServerWebHostSource } from "../apps/server/src/web/state.ts";

const password = "seashard-test-password";
const controllerVersion = "0.7.0-test";

await test("Server Web defaults to loopback and completes administrator setup", async () => {
  const fixture = await createFixture();
  const web = await startServerWeb({
    dataRoot: fixture.dataRoot,
    controllerVersion,
    appearance: createMemoryAppearanceSource(),
    publicRoot: fixture.publicRoot,
    port: 0,
  });
  try {
    assert.equal(web.address.host, "127.0.0.1");
    assert.equal(web.address.secure, false);

    const bootstrap = await fetchJson(web.address.url, "/api/bootstrap");
    assert.equal(bootstrap.response.status, 200);
    assert.deepEqual(bootstrap.value, {
      apiVersion: 1,
      setupRequired: true,
      controllerVersion,
      authenticated: false,
    });

    const unauthenticated = await fetchJson(web.address.url, "/api/state");
    assert.equal(unauthenticated.response.status, 401);

    const setup = await fetchJson(web.address.url, "/api/setup", {
      method: "POST",
      headers: { Origin: web.address.url },
      body: JSON.stringify({ username: " admin ", password }),
    });
    assert.equal(setup.response.status, 201);
    assertBootstrap(setup.value);
    assert.equal(setup.value.authenticated, true);
    assert.equal(setup.value.username, "admin");
    const cookie = requireSessionCookie(setup.response);

    const appearance = await fetchJson(web.address.url, "/api/appearance", {
      headers: { Cookie: cookie },
    });
    assert.equal(appearance.response.status, 200);
    assert.deepEqual(
      (appearance.value as ServerWebAppearanceSnapshot).settings,
      defaultServerWebAppearanceSettings,
    );
    const updatedAppearance = await fetchJson(web.address.url, "/api/appearance", {
      method: "PATCH",
      headers: { Cookie: cookie, Origin: web.address.url },
      body: JSON.stringify({ color: "ocean", theme: "dark" }),
    });
    assert.equal(updatedAppearance.response.status, 200);
    assert.equal((updatedAppearance.value as ServerWebAppearanceSnapshot).settings.color, "ocean");
    assert.equal((updatedAppearance.value as ServerWebAppearanceSnapshot).revision, 1);

    const state = await fetchJson(web.address.url, "/api/state", {
      headers: { Cookie: cookie },
    });
    assert.equal(state.response.status, 200);
    assertState(state.value);
    assert.equal(state.value.host.connected, false);

    const logout = await fetchJson(web.address.url, "/api/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: web.address.url },
      body: "{}",
    });
    assert.equal(logout.response.status, 200);

    const invalidLogin = await fetchJson(web.address.url, "/api/login", {
      method: "POST",
      headers: { Origin: web.address.url },
      body: JSON.stringify({ username: "admin", password: `${password}-wrong` }),
    });
    assert.equal(invalidLogin.response.status, 401);

    const login = await fetchJson(web.address.url, "/api/login", {
      method: "POST",
      headers: { Origin: web.address.url },
      body: JSON.stringify({ username: " admin ", password }),
    });
    assert.equal(login.response.status, 200);
    assertBootstrap(login.value);
    assert.equal(login.value.username, "admin");
  } finally {
    await web.dispose();
    await fixture.dispose();
  }
});

await test("Server Web appearance persists in its dedicated SQLite table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seashard-server-appearance-"));
  const databasePath = join(directory, "seashard.sqlite3");
  const workerEntry = new URL("../apps/database-worker/dist/index.js", import.meta.url);
  let broker: SQLiteDatabaseBroker | undefined;
  try {
    broker = await SQLiteDatabaseBroker.create({ databasePath, workerEntry, readWorkers: 1 });
    let store = await ServerWebAppearanceStore.create(broker);
    const first = await store.update({
      color: "midnight",
      theme: "dark",
      fontSize: 18,
      minimalMode: true,
    });
    assert.equal(first.revision, 1);
    await broker.close();

    broker = await SQLiteDatabaseBroker.create({ databasePath, workerEntry, readWorkers: 1 });
    store = await ServerWebAppearanceStore.create(broker);
    const restored = await store.get();
    assert.equal(restored.settings.color, "midnight");
    assert.equal(restored.settings.theme, "dark");
    assert.equal(restored.settings.fontSize, 18);
    assert.equal(restored.settings.minimalMode, true);
    assert.equal(restored.revision, 1);
  } finally {
    await broker?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("Server Web streams Client Entry enable and disable changes", async () => {
  const fixture = await createFixture();
  const fakeController = createFakeClientEntryController();
  const web = await startServerWeb({
    dataRoot: fixture.dataRoot,
    controllerVersion,
    appearance: createMemoryAppearanceSource(),
    publicRoot: fixture.publicRoot,
    controller: fakeController.controller,
    port: 0,
  });
  const abort = new AbortController();
  try {
    const setup = await fetchJson(web.address.url, "/api/setup", {
      method: "POST",
      headers: { Origin: web.address.url },
      body: JSON.stringify({ username: "operator", password }),
    });
    const cookie = requireSessionCookie(setup.response);
    const stream = await fetch(`${web.address.url}/api/events`, {
      headers: { Cookie: cookie },
      signal: abort.signal,
    });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    assert.match(await readStreamChunk(reader), /event: state/u);

    fakeController.publish(1, true);
    const enabled = await readStreamChunk(reader);
    assert.match(enabled, /event: client-bootstrap/u);
    assert.match(enabled, /"revision":1/u);
    assert.match(enabled, /seashard-plugin\.scheduled-commands/u);

    fakeController.publish(2, false);
    const disabled = await readStreamChunk(reader);
    assert.match(disabled, /event: client-bootstrap/u);
    assert.match(disabled, /"revision":2/u);
    assert.match(disabled, /"entries":\[\]/u);
  } finally {
    abort.abort();
    await web.dispose();
    await fixture.dispose();
  }
});

await test("Server Web exposes health and protects local lifecycle control", async () => {
  const fixture = await createFixture();
  let shutdownRequested = false;
  const startedAt = "2026-09-02T00:00:00.000Z";
  const token = "a".repeat(64);
  const web = await startServerWeb({
    dataRoot: fixture.dataRoot,
    controllerVersion,
    appearance: createMemoryAppearanceSource(),
    publicRoot: fixture.publicRoot,
    port: 0,
    serviceControl: {
      token,
      pid: process.pid,
      startedAt,
      requestShutdown: () => {
        shutdownRequested = true;
      },
    },
  });
  try {
    const health = await fetchJson(web.address.url, "/api/health");
    assert.equal(health.response.status, 200);
    assert.equal((health.value as { status?: unknown }).status, "ready");

    const denied = await fetchJson(web.address.url, "/api/service/status");
    assert.equal(denied.response.status, 401);

    const status = await fetchJson(web.address.url, "/api/service/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(status.response.status, 200);
    assert.equal((status.value as { startedAt?: unknown }).startedAt, startedAt);

    const shutdown = await fetchJson(web.address.url, "/api/service/shutdown", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(shutdown.response.status, 202);
    await waitFor(async () => shutdownRequested);
  } finally {
    await web.dispose();
    await fixture.dispose();
  }
});

await test("Server Web publishes Host state, operations, logs, and reconnect snapshots", async () => {
  const fixture = await createFixture();
  const fakeHost = createFakeHost();
  const web = await startServerWeb({
    dataRoot: fixture.dataRoot,
    controllerVersion,
    appearance: createMemoryAppearanceSource(),
    publicRoot: fixture.publicRoot,
    localHost: fakeHost.source,
    port: 0,
  });
  try {
    const setup = await fetchJson(web.address.url, "/api/setup", {
      method: "POST",
      headers: { Origin: web.address.url },
      body: JSON.stringify({ username: "operator", password }),
    });
    const cookie = requireSessionCookie(setup.response);

    const initial = await fetchJson(web.address.url, "/api/state", {
      headers: { Cookie: cookie },
    });
    assertState(initial.value);
    assert.equal(initial.value.host.connected, true);
    assert.equal(initial.value.instances[0].name, "测试服务器");
    assert.equal(JSON.stringify(initial.value).includes("C:\\private-server"), false);

    const start = await fetchJson(web.address.url, "/api/instances/server-1/start", {
      method: "POST",
      headers: { Cookie: cookie, Origin: web.address.url },
      body: "{}",
    });
    assert.equal(start.response.status, 202);
    await waitFor(async () => {
      const state = await fetchJson(web.address.url, "/api/state", {
        headers: { Cookie: cookie },
      });
      assertState(state.value);
      return state.value.tasks[0]?.state === "succeeded";
    });
    assert.equal(fakeHost.calls.start, 1);

    const command = await fetchJson(web.address.url, "/api/instances/server-1/command", {
      method: "POST",
      headers: { Cookie: cookie, Origin: web.address.url },
      body: JSON.stringify({ command: "list" }),
    });
    assert.equal(command.response.status, 200);
    assert.deepEqual(fakeHost.commands, ["list"]);

    const logs = await fetchJson(web.address.url, "/api/instances/server-1/logs?after=0", {
      headers: { Cookie: cookie },
    });
    assertConsoleHistory(logs.value);
    assert.equal(logs.value.lines[0].text, "ready");

    // 每次 SSE 连接都先下发完整 state；浏览器断线重连不依赖丢失前的增量事件。
    const abort = new AbortController();
    const stream = await fetch(`${web.address.url}/api/events`, {
      headers: { Cookie: cookie },
      signal: abort.signal,
    });
    assert.equal(stream.status, 200);
    const firstChunk = await stream.body!.getReader().read();
    const source = new TextDecoder().decode(firstChunk.value);
    assert.match(source, /event: state/u);
    assert.match(source, /测试服务器/u);
    abort.abort();
  } finally {
    await web.dispose();
    await fixture.dispose();
  }
});

await test("Server Web projects and serves authenticated Host image assets", async () => {
  const fixture = await createFixture();
  const imagePath = join(fixture.dataRoot, "icon.png");
  const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await mkdir(fixture.dataRoot, { recursive: true });
  await writeFile(imagePath, image);
  const sha256 = "b".repeat(64);
  const controller = {
    events: { on: () => () => undefined },
    onClientEntriesChanged: () => () => undefined,
    service: (contract: string) => ({
      resolveIconPath: async (identity: string) => {
        if (contract === serverCoreSourceContract && identity === sha256) return imagePath;
        if (contract === serverInstanceManagerContract && identity === "server:one")
          return imagePath;
        return null;
      },
    }),
  } as unknown as PluginKernel;
  const web = await startServerWeb({
    dataRoot: fixture.dataRoot,
    controllerVersion,
    appearance: createMemoryAppearanceSource(),
    publicRoot: fixture.publicRoot,
    controller,
    port: 0,
  });
  try {
    const unauthenticated = await fetch(
      `${web.address.url}/api/server-assets/core-icons/${sha256}`,
    );
    assert.equal(unauthenticated.status, 401);
    const setup = await fetchJson(web.address.url, "/api/setup", {
      method: "POST",
      headers: { Origin: web.address.url },
      body: JSON.stringify({ username: "operator", password }),
    });
    const cookie = requireSessionCookie(setup.response);

    const core = await fetch(`${web.address.url}/api/server-assets/core-icons/${sha256}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(core.status, 200);
    assert.equal(core.headers.get("content-type"), "image/png");
    assert.equal(core.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(new Uint8Array(await core.arrayBuffer()), image);

    const instance = await fetch(
      `${web.address.url}/api/server-assets/instance-icons/server%3Aone`,
      { method: "HEAD", headers: { Cookie: cookie } },
    );
    assert.equal(instance.status, 200);
    assert.equal(instance.headers.get("cache-control"), "no-cache");
    assert.equal(instance.headers.get("content-length"), String(image.byteLength));

    const invalid = await fetch(`${web.address.url}/api/server-assets/core-icons/not-a-digest`, {
      headers: { Cookie: cookie },
    });
    assert.equal(invalid.status, 404);
  } finally {
    await web.dispose();
    await fixture.dispose();
  }
});

await test("Server Web client adapters translate Host icon URLs and the public instance list", async () => {
  const sha256 = "c".repeat(64);
  const calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  const context = {
    entry: {},
    call: async (method: string, args: readonly unknown[]) => {
      calls.push({ method, args });
      if (method === "listTypes") {
        return [
          {
            id: "paper",
            logoUrl: `${serverCoreIconScheme}://${serverCoreIconHost}/${sha256}`,
          },
        ];
      }
      return [
        {
          id: "server:one",
          iconUrl: `${serverCoreIconScheme}://${serverInstanceIconHost}/server%3Aone`,
        },
      ];
    },
    effect: () => () => undefined,
  } as unknown as ClientUiServiceAdapterContext;
  const adapters = createServerWebServiceAdapters(new ServerWebEvents());
  const coreSource = adapters[serverCoreSourceContract]!(context) as {
    listTypes(): Promise<Array<{ logoUrl: string }>>;
  };
  const instanceManager = adapters[serverInstanceManagerContract]!(context) as {
    list(): Promise<Array<{ iconUrl: string }>>;
  };

  assert.equal(
    (await coreSource.listTypes())[0]!.logoUrl,
    `/api/server-assets/core-icons/${sha256}`,
  );
  assert.equal(
    (await instanceManager.list())[0]!.iconUrl,
    "/api/server-assets/instance-icons/server%3Aone",
  );
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["listTypes", "listForClient"],
  );
});

await test("Server Web rejects remote listening before TLS and administrator setup", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      startServerWeb({
        dataRoot: fixture.dataRoot,
        controllerVersion,
        appearance: createMemoryAppearanceSource(),
        publicRoot: fixture.publicRoot,
        host: "0.0.0.0",
        port: 0,
      }),
      /必须配置 TLS/u,
    );
    await assert.rejects(
      startServerWeb({
        dataRoot: fixture.dataRoot,
        controllerVersion,
        appearance: createMemoryAppearanceSource(),
        publicRoot: fixture.publicRoot,
        host: "0.0.0.0",
        port: 0,
        tls: {
          certificatePath: join(fixture.dataRoot, "missing-cert.pem"),
          keyPath: join(fixture.dataRoot, "missing-key.pem"),
        },
      }),
      /必须先在本机完成管理员设置/u,
    );
  } finally {
    await fixture.dispose();
  }
});

await test("Administrator setup is exclusive and stores a non-plaintext credential", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-server-auth-"));
  try {
    const auth = new ServerAdministratorAuth(dataRoot);
    await auth.setup("administrator", password);
    await assert.rejects(auth.setup("replacement", password), /管理员已经设置/u);
    const record = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(dataRoot, "administrator.json"), "utf8"),
    );
    assert.equal(record.includes(password), false);
    const token = await auth.login("administrator", password);
    assert.equal(auth.authenticate(auth.sessionCookie(token, false))?.username, "administrator");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("Administrator sessions expire and never survive a Server restart", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-server-auth-expiry-"));
  let now = 1_000;
  try {
    const auth = new ServerAdministratorAuth(dataRoot, {
      now: () => now,
      sessionLifetimeMilliseconds: 2_000,
    });
    await auth.setup("administrator", password);
    const token = await auth.login("administrator", password);
    const cookie = auth.sessionCookie(token, true);
    assert.equal(auth.authenticate(cookie)?.username, "administrator");
    assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=2; Secure/u);

    now = 3_000;
    assert.equal(auth.authenticate(cookie), undefined);
    const restartedAuth = new ServerAdministratorAuth(dataRoot);
    assert.equal(restartedAuth.authenticate(cookie), undefined);
    assert.equal(await restartedAuth.login("administrator", password).then(Boolean), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<{
  readonly dataRoot: string;
  readonly publicRoot: string;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "seashard-server-web-"));
  const dataRoot = join(root, "data");
  const publicRoot = join(root, "public");
  await mkdir(publicRoot, { recursive: true });
  await writeFile(join(publicRoot, "index.html"), "<!doctype html><title>SeaShard</title>", "utf8");
  return {
    dataRoot,
    publicRoot,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function createFakeClientEntryController(): {
  readonly controller: PluginKernel;
  publish(revision: number, enabled: boolean): void;
} {
  type ClientEntrySnapshot = ReturnType<PluginKernel["clientEntrySnapshot"]>;
  type ClientEntryListener = Parameters<PluginKernel["onClientEntriesChanged"]>[0];
  const entry = {
    id: "scheduler.client",
    runtime: "client",
    module: "./dist/client.js",
    targets: ["web"],
    activationScopes: ["global"],
    uses: {},
    permissions: [],
  };
  const activeEntry = {
    package: {
      manifest: {
        id: "seashard-plugin.scheduled-commands",
        version: "0.2.2",
        publisher: "seashard-plugin",
        entries: [entry],
        compatibility: { seaShard: ">=0.0.0 <1.0.0", clientProtocol: ">=1 <2" },
      },
      digest: "a".repeat(64),
      rootPath: "builtin:scheduled-commands",
      source: "builtin",
      trust: "builtin",
      installedAt: "2026-09-03T00:00:00.000Z",
    },
    entry,
    binding: {
      id: "test.scheduled-commands.client",
      pluginId: "seashard-plugin.scheduled-commands",
      entryId: entry.id,
      scopeType: "global",
      scopeId: "global",
      enabled: true,
      config: {},
    },
    runtimeId: "test.scheduled-commands.client",
    host: "client",
  };
  let snapshot = { revision: 0, entries: [] } as unknown as ClientEntrySnapshot;
  let listener: ClientEntryListener | undefined;
  return {
    controller: {
      events: { on: () => () => undefined },
      clientEntrySnapshot: () => snapshot,
      onClientEntriesChanged: (nextListener: ClientEntryListener) => {
        listener = nextListener;
        return () => {
          if (listener === nextListener) listener = undefined;
        };
      },
    } as unknown as PluginKernel,
    publish(revision, enabled) {
      snapshot = {
        revision,
        entries: enabled ? [activeEntry] : [],
      } as unknown as ClientEntrySnapshot;
      listener?.(snapshot);
    },
  };
}

async function readStreamChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  assert.equal(chunk.done, false);
  return new TextDecoder().decode(chunk.value);
}

function createFakeHost(): {
  readonly source: ServerWebHostSource;
  readonly calls: { start: number };
  readonly commands: string[];
} {
  const calls = { start: 0 };
  const commands: string[] = [];
  let runtime: ServerRuntimeSnapshot = { instanceId: "server-1", state: "stopped" };
  const instance: ServerInstanceSnapshot = {
    id: "server-1",
    name: "测试服务器",
    rootPath: "C:\\private-server",
    coreJarPath: "C:\\private-server\\server.jar",
    storageMode: "managed",
    source: "downloaded",
    modLoader: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  const lines: readonly ServerConsoleLine[] = [
    {
      sequence: 1,
      instanceId: "server-1",
      stream: "stdout",
      text: "ready",
      timestamp: "2026-09-02T00:00:00.000Z",
    },
  ];
  return {
    calls,
    commands,
    source: {
      snapshot: () => ({
        id: "local",
        hasControl: true,
        connectedControllers: 1,
        revision: 1,
        controllerSessionId: "server-controller",
        hostVersion: "0.0.0",
        packageType: "development",
      }),
      listInstances: async () => [instance],
      getRuntime: async () => runtime,
      start: async () => {
        calls.start += 1;
        runtime = { instanceId: "server-1", state: "starting" };
        return runtime;
      },
      waitUntilStartupSettled: async () => {
        runtime = { instanceId: "server-1", state: "running", pid: 4242 };
        return runtime;
      },
      stop: async () => {
        runtime = { instanceId: "server-1", state: "stopping" };
        return runtime;
      },
      waitUntilStopped: async () => {
        runtime = { instanceId: "server-1", state: "stopped" };
        return runtime;
      },
      restart: async () => {
        runtime = { instanceId: "server-1", state: "running", pid: 4343 };
        return runtime;
      },
      sendCommand: async (_instanceId, command) => {
        commands.push(command);
      },
      getLogs: async () => lines,
      onConsoleLine: () => () => undefined,
      requestControl: async () => undefined,
      confirmControl: async () => undefined,
      rejectControl: async () => undefined,
      releaseControl: async () => undefined,
    },
  };
}

async function fetchJson(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ readonly response: Response; readonly value: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const value: unknown = await response.json();
  return { response, value };
}

function assertBootstrap(value: unknown): asserts value is ServerWebBootstrapSnapshot {
  assert.ok(isRecord(value));
  assert.equal(value.apiVersion, 1);
  assert.equal(typeof value.controllerVersion, "string");
  assert.equal(typeof value.setupRequired, "boolean");
  assert.equal(typeof value.authenticated, "boolean");
  if (value.username !== undefined) assert.equal(typeof value.username, "string");
}

function assertState(value: unknown): asserts value is ServerWebStateSnapshot {
  assert.ok(isRecord(value));
  assert.equal(value.apiVersion, 1);
  assert.ok(isRecord(value.host));
  assert.equal(typeof value.host.connected, "boolean");
  assert.equal(typeof value.host.revision, "number");
  assert.equal(typeof value.host.controllerSessionId, "string");
  assert.ok(Array.isArray(value.instances));
  assert.ok(Array.isArray(value.tasks));
}

function createMemoryAppearanceSource(): ServerWebAppearanceSource {
  let snapshot: ServerWebAppearanceSnapshot = {
    settings: { ...defaultServerWebAppearanceSettings },
    revision: 0,
  };
  return {
    get: async () => snapshot,
    update: async (value) => {
      const patch = value as Partial<ServerWebAppearanceSettings>;
      snapshot = {
        settings: { ...snapshot.settings, ...patch },
        revision: snapshot.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      return snapshot;
    },
    reset: async () => {
      snapshot = {
        settings: { ...defaultServerWebAppearanceSettings },
        revision: snapshot.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      return snapshot;
    },
  };
}

function assertConsoleHistory(
  value: unknown,
): asserts value is { readonly lines: readonly ServerConsoleLine[] } {
  assert.ok(isRecord(value));
  assert.ok(Array.isArray(value.lines));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireSessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie, "response should set a session cookie");
  return cookie;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true");
}
