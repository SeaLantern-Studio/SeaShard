import {
  supportsUnifiedWorldStorage,
  type ServerInstanceSnapshot,
  type ServerWorldDimension,
  type ServerWorldDimensionGroup,
  type ServerWorldSave,
  type ServerWorldStorageSnapshot,
} from "@seashard/contracts";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { gunzipSync, inflateSync } from "node:zlib";
import { basename, join, resolve } from "node:path";

const maximumWorldScanDepth = 4;
const maximumWorldCount = 1_000;
const maximumLevelDatBytes = 64 * 1024 * 1024;
const maximumIconBytes = 512 * 1024;
const skippedWorldDirectories = new Set([
  ".seashard",
  "config",
  "crash-reports",
  "libraries",
  "logs",
  "mods",
  "plugins",
  "server",
  "versions",
]);

interface DiscoveredWorld {
  readonly id: string;
  readonly absolutePath: string;
}

interface WorldMetadata {
  readonly name: string;
  readonly iconDataUrl?: string;
}

/** 扫描实例目录并把原生世界、下载世界和多维度目录归一成 Renderer 投影。 */
export async function listWorldStorage(
  instance: ServerInstanceSnapshot,
): Promise<ServerWorldStorageSnapshot> {
  const rootPath = await resolveWorldRoot(instance);
  const currentId = await readLevelNameFromProperties(rootPath);
  const unified = supportsUnifiedWorldStorage(instance.serverType);
  const worlds = await discoverWorlds(rootPath, unified);

  if (unified) {
    const saves = await Promise.all(
      worlds.map(async (world) => createSave(world, currentId === world.id, world.id)),
    );
    saves.sort(compareSaves);
    return {
      instanceId: instance.id,
      mode: "unified",
      ...(currentId ? { currentId } : {}),
      saves,
      dimensions: [],
    };
  }

  const groups = new Map<string, DiscoveredWorld[]>();
  for (const world of worlds) {
    const groupId = splitWorldGroupId(world.id);
    const group = groups.get(groupId) ?? [];
    group.push(world);
    groups.set(groupId, group);
  }

  const dimensions = await Promise.all(
    [...groups.entries()].map(async ([groupId, groupWorlds]) => {
      const saves = await Promise.all(
        groupWorlds.map(async (world) =>
          createSave(world, currentId === groupId, groupId, splitWorldDimension(world.id, groupId)),
        ),
      );
      saves.sort(compareDimensionSaves);
      const overworld = saves.find(({ dimension }) => dimension === "overworld");
      return {
        id: groupId,
        name: overworld?.name ?? saves[0]?.name ?? basename(groupId),
        current: currentId === groupId,
        saves,
      } satisfies ServerWorldDimensionGroup;
    }),
  );
  dimensions.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  return {
    instanceId: instance.id,
    mode: "split",
    ...(currentId ? { currentId } : {}),
    saves: [],
    dimensions,
  };
}
export interface WorldStorageDirectory {
  readonly id: string;
  readonly groupId: string;
  readonly absolutePath: string;
  readonly storageRoot: string;
}

/** 按存档投影解析真实世界目录；split 模式会一次返回同一逻辑世界的全部维度。 */
export async function resolveWorldStorageDirectories(
  instance: ServerInstanceSnapshot,
  requestedId: unknown,
): Promise<readonly WorldStorageDirectory[]> {
  const worldId = expectWorldId(requestedId);
  const rootPath = await resolveWorldRoot(instance);
  const unified = supportsUnifiedWorldStorage(instance.serverType);
  const worlds = await discoverWorlds(rootPath, unified);
  if (unified) {
    const world = worlds.find((candidate) => candidate.id === worldId);
    if (!world) throw new Error("目标存档不存在或不属于当前服务器实例。");
    return [{ ...world, groupId: world.id, storageRoot: rootPath }];
  }

  const targets = worlds.filter((world) => splitWorldGroupId(world.id) === worldId);
  if (targets.length === 0) throw new Error("目标存档不存在或不属于当前服务器实例。");
  return targets.map((world) => ({ ...world, groupId: worldId, storageRoot: rootPath }));
}

export interface WorldDatapackDirectory {
  readonly worldId: string;
  readonly absolutePath: string;
}

/** 解析数据包实际写入目录；split 模式固定使用逻辑世界的主世界目录。 */
export async function resolveWorldDatapackDirectory(
  instance: ServerInstanceSnapshot,
  requestedId: unknown,
): Promise<WorldDatapackDirectory> {
  const sources = await resolveWorldStorageDirectories(instance, requestedId);
  const overworld = sources.find(({ id, groupId }) => id === groupId) ?? sources[0];
  if (!overworld) throw new Error("目标存档不存在或不属于当前服务器实例。");
  return {
    worldId: overworld.groupId,
    absolutePath: resolve(overworld.absolutePath, "datapacks"),
  };
}

