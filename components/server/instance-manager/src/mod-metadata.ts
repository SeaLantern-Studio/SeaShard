import { strFromU8, unzipSync } from "fflate";
import { readFile } from "node:fs/promises";
import { imageBytesToDataUrl } from "./image-data";

const maximumModArchiveBytes = 128 * 1024 * 1024;
const maximumModArchiveEntries = 8_192;
const maximumModMetadataBytes = 1 * 1024 * 1024;
const maximumModIconBytes = 512 * 1024;
const maximumModDescriptionLength = 2_000;
const maximumModNameLength = 256;
const maximumModVersionLength = 256;
const metadataFileNames = new Set([
  "fabric.mod.json",
  "quilt.mod.json",
  "META-INF/mods.toml",
  "META-INF/neoforge.mods.toml",
  "mcmod.info",
  "META-INF/MANIFEST.MF",
]);

export interface ModMetadata {
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly iconDataUrl?: string;
}

interface ParsedModMetadata {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  iconPath?: string;
}

/** 读取常见加载器清单；JAR 损坏或元数据异常时保留文件本身但返回空元数据。 */
export async function readModMetadata(
  entryPath: string,
  signal?: AbortSignal,
): Promise<ModMetadata> {
  try {
    signal?.throwIfAborted();
    const archive = await readFile(entryPath, { signal });
    signal?.throwIfAborted();
    if (archive.byteLength > maximumModArchiveBytes) return {};

    let entryCount = 0;
    const metadataEntries = unzipSync(archive, {
      filter: (file) => {
        entryCount += 1;
        if (file.originalSize > maximumModMetadataBytes) return false;
        return metadataFileNames.has(file.name);
      },
    });
    signal?.throwIfAborted();
    if (entryCount > maximumModArchiveEntries) return {};

    const parsed = parseMetadataEntries(metadataEntries);
    const iconDataUrl = readIcon(archive, iconPaths(parsed));
    signal?.throwIfAborted();
    return {
      ...(parsed?.name ? { name: parsed.name } : {}),
      ...(parsed?.version ? { version: parsed.version } : {}),
      ...(parsed?.description ? { description: parsed.description } : {}),
      ...(iconDataUrl ? { iconDataUrl } : {}),
    };
  } catch {
    signal?.throwIfAborted();
    return {};
  }
}

function parseMetadataEntries(entries: Record<string, Uint8Array>): ParsedModMetadata | undefined {
  const parsed = mergeMetadata(
    parseJsonMetadata(entries["fabric.mod.json"], "fabric"),
    parseJsonMetadata(entries["quilt.mod.json"], "quilt"),
    parseForgeMetadata(entries["META-INF/mods.toml"] ?? entries["META-INF/neoforge.mods.toml"]),
    parseLegacyForgeMetadata(entries["mcmod.info"]),
    parseManifestMetadata(entries["META-INF/MANIFEST.MF"]),
  );
  if (!parsed) return undefined;
  return {
    ...(parsed.id ? { id: parsed.id } : {}),
    ...(parsed.name ? { name: normalizeText(parsed.name, maximumModNameLength) } : {}),
    ...(parsed.version ? { version: normalizeText(parsed.version, maximumModVersionLength) } : {}),
    ...(parsed.description ? { description: normalizeDescription(parsed.description) } : {}),
    ...(parsed.iconPath ? { iconPath: normalizeArchivePath(parsed.iconPath) } : {}),
  };
}

function parseJsonMetadata(
  bytes: Uint8Array | undefined,
  loader: "fabric" | "quilt",
): ParsedModMetadata | undefined {
  const root = parseJsonRecord(bytes);
  if (!root) return undefined;
  if (loader === "fabric") {
    return {
      id: textValue(root.id),
      name: textValue(root.name),
      version: textValue(root.version),
      description: textValue(root.description),
      iconPath: iconPathValue(root.icon),
    };
  }

  const quiltLoader = asRecord(root.quilt_loader);
  const metadata = asRecord(quiltLoader?.metadata);
  return {
    id: textValue(quiltLoader?.id),
    name: textValue(metadata?.name) ?? textValue(quiltLoader?.name),
    version: textValue(quiltLoader?.version),
    description: textValue(metadata?.description) ?? textValue(quiltLoader?.description),
    iconPath: iconPathValue(metadata?.icon) ?? iconPathValue(quiltLoader?.icon),
  };
}

