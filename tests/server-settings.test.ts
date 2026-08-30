import assert from "node:assert/strict";
import test from "node:test";
import {
  createServerSettingsModule,
  serverSettingsManifest,
} from "../components/server/settings/src/index.ts";
import {
  serverJvmArgumentsMaximumLength,
  serverSettingsContract,
  type ServerSettingsClientService,
  type ServerSettingsSnapshot,
  type ServerStartupDefaultsUpdate,
} from "../packages/contracts/src/index.ts";
import type {
  JsonValue,
  PluginContext,
  PluginStorage,
  PluginStoredDocument,
  ServiceProvider,
} from "../packages/plugin-sdk/src/index.ts";

class MemoryPluginStorage implements PluginStorage {
  private readonly documents = new Map<string, PluginStoredDocument>();

  async get(key: string): Promise<PluginStoredDocument | undefined> {
    return this.documents.get(key);
  }

  async put(key: string, value: JsonValue): Promise<PluginStoredDocument> {
    const previous = this.documents.get(key);
    const document: PluginStoredDocument = {
      value,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.documents.set(key, document);
    return document;
  }

  async delete(key: string): Promise<boolean> {
    return this.documents.delete(key);
  }
}

const defaultStartupSettings: ServerStartupDefaultsUpdate = {
  defaultMinimumMemoryMiB: 512,
  defaultMaximumMemoryMiB: 2_048,
  defaultServerPort: 25_565,
  autoAcceptEula: true,
  defaultJvmArguments: "",
};

function expectedSnapshot(
  resourceDownloadDirectory: string,
  defaultDownloadConnections = 8,
  startupSettings: ServerStartupDefaultsUpdate = defaultStartupSettings,
): ServerSettingsSnapshot {
  return {
    resourceDownloadDirectory,
    defaultDownloadConnections,
    ...startupSettings,
  };
}

async function activateSettings(
  storage: PluginStorage,
  defaultResourceDownloadDirectory: string,
  defaultDownloadConnections = 8,
): Promise<ServerSettingsClientService> {
  const providers = new Map<string, ServiceProvider>();
  const context = {
    storage,
    provide: (contract: string, provider: ServiceProvider) => providers.set(contract, provider),
    agentResources: () => undefined,
    agentTool: () => "test.server-settings",
  } as unknown as PluginContext;
  await createServerSettingsModule({
    defaultResourceDownloadDirectory,
    defaultDownloadConnections,
  }).apply(context, null);
  const service = providers.get(serverSettingsContract);
  assert.ok(service, "server settings component must publish its service");
  return service as unknown as ServerSettingsClientService;
}

await test("server settings persist the resource directory across component restarts", async () => {
  const storage = new MemoryPluginStorage();
  const first = await activateSettings(storage, "C:/SeaShard/core/resources");

  assert.deepEqual(await first.get(), expectedSnapshot("C:/SeaShard/core/resources"));
  assert.deepEqual(
    await first.setResourceDownloadDirectory("D:/Minecraft/resources"),
    expectedSnapshot("D:/Minecraft/resources"),
  );
  assert.deepEqual(
    await first.setDefaultDownloadConnections(16),
    expectedSnapshot("D:/Minecraft/resources", 16),
  );

  const restarted = await activateSettings(storage, "C:/Different/default", 4);
  assert.deepEqual(await restarted.get(), expectedSnapshot("D:/Minecraft/resources", 16));
});

await test("server settings serialize concurrent writes and reject invalid download settings", async () => {
  const storage = new MemoryPluginStorage();
  const service = await activateSettings(storage, "C:/SeaShard/core/resources");

  await Promise.all([
    service.setResourceDownloadDirectory("D:/First"),
    service.setDefaultDownloadConnections(16),
  ]);
  assert.deepEqual(await service.get(), expectedSnapshot("D:/First", 16));

  const provider = service as unknown as ServiceProvider;
  assert.throws(() => provider.setResourceDownloadDirectory?.(42), /must be a string/);
  assert.throws(
    () => provider.setDefaultDownloadConnections?.(0),
    /must be an integer between 1 and 32/,
  );
});

await test("server settings persist startup defaults atomically and preserve the last valid state", async () => {
  const storage = new MemoryPluginStorage();
  const service = await activateSettings(storage, "C:/SeaShard/core/resources");
  const startupSettings: ServerStartupDefaultsUpdate = {
    defaultMinimumMemoryMiB: 1_024,
    defaultMaximumMemoryMiB: 6_144,
    defaultServerPort: 25_566,
    autoAcceptEula: false,
    defaultJvmArguments: "-XX:+UseG1GC -XX:+ParallelRefProcEnabled",
  };

  assert.deepEqual(
    await service.setStartupDefaults(startupSettings),
    expectedSnapshot("C:/SeaShard/core/resources", 8, startupSettings),
  );
  const restarted = await activateSettings(storage, "D:/Different/default", 4);
  assert.deepEqual(
    await restarted.get(),
    expectedSnapshot("C:/SeaShard/core/resources", 8, startupSettings),
  );

  const provider = restarted as unknown as ServiceProvider;
  assert.throws(
    () =>
      provider.setStartupDefaults?.({
        ...startupSettings,
        defaultMinimumMemoryMiB: startupSettings.defaultMaximumMemoryMiB + 1,
      }),
    /must not exceed/,
  );
  assert.throws(
    () => provider.setStartupDefaults?.({ ...startupSettings, defaultServerPort: 65_536 }),
    /integer between 1 and 65535/,
  );
  assert.throws(
    () => provider.setStartupDefaults?.({ ...startupSettings, autoAcceptEula: "yes" }),
    /must be a boolean/,
  );
  assert.throws(
    () =>
      provider.setStartupDefaults?.({
        ...startupSettings,
        defaultJvmArguments: "x".repeat(serverJvmArgumentsMaximumLength + 1),
      }),
    /at most 8192 characters/,
  );
  assert.deepEqual(
    await restarted.get(),
    expectedSnapshot("C:/SeaShard/core/resources", 8, startupSettings),
  );
});

await test("server settings add startup defaults when loading a legacy document", async () => {
  const storage = new MemoryPluginStorage();
  await storage.put("settings", {
    resourceDownloadDirectory: "D:/Legacy/resources",
    defaultDownloadConnections: 4,
  });

  const service = await activateSettings(storage, "C:/SeaShard/core/resources");
  assert.deepEqual(await service.get(), expectedSnapshot("D:/Legacy/resources", 4));
});

assert.equal(serverSettingsManifest.entries[0]?.runtime, "host");
