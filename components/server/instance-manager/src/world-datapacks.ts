import type { ServerInstanceSnapshot, ServerWorldDatapackSnapshot } from "@seashard/contracts";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorldDatapackDirectory } from "./world-storage";

const maximumWorldDatapackCount = 256;

/** 扫描指定逻辑世界的直接数据包目录，只发布可识别的数据包条目。 */
export async function listWorldDatapacks(
  instance: ServerInstanceSnapshot,
  requestedWorldId: unknown,
): Promise<readonly ServerWorldDatapackSnapshot[]> {
  const target = await resolveWorldDatapackDirectory(instance, requestedWorldId);
  let entries;
  try {
    entries = await readdir(target.absolutePath, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const candidates = entries
    .filter(
      (entry) =>
        !entry.isSymbolicLink() &&
        (entry.isDirectory() || (entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))),
    )
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    .slice(0, maximumWorldDatapackCount);
  const datapacks = await Promise.all(
    candidates.map((entry) =>
      readDatapackEntry(instance, target.worldId, target.absolutePath, entry),
    ),
  );
  return datapacks
    .filter((value): value is ServerWorldDatapackSnapshot => value !== undefined)
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.fileName.localeCompare(right.fileName, "zh-CN"),
    );
}

async function readDatapackEntry(
  instance: ServerInstanceSnapshot,
  worldId: string,
  datapackDirectory: string,
  entry: import("node:fs").Dirent,
): Promise<ServerWorldDatapackSnapshot | undefined> {
  const entryPath = join(datapackDirectory, entry.name);
  let kind: ServerWorldDatapackSnapshot["kind"];
  if (entry.isDirectory()) {
    if (!(await hasPackMetadata(entryPath))) return undefined;
    kind = "directory";
  } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
    kind = "archive";
  } else {
    return undefined;
  }

  const details = await stat(entryPath);
  return {
    instanceId: instance.id,
    worldId,
    fileName: entry.name,
    kind,
    updatedAt: details.mtime.toISOString(),
  };
}

async function hasPackMetadata(directory: string): Promise<boolean> {
  try {
    return (await stat(join(directory, "pack.mcmeta"))).isFile();
  } catch {
    return false;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