function parseForgeMetadata(bytes: Uint8Array | undefined): ParsedModMetadata | undefined {
  const text = decodeMetadata(bytes);
  if (!text) return undefined;
  const firstModSection = text.match(/\[\[mods\]\]([\s\S]*?)(?=\[\[|$)/u)?.[1] ?? text;
  const id = parseTomlString(firstModSection, "modId");
  const displayName = parseTomlString(firstModSection, "displayName");
  const version = parseTomlString(firstModSection, "version");
  const description = parseTomlString(firstModSection, "description");
  const iconPath = parseTomlString(firstModSection, "logoFile");
  if (!(id || displayName || version || description || iconPath)) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(displayName || id ? { name: displayName ?? id } : {}),
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
    ...(iconPath ? { iconPath } : {}),
  };
}

function parseLegacyForgeMetadata(bytes: Uint8Array | undefined): ParsedModMetadata | undefined {
  const root = parseJsonValue(bytes);
  const rootRecord = asRecord(root);
  const modList = rootRecord?.modList;
  const first = Array.isArray(root)
    ? asRecord(root[0])
    : Array.isArray(modList)
      ? asRecord(modList[0])
      : rootRecord;
  if (!first || typeof first !== "object") return undefined;
  const id = textValue(first.modid) ?? textValue(first.modId);
  const name = textValue(first.name) ?? textValue(first.displayName);
  const version = textValue(first.version);
  const description = textValue(first.description);
  const iconPath = textValue(first.logoFile);
  if (!(id || name || version || description || iconPath)) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(name || id ? { name: name ?? id } : {}),
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
    ...(iconPath ? { iconPath } : {}),
  };
}

function parseManifestMetadata(bytes: Uint8Array | undefined): ParsedModMetadata | undefined {
  const text = decodeMetadata(bytes);
  if (!text) return undefined;
  const title = manifestValue(text, "Implementation-Title");
  const version = manifestValue(text, "Implementation-Version");
  if (!(title || version)) return undefined;
  return {
    ...(title ? { name: title } : {}),
    ...(version ? { version } : {}),
  };
}

function mergeMetadata(
  ...values: Array<ParsedModMetadata | undefined>
): ParsedModMetadata | undefined {
  const result: ParsedModMetadata = {};
  let found = false;
  for (const value of values) {
    if (!value) continue;
    for (const key of ["id", "name", "version", "description", "iconPath"] as const) {
      if (result[key] === undefined && value[key] !== undefined) {
        result[key] = value[key];
        found = true;
      }
    }
  }
  return found ? result : undefined;
}

function iconPaths(parsed: ParsedModMetadata | undefined): ReadonlySet<string> {
  const candidates = new Set<string>(["icon.png", "logo.png"]);
  const explicit = parsed?.iconPath ? normalizeArchivePath(parsed.iconPath) : undefined;
  if (explicit) candidates.add(explicit);
  if (parsed?.id) candidates.add(`assets/${parsed.id}/icon.png`);
  return candidates;
}

function readIcon(archive: Uint8Array, candidates: ReadonlySet<string>): string | undefined {
  let entryCount = 0;
  const entries = unzipSync(archive, {
    filter: (file) => {
      entryCount += 1;
      return candidates.has(file.name) && file.originalSize <= maximumModIconBytes;
    },
  });
  if (entryCount > maximumModArchiveEntries) return undefined;
  for (const candidate of candidates) {
    const icon = imageBytesToDataUrl(entries[candidate], maximumModIconBytes);
    if (icon) return icon;
  }
  return undefined;
}

function parseJsonRecord(bytes: Uint8Array | undefined): Record<string, unknown> | undefined {
  const value = parseJsonValue(bytes);
  return asRecord(value);
}

function parseJsonValue(bytes: Uint8Array | undefined): unknown {
  const text = decodeMetadata(bytes);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function decodeMetadata(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.byteLength > maximumModMetadataBytes) return undefined;
  return strFromU8(bytes);
}

function parseTomlString(source: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `(?:^|\\r?\\n)\\s*${escapedKey}\\s*=\\s*(?:"""([\\s\\S]*?)"""|"((?:\\\\.|[^"])*)"|'([^']*)'|([^\\r\\n#]+))`,
    "u",
  ).exec(source);
  if (!match) return undefined;
  if (match[1] !== undefined) return match[1];
  if (match[2] !== undefined) {
    try {
      return JSON.parse(`"${match[2]}"`) as string;
    } catch {
      return match[2];
    }
  }
  return match[3] ?? match[4]?.trim();
}

function manifestValue(source: string, key: string): string | undefined {
  return source.match(new RegExp(`^${key}:\\s*(.+)$`, "imu"))?.[1]?.trim();
}

function iconPathValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return undefined;
  return Object.entries(record)
    .sort(([left], [right]) => Number(right) - Number(left))
    .map(([, candidate]) => (typeof candidate === "string" ? candidate : undefined))
    .find((candidate): candidate is string => Boolean(candidate));
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("") || undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  const direct = textValue(record.text) ?? textValue(record.translate) ?? "";
  const withText = Array.isArray(record.with)
    ? record.with.map(textValue).filter(Boolean).join("")
    : "";
  const extra = Array.isArray(record.extra)
    ? record.extra.map(textValue).filter(Boolean).join("")
    : "";
  return direct || withText || extra || undefined;
}

function normalizeDescription(value: string): string | undefined {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maximumModDescriptionLength
    ? normalized
    : `${normalized.slice(0, maximumModDescriptionLength - 1)}…`;
}

function normalizeText(value: string, maximumLength: number): string | undefined {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maximumLength);
}

function normalizeArchivePath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return undefined;
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