/** 只允许切换扫描结果中的目录，并通过 server.properties 的 level-name 完成切换。 */
export async function switchWorldStorage(
  instance: ServerInstanceSnapshot,
  requestedId: unknown,
): Promise<ServerWorldStorageSnapshot> {
  const worldId = expectWorldId(requestedId);
  const snapshot = await listWorldStorage(instance);
  const selectable =
    snapshot.mode === "unified"
      ? snapshot.saves.some((save) => save.id === worldId)
      : snapshot.dimensions.some((group) => group.id === worldId);
  if (!selectable) throw new Error("目标存档不存在或不属于当前服务器实例。");

  const rootPath = await resolveWorldRoot(instance);
  const propertiesPath = resolve(rootPath, "server.properties");
  const source = await readFile(propertiesPath, "utf8");
  await writeFile(propertiesPath, upsertLevelName(source, worldId), "utf8");
  return listWorldStorage(instance);
}

async function resolveWorldRoot(instance: ServerInstanceSnapshot): Promise<string> {
  const rootPath = resolve(instance.rootPath);
  if (instance.serverType === "quilt") {
    try {
      const serverRoot = resolve(rootPath, "server");
      if ((await stat(serverRoot)).isDirectory()) return serverRoot;
    } catch {
      // 缺失 server 子目录时回退到实例根目录，让空实例仍能显示空状态。
    }
  }
  return rootPath;
}

async function discoverWorlds(rootPath: string, recursive: boolean): Promise<DiscoveredWorld[]> {
  const worlds: DiscoveredWorld[] = [];
  const visit = async (
    directory: string,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> => {
    if (worlds.length >= maximumWorldCount || depth > maximumWorldScanDepth) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (worlds.length >= maximumWorldCount) return;
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name.startsWith(".") ||
        skippedWorldDirectories.has(entry.name)
      ) {
        continue;
      }
      const childPath = join(directory, entry.name);
      const childRelative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (await hasLevelDat(childPath)) {
        worlds.push({ id: childRelative.replaceAll("\\", "/"), absolutePath: childPath });
        continue;
      }
      if (recursive) await visit(childPath, childRelative, depth + 1);
    }
  };
  await visit(rootPath, "", 0);
  return worlds;
}

async function hasLevelDat(directory: string): Promise<boolean> {
  try {
    return (await stat(join(directory, "level.dat"))).isFile();
  } catch {
    return false;
  }
}

async function createSave(
  world: DiscoveredWorld,
  current: boolean,
  groupId: string,
  dimension: ServerWorldDimension = "overworld",
): Promise<ServerWorldSave> {
  const metadata = await readWorldMetadata(world.absolutePath, basename(world.id));
  const timestamps = await readWorldTimestamps(world.absolutePath);
  return {
    id: world.id,
    groupId,
    name: metadata.name,
    dimension,
    current,
    ...timestamps,
    ...(metadata.iconDataUrl ? { iconDataUrl: metadata.iconDataUrl } : {}),
  };
}

async function readWorldMetadata(worldPath: string, fallbackName: string): Promise<WorldMetadata> {
  let name = fallbackName;
  try {
    const levelDat = await readFile(join(worldPath, "level.dat"));
    if (levelDat.byteLength <= maximumLevelDatBytes) {
      name = readLevelNameFromNbt(levelDat) ?? fallbackName;
    }
  } catch {
    // 不完整或尚未生成的世界仍然可以按目录显示。
  }

  try {
    const icon = await readFile(join(worldPath, "icon.png"));
    if (icon.byteLength <= maximumIconBytes && isPng(icon)) {
      return { name, iconDataUrl: `data:image/png;base64,${icon.toString("base64")}` };
    }
  } catch {
    // icon.png 是可选文件。
  }
  return { name };
}

