import type { ClientEntryPublication } from "@seashard/contracts";
import type { ResolvedClientEntrySnapshot } from "./types";
import { createClientPluginAssetUrl } from "./client-assets";

/**
 * 把 Main 内部解析结果收窄成可跨 Preload 传输的 Client Entry 期望状态。
 *
 * 绝对包路径、Trust Store、完整 Manifest 和 Loader 对象不得越过该边界。
 */
export function projectClientEntryPublication(
  snapshot: ResolvedClientEntrySnapshot,
): ClientEntryPublication {
  return {
    revision: snapshot.revision,
    entries: snapshot.entries.map((entry) => ({
      runtimeId: entry.runtimeId,
      pluginId: entry.package.manifest.id,
      pluginVersion: entry.package.manifest.version,
      entryId: entry.entry.id,
      module:
        entry.package.source === "builtin"
          ? {
              source: "builtin",
              key: `${entry.package.manifest.id}/${entry.entry.id}`,
            }
          : {
              source: "package",
              url: createClientPluginAssetUrl(entry.package.digest, entry.entry.module),
            },
      integrity: entry.package.digest,
      scopeType: entry.binding.scopeType,
      scopeId: entry.binding.scopeId,
      config: entry.binding.config,
    })),
  };
}
