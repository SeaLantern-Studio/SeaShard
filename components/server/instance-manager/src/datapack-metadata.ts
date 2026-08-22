import { strFromU8, unzipSync } from "fflate";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerWorldDatapackKind } from "@seashard/contracts";

const maximumDatapackArchiveBytes = 128 * 1024 * 1024;
const maximumDatapackArchiveEntries = 4_096;
const maximumDatapackMetadataBytes = 1 * 1024 * 1024;
const maximumDatapackIconBytes = 512 * 1024;
const maximumDatapackDescriptionLength = 2_000;

export interface DatapackMetadata {
  readonly description?: string;
  readonly iconDataUrl?: string;
}

interface DatapackFiles {
  readonly metadata?: Uint8Array;
  readonly icon?: Uint8Array;
}
/** 读取数据包根目录元数据；压缩包损坏时保留数据包条目但不发布元数据。 */
export async function readDatapackMetadata(
  entryPath: string,
  kind: ServerWorldDatapackKind,
): Promise<DatapackMetadata> {
  try {
    const files =
      kind === "archive" ? await readArchiveFiles(entryPath) : await readDirectoryFiles(entryPath);
    const description = parseDescription(files.metadata);
    const iconDataUrl = parseIcon(files.icon);
    return {
      ...(description ? { description } : {}),
      ...(iconDataUrl ? { iconDataUrl } : {}),
    };
  } catch {
    return {};
  }
}

async function readDirectoryFiles(entryPath: string): Promise<DatapackFiles> {
  const metadata = await readFile(join(entryPath, "pack.mcmeta"));
  let icon: Uint8Array | undefined;
  try {
    icon = await readFile(join(entryPath, "pack.png"));
  } catch {
    // pack.png 是可选图标。
  }
  return { metadata, ...(icon ? { icon } : {}) };
}

async function readArchiveFiles(entryPath: string): Promise<DatapackFiles> {
  const archive = await readFile(entryPath);
  if (archive.byteLength > maximumDatapackArchiveBytes) return {};
  let entryCount = 0;
  const entries = unzipSync(archive, {
    filter: (file) => {
      entryCount += 1;
      if (file.name !== "pack.mcmeta" && file.name !== "pack.png") return false;
      const maximumSize =
        file.name === "pack.mcmeta" ? maximumDatapackMetadataBytes : maximumDatapackIconBytes;
      return file.originalSize <= maximumSize;
    },
  });
  if (entryCount > maximumDatapackArchiveEntries) return {};
  const metadata = entries["pack.mcmeta"];
  const icon = entries["pack.png"];
  return {
    ...(metadata ? { metadata } : {}),
    ...(icon ? { icon } : {}),
  };
}

function parseDescription(value: Uint8Array | undefined): string | undefined {
  if (!value || value.byteLength > maximumDatapackMetadataBytes) return undefined;
  try {
    const root = asRecord(JSON.parse(strFromU8(value)));
    const pack = asRecord(root?.pack);
    const text = normalizeDescription(textComponentToString(pack?.description));
    return text;
  } catch {
    return undefined;
  }
}

function parseIcon(value: Uint8Array | undefined): string | undefined {
  if (!value || value.byteLength > maximumDatapackIconBytes) return undefined;
  const mimeType = detectImageMimeType(value);
  return mimeType ? `data:${mimeType};base64,${Buffer.from(value).toString("base64")}` : undefined;
}

function textComponentToString(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return textComponentToString(JSON.parse(trimmed));
      } catch {
        // 普通介绍文字可能恰好以大括号开头，继续按原文处理。
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(textComponentToString).join("");
  const record = asRecord(value);
  if (!record) return "";
  const direct =
    typeof record.text === "string"
      ? record.text
      : typeof record.translate === "string"
        ? record.translate
        : "";
  const withText = Array.isArray(record.with)
    ? record.with.map(textComponentToString).join("")
    : "";
  const extra = Array.isArray(record.extra) ? record.extra.map(textComponentToString).join("") : "";
  return `${direct}${withText}${extra}`;
}

function normalizeDescription(value: string): string | undefined {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maximumDatapackDescriptionLength
    ? normalized
    : `${normalized.slice(0, maximumDatapackDescriptionLength - 1)}…`;
}

function detectImageMimeType(
  value: Uint8Array,
): "image/png" | "image/gif" | "image/jpeg" | "image/webp" | undefined {
  if (
    value.byteLength >= 8 &&
    value[0] === 0x89 &&
    value[1] === 0x50 &&
    value[2] === 0x4e &&
    value[3] === 0x47 &&
    value[4] === 0x0d &&
    value[5] === 0x0a &&
    value[6] === 0x1a &&
    value[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    value.byteLength >= 6 &&
    value[0] === 0x47 &&
    value[1] === 0x49 &&
    value[2] === 0x46 &&
    value[3] === 0x38 &&
    (value[4] === 0x37 || value[4] === 0x39) &&
    value[5] === 0x61
  ) {
    return "image/gif";
  }
  if (value.byteLength >= 2 && value[0] === 0xff && value[1] === 0xd8) return "image/jpeg";
  if (
    value.byteLength >= 12 &&
    value[0] === 0x52 &&
    value[1] === 0x49 &&
    value[2] === 0x46 &&
    value[3] === 0x46 &&
    value[8] === 0x57 &&
    value[9] === 0x45 &&
    value[10] === 0x42 &&
    value[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
