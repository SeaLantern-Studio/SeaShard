import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClientPluginAssetUrl,
  projectClientEntryPublication,
  resolveClientPluginAssetPath,
} from "../packages/plugin-system/src/index.ts";
import type { ResolvedClientEntrySnapshot } from "../packages/plugin-system/src/types.ts";
import type { ClientUiModule } from "../packages/ui-sdk/src/index.ts";
import {
  browserClientPackageModuleLoader,
  ClientUiRuntime,
} from "../packages/ui-runtime/src/index.ts";
import type { ClientEntryDescriptor } from "../packages/contracts/src/index.ts";
import { defineComponent } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

const pageComponent = defineComponent({
  name: "TestPage",
  render: () => null,
});

function descriptor(
  runtimeId: string,
  builtInKey: string,
  integrity = "a".repeat(64),
): ClientEntryDescriptor {
  return {
    runtimeId,
    pluginId: `plugin.${runtimeId}`,
    pluginVersion: "1.0.0",
    entryId: "client",
    module: { source: "builtin", key: builtInKey },
    integrity,
    scopeType: "global",
    scopeId: "global",
    config: null,
  };
}

function memoryRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", name: "root", component: pageComponent }],
  });
}

await test("client UI runtime mounts and retracts a built-in page with its entry lifecycle", async () => {
  const router = memoryRouter();
  let disposed = 0;
  const module: ClientUiModule = {
    apply(ctx) {
      assert.equal(ctx.service<{ value: number }>("test.service").value, 42);
      ctx.effect(() => () => {
        disposed += 1;
      });
      ctx.contribute("navigation.page", {
        id: "test-page",
        path: "/test",
        label: "Test",
        component: pageComponent,
        icon: pageComponent,
        navigation: false,
        placement: "settings",
      });
      ctx.contribute("workspace.sidebar", {
        id: "test-sidebar",
        workspaceId: "test",
        component: pageComponent,
      });
    },
  };
  const runtime = new ClientUiRuntime({
    router,
    builtInLoaders: { test: { load: async () => ({ default: module }) } },
    packageLoader: {
      load: async () => {
        throw new Error("package loader should not run");
      },
    },
    hostServices: {
      call: async () => {
        throw new Error("Host service bridge should not run");
      },
    },
    services: { "test.service": { value: 42 } },
  });

  await runtime.reconcile({ revision: 1, entries: [descriptor("test.runtime", "test")] });
  assert.equal(runtime.ready.value, true);
  assert.deepEqual(
    runtime.pages.value.map((page) => ({ id: page.id, runtimeId: page.runtimeId })),
    [{ id: "test-page", runtimeId: "test.runtime" }],
  );
  assert.equal(runtime.pages.value[0]?.icon, pageComponent);
  assert.equal(runtime.pages.value[0]?.navigation, false);
  assert.equal(runtime.pages.value[0]?.placement, "settings");
  assert.equal(router.hasRoute("ui:test.runtime:test-page"), true);
  assert.deepEqual(
    runtime.workspaceSidebars.value.map((sidebar) => ({
      id: sidebar.id,
      runtimeId: sidebar.runtimeId,
      workspaceId: sidebar.workspaceId,
    })),
    [{ id: "test-sidebar", runtimeId: "test.runtime", workspaceId: "test" }],
  );
  assert.equal(runtime.workspaceSidebars.value[0]?.component, pageComponent);

  await runtime.reconcile({ revision: 2, entries: [] });
  assert.equal(disposed, 1);
  assert.equal(runtime.pages.value.length, 0);
  assert.equal(router.hasRoute("ui:test.runtime:test-page"), false);
  assert.equal(runtime.workspaceSidebars.value.length, 0);
  await runtime.dispose();
});

interface EchoService {
  echo(value: string): Promise<string>;
}
await test("client UI runtime loads an activated package module through its digest URL", async () => {
  const router = memoryRouter();
  const integrity = "c".repeat(64);
  const moduleUrl = createClientPluginAssetUrl(integrity, "./dist/client.js");
  const moduleRequests: Array<{ moduleUrl: string; integrity: string }> = [];
  const serviceRequests: Array<{
    runtimeId: string;
    integrity: string;
    contract: string;
    method: string;
    args: readonly unknown[];
  }> = [];
  let bridgedService: EchoService | undefined;
  let bridgedValue: string | undefined;
  const module: ClientUiModule = {
    async apply(ctx) {
      bridgedService = ctx.service<EchoService>("example.echo");
      bridgedValue = await bridgedService.echo("hello");
      ctx.contribute("navigation.page", {
        id: "package-page",
        path: "/package",
        label: "Package",
        component: pageComponent,
      });
    },
  };
  const runtime = new ClientUiRuntime({
    router,
    builtInLoaders: {},
    packageLoader: {
      load: async (requestedUrl, requestedIntegrity) => {
        moduleRequests.push({ moduleUrl: requestedUrl, integrity: requestedIntegrity });
        return { default: module };
      },
    },
    hostServices: {
      call: async (request) => {
        serviceRequests.push(request);
        const value = request.args[0];
        if (typeof value !== "string") throw new TypeError("echo input must be a string");
        return `echo:${value}`;
      },
    },
    services: {},
  });
  const packageEntry: ClientEntryDescriptor = {
    ...descriptor("package.runtime", "unused", integrity),
    module: { source: "package", url: moduleUrl },
  };

  await runtime.reconcile({ revision: 1, entries: [packageEntry] });

  assert.deepEqual(moduleRequests, [{ moduleUrl, integrity }]);
  assert.equal(bridgedValue, "echo:hello");
  assert.deepEqual(serviceRequests, [
    {
      runtimeId: "package.runtime",
      integrity,
      contract: "example.echo",
      method: "echo",
      args: ["hello"],
    },
  ]);
  assert.deepEqual(
    runtime.pages.value.map((page) => page.id),
    ["package-page"],
  );
  await assert.rejects(
    browserClientPackageModuleLoader.load("https://example.invalid/client.js", integrity),
    /invalid client package module URL/u,
  );
  await runtime.reconcile({ revision: 2, entries: [] });
  assert.ok(bridgedService);
  await assert.rejects(bridgedService.echo("stale"), /client runtime is no longer active/u);
  await runtime.dispose();
});

