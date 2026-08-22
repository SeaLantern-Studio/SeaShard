import {
  supportsUnifiedWorldStorage,
  type ServerInstanceSnapshot,
  type ServerModVersion,
  type ServerWorldStorageSnapshot,
} from "@seashard/contracts";

export interface DatapackWorldTarget {
  readonly id: string;
  readonly name: string;
  readonly current: boolean;
  readonly iconDataUrl?: string;
}

/** 把统一世界与分维度世界折叠成数据包可选择的逻辑存档。 */
export function datapackWorldTargetsFromStorage(
  storage: ServerWorldStorageSnapshot,
): DatapackWorldTarget[] {
  if (storage.mode === "unified") {
    return storage.saves.map(({ id, name, current, iconDataUrl }) => ({
      id,
      name,
      current,
      ...(iconDataUrl ? { iconDataUrl } : {}),
    }));
  }
  return storage.dimensions
    .filter(({ saves }) => saves.length > 0)
    .map((group) => {
      const overworld = group.saves.find(({ dimension }) => dimension === "overworld");
      return {
        id: group.id,
        name: group.name,
        current: group.current,
        ...(overworld?.iconDataUrl ? { iconDataUrl: overworld.iconDataUrl } : {}),
      };
    });
}

/** 数据包要求精确版本匹配和已有存档；世界还要求核心采用单目录多维度布局。 */
export function compatibleServerResourceInstances(
  version: ServerModVersion,
  instances: readonly ServerInstanceSnapshot[],
  resourceType: "modpack" | "datapack" | "world",
): ServerInstanceSnapshot[] {
  return instances.filter((instance) => {
    if (!instance.gameVersion || !version.gameVersions.includes(instance.gameVersion)) return false;
    return resourceType !== "world" || supportsUnifiedWorldStorage(instance.serverType);
  });
}

/** 只有加载器与精确 Minecraft 版本都匹配的已登记实例才可成为安装目标。 */
export function compatibleServerModInstances(
  version: ServerModVersion,
  instances: readonly ServerInstanceSnapshot[],
): ServerInstanceSnapshot[] {
  return instances.filter(
    (instance) =>
      instance.modLoader !== null &&
      version.loaders.includes(instance.modLoader) &&
      !!instance.gameVersion &&
      version.gameVersions.includes(instance.gameVersion),
  );
}

export function datapackPendingTarget(instanceId: string, worldId: string): string {
  return `datapack:${instanceId}:${worldId}`;
}
