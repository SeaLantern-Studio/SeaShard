import assert from "node:assert/strict";
import test from "node:test";
import {
  createServerSettingsModule,
  serverSettingsManifest,
} from "../components/server/settings/src/index.ts";
import {
  serverSettingsContract,
  type ServerSettingsClientService,
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

async function activateSettings(
  storage: PluginStorage,
  defaultResourceDownloadDirectory: string,
): Promise<ServerSettingsClientService> {
  const providers = new Map<string, ServiceProvider>();
  const context = {
    storage,
    provide: (contract: string, provider: ServiceProvider) => providers.set(contract, provider),
  } as unknown as PluginContext;
  await createServerSettingsModule({ defaultResourceDownloadDirectory }).apply(context, null);
  const service = providers.get(serverSettingsContract);
  assert.ok(service, "server settings component must publish its service");
  return service as unknown as ServerSettingsClientService;
}

await test("server settings persist the resource directory across component restarts", async () => {
  const storage = new MemoryPluginStorage();
  const first = await activateSettings(storage, "C:/SeaShard/core/resources");

  assert.deepEqual(await first.get(), {
    resourceDownloadDirectory: "C:/SeaShard/core/resources",
  });
  assert.deepEqual(await first.setResourceDownloadDirectory("D:/Minecraft/resources"), {
    resourceDownloadDirectory: "D:/Minecraft/resources",
  });

  const restarted = await activateSettings(storage, "C:/Different/default");
  assert.deepEqual(await restarted.get(), {
    resourceDownloadDirectory: "D:/Minecraft/resources",
  });
});

await test("server settings serialize concurrent writes and reject non-string paths", async () => {
  const storage = new MemoryPluginStorage();
  const service = await activateSettings(storage, "C:/SeaShard/core/resources");

  await Promise.all([
    service.setResourceDownloadDirectory("D:/First"),
    service.setResourceDownloadDirectory("E:/Second"),
  ]);
  assert.deepEqual(await service.get(), { resourceDownloadDirectory: "E:/Second" });

  const provider = service as unknown as ServiceProvider;
  assert.throws(() => provider.setResourceDownloadDirectory?.(42), /must be a string/);
});

assert.equal(serverSettingsManifest.entries[0]?.runtime, "host");
