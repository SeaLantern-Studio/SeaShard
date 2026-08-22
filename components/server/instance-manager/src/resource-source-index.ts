import type {
  ServerResourceSource,
  ServerResourceSourceIndex,
  ServerResourceSourceMetadata,
  ServerResourceSourceRecord,
  ServerResourceSourceType,
} from "@seashard/contracts";

const maximumResourceSourceEntries = 4_096;
const maximumResourceSourcePathLength = 2_048;
const maximumResourceSourceIdLength = 256;
const maximumResourceSourceIconUrlLength = 2_048;
const resourceSourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const resourceSourceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const resourceSourceSections = {
  mod: "mods",
  datapack: "datapacks",
  world: "worlds",
} as const satisfies Record<ServerResourceSourceType, keyof ServerResourceSourceIndex>;

/** 把一条已完成下载记录写入实例的本地资源来源索引。 */
export function upsertResourceSource(
  index: ServerResourceSourceIndex | undefined,
  value: ServerResourceSourceRecord,
): ServerResourceSourceIndex {
  const record = parseResourceSourceRecord(value);
  const section = resourceSourceSections[record.resourceType];
  const metadata: ServerResourceSourceMetadata = {
    source: record.source,
    id: record.id,
    ...(record.iconUrl ? { iconUrl: record.iconUrl } : {}),
  };
  return {
    ...index,
    [section]: {
      ...index?.[section],
      [record.relativePath]: metadata,
    },
  };
}

/** 宽容读取 seashard.json 中的可选索引；坏记录只影响自身，不阻塞实例读取。 */
export function parseResourceSourceIndex(value: unknown): ServerResourceSourceIndex | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result: ServerResourceSourceIndex = {};
  let found = false;

  for (const section of Object.values(resourceSourceSections)) {
    const table = asRecord(record[section]);
    if (!table) continue;
    const parsedTable: Record<string, ServerResourceSourceMetadata> = {};
    for (const [relativePath, metadataValue] of Object.entries(table).slice(
      0,
      maximumResourceSourceEntries,
    )) {
      const normalizedPath = normalizeResourceSourcePath(relativePath);
      const metadata = parseResourceSourceMetadata(metadataValue);
      if (!normalizedPath || !metadata) continue;
      parsedTable[normalizedPath] = metadata;
      found = true;
    }
    if (Object.keys(parsedTable).length > 0) {
      Object.assign(result, { [section]: parsedTable });
    }
  }

  return found ? result : undefined;
}

/** 校验 Host 要写入的资源来源记录，并归一化本地相对路径。 */
export function parseResourceSourceRecord(value: unknown): ServerResourceSourceRecord {
  const record = asRecord(value);
  if (!record) throw new TypeError("resource source record must be an object");
  const resourceType = parseResourceSourceType(record.resourceType);
  const relativePath = normalizeResourceSourcePath(record.relativePath);
  const metadata = parseResourceSourceMetadata(record);
  if (!resourceType || !relativePath || !metadata) {
    throw new TypeError("resource source record is invalid");
  }
  return { resourceType, relativePath, ...metadata };
}

/** 统一 Windows 与 POSIX 分隔符；索引内使用对应资源存储根目录下的相对 POSIX 路径。 */
export function normalizeResourceSourcePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.length > maximumResourceSourcePathLength ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return undefined;
  }
  return normalized;
}

function parseResourceSourceMetadata(value: unknown): ServerResourceSourceMetadata | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const source = parseResourceSource(record.source);
  const id = record.id;
  if (
    !source ||
    typeof id !== "string" ||
    !resourceSourceIdPattern.test(id) ||
    id.length > maximumResourceSourceIdLength
  ) {
    return undefined;
  }
  const iconUrl = parseResourceSourceIconUrl(record.iconUrl, source, id);
  return {
    source,
    id,
    ...(iconUrl ? { iconUrl } : {}),
  };
}

function parseResourceSourceType(value: unknown): ServerResourceSourceType | undefined {
  return value === "mod" || value === "datapack" || value === "world" ? value : undefined;
}

function parseResourceSource(value: unknown): ServerResourceSource | undefined {
  if (typeof value !== "string" || !resourceSourceNamePattern.test(value)) return undefined;
  return value;
}

function parseResourceSourceIconUrl(
  value: unknown,
  source: ServerResourceSource,
  id: string,
): string | undefined {
  if (typeof value !== "string" || !value || value.length > maximumResourceSourceIconUrlLength) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    if (
      source === "modrinth" &&
      (url.hostname !== "cdn.modrinth.com" ||
        !url.pathname.startsWith(`/data/${encodeURIComponent(id)}/`))
    ) {
      return undefined;
    }
    if (
      source === "curseforge" &&
      url.hostname !== "media.forgecdn.net" &&
      url.hostname !== "mod.mcimirror.top"
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