await test("client UI runtime isolates an unavailable feature entry", async () => {
  const router = memoryRouter();
  const goodModule: ClientUiModule = {
    apply(ctx) {
      ctx.contribute("navigation.page", {
        id: "healthy-page",
        path: "/healthy",
        label: "Healthy",
        component: pageComponent,
      });
    },
  };
  const runtime = new ClientUiRuntime({
    router,
    builtInLoaders: { healthy: { load: async () => goodModule } },
    packageLoader: {
      load: async () => {
        throw new Error("package loader should not run");
      },
    },
    services: {},
    hostServices: {
      call: async () => {
        throw new Error("Host service bridge should not run");
      },
    },
  });

  await runtime.reconcile({
    revision: 1,
    entries: [descriptor("healthy.runtime", "healthy"), descriptor("failed.runtime", "missing")],
  });

  assert.deepEqual(
    runtime.pages.value.map((page) => page.id),
    ["healthy-page"],
  );
  assert.deepEqual(runtime.failures.value, [
    {
      runtimeId: "failed.runtime",
      stage: "activation",
      message: "client module loader is unavailable: missing",
    },
  ]);
  await runtime.dispose();
});

await test("client entry projection excludes Main paths and loader objects", () => {
  const manifest = {
    id: "example.client-plugin",
    version: "1.0.0",
    publisher: "example",
    entries: [
      {
        id: "client",
        runtime: "client" as const,
        module: "./dist/client.js",
        targets: ["desktop" as const],
        activationScopes: ["global" as const],
        permissions: [],
      },
    ],
    compatibility: { seaShard: ">=0.0.0 <1.0.0" },
  };
  const snapshot: ResolvedClientEntrySnapshot = {
    revision: 7,
    entries: [
      {
        package: {
          manifest,
          digest: "b".repeat(64),
          rootPath: "C:/Users/private/plugins/example",
          source: "installed",
          trust: "package-full-trust",
          installedAt: "2026-08-16T00:00:00.000Z",
        },
        entry: manifest.entries[0]!,
        binding: {
          id: "example.client",
          pluginId: manifest.id,
          entryId: "client",
          scopeType: "global",
          scopeId: "global",
          enabled: true,
          config: { theme: "dark" },
        },
        runtimeId: "example.client",
        host: "client",
      },
    ],
  };

  const publication = projectClientEntryPublication(snapshot);
  assert.equal(publication.revision, 7);
  assert.deepEqual(publication.entries[0]?.module, {
    source: "package",
    url: `seashard-plugin://${"b".repeat(64)}/dist/client.js`,
  });
  assert.equal(JSON.stringify(publication).includes("C:/Users/private"), false);
  assert.equal("rootPath" in (publication.entries[0] ?? {}), false);
});

await test("client plugin asset resolver serves only current package files", async () => {
  const root = await mkdtemp(join(tmpdir(), "seashard-client-assets-"));
  const digest = "d".repeat(64);
  const modulePath = join(root, "dist", "client.js");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(modulePath, "export const apply = () => {};\\n");
  const manifest = {
    id: "example.dynamic-client",
    version: "1.0.0",
    publisher: "example",
    entries: [
      {
        id: "client",
        runtime: "client" as const,
        module: "./dist/client.js",
        targets: ["desktop" as const],
        activationScopes: ["global" as const],
        permissions: [],
      },
    ],
    compatibility: { seaShard: ">=0.0.0 <1.0.0" },
  };
  const snapshot: ResolvedClientEntrySnapshot = {
    revision: 1,
    entries: [
      {
        package: {
          manifest,
          digest,
          rootPath: root,
          source: "development",
          trust: "local-full-trust",
          installedAt: "2026-08-26T00:00:00.000Z",
        },
        entry: manifest.entries[0]!,
        binding: {
          id: "dev:example.dynamic-client:client",
          pluginId: manifest.id,
          entryId: "client",
          scopeType: "global",
          scopeId: "global",
          enabled: true,
          config: null,
        },
        runtimeId: "dev:example.dynamic-client:client",
        host: "client",
      },
    ],
  };
  const moduleUrl = createClientPluginAssetUrl(digest, "./dist/client.js");

  try {
    assert.equal(await resolveClientPluginAssetPath(snapshot, moduleUrl), modulePath);
    assert.equal(await resolveClientPluginAssetPath(snapshot, `${moduleUrl}?cache=off`), undefined);
    assert.equal(
      await resolveClientPluginAssetPath(snapshot, `seashard-plugin://${digest}/dist%2Fclient.js`),
      undefined,
    );
    assert.equal(
      await resolveClientPluginAssetPath({ revision: 2, entries: [] }, moduleUrl),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
