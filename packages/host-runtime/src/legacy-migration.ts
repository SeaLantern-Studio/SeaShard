import {
  legacyHostMigrationContract,
  type LegacyHostMigrationSnapshot,
} from "@seashard/host-control";
import type { SQLitePluginDocumentStorage } from "@seashard/plugin-foundation";
import type { JsonValue } from "@seashard/plugin-sdk";
import type { PluginKernel } from "@seashard/plugin-system";

const legacyPluginDocumentMigrationId = "host-plugin-documents-to-controller-v1";

/**
 * 旧版 Desktop 曾把正式插件与插件文档写进 Host 数据库。独立 Host 通过这个受控
 * Service 只读导出旧状态，让 Controller 完成一次幂等接管；Host 不解释新插件业务。
 */
export function registerLegacyHostMigrationService(
  kernel: PluginKernel,
  storage: SQLitePluginDocumentStorage,
): void {
  kernel.registerCoreService(legacyHostMigrationContract, {
    async snapshot() {
      const packages = await Promise.all(
        (await kernel.registry.listCurrentPackages())
          .filter(({ source }) => source === "installed")
          .map(async (record) => ({
            pluginId: record.manifest.id,
            rootPath: record.rootPath,
            bindings: (await kernel.registry.listBindings(record.manifest.id)).map(
              ({ entryId, enabled, config }) => ({ entryId, enabled, config }),
            ),
          })),
      );
      const result: LegacyHostMigrationSnapshot = {
        documentsCompleted: Boolean(
          await storage.readMigrationMarker(legacyPluginDocumentMigrationId),
        ),
        packages: packages.sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
      };
      return result as unknown as JsonValue;
    },
    async readDocuments(ownerIdsValue) {
      if (!Array.isArray(ownerIdsValue)) {
        throw new TypeError("legacy migration owner ids must be an array");
      }
      const ownerIds = ownerIdsValue.map((value) => requireString(value, "plugin owner id"));
      return (await storage.exportOwners(ownerIds)) as unknown as JsonValue;
    },
    async completeDocuments(targetIdValue, documentCountValue) {
      const targetId = requireString(targetIdValue, "migration target id");
      if (
        typeof documentCountValue !== "number" ||
        !Number.isSafeInteger(documentCountValue) ||
        documentCountValue < 0
      ) {
        throw new TypeError("migration document count must be a non-negative safe integer");
      }
      await storage.completeMigration({
        migrationId: legacyPluginDocumentMigrationId,
        targetId,
        documentCount: Number(documentCountValue),
        completedAt: new Date().toISOString(),
      });
    },
  });
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} must be a string`);
  return value;
}