async function readWorldTimestamps(
  worldPath: string,
): Promise<{ createdAt: string; updatedAt: string } | undefined> {
  try {
    const details = await stat(worldPath);
    return {
      createdAt: details.birthtime.toISOString(),
      updatedAt: details.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}

function readLevelNameFromNbt(source: Uint8Array): string | undefined {
  const data = decodeLevelDat(source);
  const reader = new NbtReader(data);
  return reader.readLevelName();
}

function decodeLevelDat(source: Uint8Array): Uint8Array {
  if (source[0] === 0x1f && source[1] === 0x8b) return gunzipSync(source);
  if (source[0] === 0x0a) return source;
  try {
    return inflateSync(source);
  } catch {
    return source;
  }
}

class NbtReader {
  private offset = 0;
  private tagsRead = 0;

  constructor(private readonly data: Uint8Array) {}

  readLevelName(): string | undefined {
    if (this.readByte() !== 10) return undefined;
    this.readString();
    return this.readCompound(0);
  }

  private readCompound(depth: number): string | undefined {
    if (depth > 32) throw new Error("NBT compound nesting is too deep");
    for (;;) {
      const type = this.readByte();
      if (type === 0) return undefined;
      const name = this.readString();
      this.tagsRead += 1;
      if (this.tagsRead > 100_000) throw new Error("NBT contains too many tags");
      if (type === 8 && name === "LevelName") return this.readString();
      if (type === 10) {
        const found = this.readCompound(depth + 1);
        if (found !== undefined) return found;
      } else {
        this.skipPayload(type, depth);
      }
    }
  }

  private skipPayload(type: number, depth: number): void {
    if (type === 1) this.skip(1);
    else if (type === 2) this.skip(2);
    else if (type === 3 || type === 5) this.skip(4);
    else if (type === 4 || type === 6) this.skip(8);
    else if (type === 7) this.skip(this.readInt32());
    else if (type === 8) this.readString();
    else if (type === 9) {
      const itemType = this.readByte();
      const length = this.readInt32();
      if (length < 0 || length > 100_000) throw new Error("NBT list length is invalid");
      for (let index = 0; index < length; index += 1) this.skipPayload(itemType, depth + 1);
    } else if (type === 10) {
      this.readCompound(depth + 1);
    } else if (type === 11) {
      this.skip(this.readInt32() * 4);
    } else if (type === 12) {
      this.skip(this.readInt32() * 8);
    } else {
      throw new Error("NBT tag type is invalid");
    }
  }

  private readByte(): number {
    this.ensure(1);
    return this.data[this.offset++]!;
  }

  private readInt32(): number {
    this.ensure(4);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4).getInt32(0);
    this.offset += 4;
    return value;
  }

  private readString(): string {
    this.ensure(2);
    const length = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 2).getUint16(
      0,
    );
    this.offset += 2;
    this.ensure(length);
    const value = new TextDecoder("utf-8", { fatal: true }).decode(
      this.data.slice(this.offset, this.offset + length),
    );
    this.offset += length;
    return value;
  }

  private skip(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0)
      throw new Error("NBT payload length is invalid");
    this.ensure(length);
    this.offset += length;
  }

  private ensure(length: number): void {
    if (this.offset + length > this.data.byteLength) throw new Error("NBT data is truncated");
  }
}

function splitWorldGroupId(worldId: string): string {
  return worldId.replace(/_(?:nether|the_end)$/u, "");
}

function splitWorldDimension(worldId: string, groupId: string): ServerWorldDimension {
  if (worldId === `${groupId}_nether`) return "nether";
  if (worldId === `${groupId}_the_end`) return "end";
  return "overworld";
}

function compareSaves(left: ServerWorldSave, right: ServerWorldSave): number {
  return left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id);
}

function compareDimensionSaves(left: ServerWorldSave, right: ServerWorldSave): number {
  const order: Record<ServerWorldDimension, number> = { overworld: 0, nether: 1, end: 2 };
  return order[left.dimension] - order[right.dimension] || compareSaves(left, right);
}

async function readLevelNameFromProperties(rootPath: string): Promise<string | undefined> {
  try {
    const source = await readFile(resolve(rootPath, "server.properties"), "utf8");
    for (const line of source.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 0 || trimmed.slice(0, separator).trim() !== "level-name") continue;
      const value = trimmed
        .slice(separator + 1)
        .trim()
        .replaceAll("\\", "/");
      return value || undefined;
    }
  } catch {
    // 配置尚未生成时只展示存档，不标记当前项。
  }
  return undefined;
}

function upsertLevelName(source: string, worldId: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/u);
  const index = lines.findIndex((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return false;
    const separator = trimmed.indexOf("=");
    return separator >= 0 && trimmed.slice(0, separator).trim() === "level-name";
  });
  if (index >= 0) {
    lines[index] = `level-name=${worldId}`;
  } else {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
    lines.push(`level-name=${worldId}`);
  }
  return lines.join(newline);
}

function expectWorldId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("存档目录标识无效");
  }
  return value;
}

function isPng(value: Uint8Array): boolean {
  return (
    value.byteLength >= 8 &&
    value[0] === 0x89 &&
    value[1] === 0x50 &&
    value[2] === 0x4e &&
    value[3] === 0x47 &&
    value[4] === 0x0d &&
    value[5] === 0x0a &&
    value[6] === 0x1a &&
    value[7] === 0x0a
  );
}
