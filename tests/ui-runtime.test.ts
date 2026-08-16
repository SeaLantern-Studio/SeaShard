import assert from "node:assert/strict";
import test from "node:test";
import { projectClientEntryPublication } from "../packages/plugin-system/src/client-projection.ts";
import type { ResolvedClientEntrySnapshot } from "../packages/plugin-system/src/types.ts";
import type { ClientUiModule } from "../packages/ui-sdk/src/index.ts";
import { ClientUiRuntime } from "../packages/ui-runtime/src/index.ts";
import type { ClientEntryDescriptor } from "../packages/contracts/src/index.ts";
import { defineComponent } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

const pageComponent = defineComponent({
  name: "TestPage",
  render: () => null,
});

function descriptor(
  runtimeId: string,
  moduleKey: string,
  integrity = "a".repeat(64),
): ClientEntryDescriptor {
  return {
    runtimeId,
    pluginId: `plugin.${runtimeId}`,
    pluginVersion: "1.0.0",
    entryId: "client",
    moduleKey,
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
        placement: "bottom",
      });
    },
  };
  const runtime = new ClientUiRuntime({
    router,
    loaders: { test: { load: async () => ({ default: module }) } },
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
  assert.equal(runtime.pages.value[0]?.placement, "bottom");
  assert.equal(router.hasRoute("ui:test.runtime:test-page"), true);

  await runtime.reconcile({ revision: 2, entries: [] });
  assert.equal(disposed, 1);
  assert.equal(runtime.pages.value.length, 0);
  assert.equal(router.hasRoute("ui:test.runtime:test-page"), false);
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
    loaders: { healthy: { load: async () => goodModule } },
    services: {},
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
        upgradeMode: "stop-first" as const,
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
  assert.equal(publication.entries[0]?.moduleKey, "example.client-plugin/client");
  assert.equal(JSON.stringify(publication).includes("C:/Users/private"), false);
  assert.equal("rootPath" in (publication.entries[0] ?? {}), false);
});
