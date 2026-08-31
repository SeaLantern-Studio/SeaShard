import {
  legacyHostMigrationContract,
  type HostControlClient,
  type LegacyHostMigrationPackageSnapshot,
  type LegacyHostMigrationSnapshot,
} from "@seashard/host-control";
import type {
  PluginDocumentMigrationRow,
  SQLitePluginDocumentStorage,
} from "@seashard/plugin-foundation";
import type { JsonValue } from "@seashard/plugin-sdk";
import {
  automaticPluginBindingId,
  automaticPluginBindingPrefix,
  type PluginKernel,
} from "@seashard/plugin-system";

interface LegacyHostMigrationService {
  snapshot(): Promise<JsonValue>;
  readDocuments(ownerIds: readonly string[]): Promise<JsonValue>;
  completeDocuments(targetId: string, documentCount: number): Promise<void>;
}

/**
 * 独立 Host 仍可能持有旧版 Desktop 写入的 Controller 插件。迁移只在当前 Controller
 * 拿到写控制权时执行，复制完成后由 Host 记录幂等标记，源数据始终保留。
 */
export async function migrateLegacyHostState(options: {
  readonly client: HostControlClient | undefined;
  readonly controller: PluginKernel;
  readonly targetStorage: SQLitePluginDocumentStorage;
  readonly targetId: string;
}): Promise<void> {
  if (!options.client?.hasControl) return;
  const service = options.client.service<LegacyHostMigrationService>(legacyHostMigrationContract);
  const snapshot = parseMigrationSnapshot(await service.snapshot());
  const pluginIds = await migratePackages(snapshot.packages, options.controller);
  if (snapshot.documentsCompleted) return;

  const documents = parseMigrationDocuments(
    await service.readDocuments([...pluginIds, "seashard.server-settings"]),
  );
  await options.targetStorage.importDocuments(documents);
  await service.completeDocuments(options.targetId, documents.length);
}

async function migratePackages(
  packages: readonly LegacyHostMigrationPackageSnapshot[],
  controller: PluginKernel,
): Promise<readonly string[]> {
  const currentIds = new Set(
    (await controller.registry.listCurrentPackages()).map(({ manifest }) => manifest.id),
  );
  for (const legacy of packages) {
    if (currentIds.has(legacy.pluginId)) continue;
    const prepared = await controller.prepareDirectory(legacy.rootPath);
    try {
      const imported = await prepared.commit({
        digest: prepared.digest,
        acknowledgeFullMachineAccess: true,
      });
      const nextBindings = imported.manifest.entries.map((entry) => {
        const previous = legacy.bindings.find(({ entryId }) => entryId === entry.id);
        return {
          id: automaticPluginBindingId("plugin", imported.manifest.id, entry.id),
          pluginId: imported.manifest.id,
          entryId: entry.id,
          scopeType: "global" as const,
          scopeId: "global",
          enabled: previous?.enabled ?? true,
          config: previous?.config ?? {},
        };
      });
      await controller.registry.replacePackageSelectionAndBindings(
        imported.manifest.id,
        imported,
        automaticPluginBindingPrefix("plugin", imported.manifest.id),
        nextBindings,
      );
      currentIds.add(imported.manifest.id);
    } finally {
      await prepared.dispose();
    }
  }
  return packages.map(({ pluginId }) => pluginId);
}

function parseMigrationSnapshot(value: JsonValue): LegacyHostMigrationSnapshot {
  const record = requireRecord(value, "legacy Host migration snapshot");
  if (typeof record.documentsCompleted !== "boolean" || !Array.isArray(record.packages)) {
    throw new TypeError("legacy Host migration snapshot is invalid");
  }
  return {
    documentsCompleted: record.documentsCompleted,
    packages: record.packages.map((packageValue) => {
      const packageRecord = requireRecord(packageValue, "legacy Host plugin package");
      if (!Array.isArray(packageRecord.bindings)) {
        throw new TypeError("legacy Host plugin bindings must be an array");
      }
      return {
        pluginId: requireString(packageRecord.pluginId, "plugin id"),
        rootPath: requireString(packageRecord.rootPath, "plugin root path"),
        bindings: packageRecord.bindings.map((bindingValue) => {
          const binding = requireRecord(bindingValue, "legacy Host plugin binding");
          if (typeof binding.enabled !== "boolean") {
            throw new TypeError("legacy Host plugin binding enabled must be a boolean");
          }
          return {
            entryId: requireString(binding.entryId, "entry id"),
            enabled: binding.enabled,
            config: binding.config as JsonValue,
          };
        }),
      };
    }),
  };
}

function parseMigrationDocuments(value: JsonValue): readonly PluginDocumentMigrationRow[] {
  if (!Array.isArray(value))
    throw new TypeError("legacy Host migration documents must be an array");
  return value.map((rowValue) => {
    const row = requireRecord(rowValue, "legacy Host migration document");
    if (typeof row.revision !== "number" || !Number.isSafeInteger(row.revision)) {
      throw new TypeError("legacy Host migration document revision must be a safe integer");
    }
    if (row.expiresAt !== null && typeof row.expiresAt !== "string") {
      throw new TypeError("legacy Host migration document expiry must be a string or null");
    }
    return {
      ownerId: requireString(row.ownerId, "owner id"),
      runtimeId: requireString(row.runtimeId, "runtime id"),
      documentKey: requireString(row.documentKey, "document key"),
      valueJson: requireString(row.valueJson, "document value"),
      revision: Number(row.revision),
      updatedAt: requireString(row.updatedAt, "document update time"),
      expiresAt: row.expiresAt,
    };
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} must be a string`);
  return value;
}
