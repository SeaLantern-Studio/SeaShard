import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ServerConsoleLine,
  ServerInstanceSnapshot,
  ServerRuntimeSnapshot,
} from "../packages/contracts/src/index.ts";
import type {
  ServerWebBootstrapSnapshot,
  ServerWebStateSnapshot,
} from "../packages/server-web-api/src/index.ts";
import { ServerAdministratorAuth } from "../apps/server/src/web/auth.ts";
import { startServerWeb } from "../apps/server/src/web/server.ts";
import type { ServerWebHostSource } from "../apps/server/src/web/state.ts";

const password = "seashard-test-password";

await test("Server Web defaults to loopback and completes administrator setup", async () => {
  const fixture = await createFixture();
  const web = await startServerWeb({
    dataRoot: fixture.dataRoot,
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

await test("Server Web exposes health and protects local lifecycle control", async () => {
  const fixture = await createFixture();
  let shutdownRequested = false;
  const startedAt = "2026-09-02T00:00:00.000Z";
  const token = "a".repeat(64);
  const web = await startServerWeb({
    dataRoot: fixture.dataRoot,
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

await test("Server Web rejects remote listening before TLS and administrator setup", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      startServerWeb({
        dataRoot: fixture.dataRoot,
        publicRoot: fixture.publicRoot,
        host: "0.0.0.0",
        port: 0,
      }),
      /必须配置 TLS/u,
    );
    await assert.rejects(
      startServerWeb({
        dataRoot: fixture.dataRoot,
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
  assert.equal(typeof value.setupRequired, "boolean");
  assert.equal(typeof value.authenticated, "boolean");
  if (value.username !== undefined) assert.equal(typeof value.username, "string");
}

function assertState(value: unknown): asserts value is ServerWebStateSnapshot {
  assert.ok(isRecord(value));
  assert.equal(value.apiVersion, 1);
  assert.ok(isRecord(value.host));
  assert.equal(typeof value.host.connected, "boolean");
  assert.ok(Array.isArray(value.instances));
  assert.ok(Array.isArray(value.tasks));
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
