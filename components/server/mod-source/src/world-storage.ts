import { unzipSync } from "fflate";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const maximumWorldArchiveEntries = 250_000;
const maximumWorldArchiveBytes = 8 * 1024 * 1024 * 1024;

/** 将普通世界压缩包安全解压到 staging 目录，并剥离常见的单层外包目录。 */
export async function extractWorldArchive(archivePath: string, stagingRoot: string): Promise<void> {
  const archive = await readFile(archivePath);
  const entries = unzipSync(archive);
  const names = Object.keys(entries);
  if (names.length > maximumWorldArchiveEntries) {
    throw new Error("世界存档文件数量超过限制");
  }

  const normalizedEntries = names
    .filter((name) => !name.endsWith("/"))
    .map((name) => ({ name, path: normalizeArchivePath(name), data: entries[name]! }));
  const levelRoots = normalizedEntries
    .filter(({ path }) => path === "level.dat" || path.endsWith("/level.dat"))
    .map(({ path }) => {
      const root = dirname(path).replaceAll("\\", "/");
      return root === "." ? "" : root;
    });
  const rootPrefix = chooseWorldRoot(levelRoots);
  let totalBytes = 0;

  await mkdir(stagingRoot, { recursive: true });
  for (const entry of normalizedEntries) {
    if (rootPrefix && entry.path !== rootPrefix && !entry.path.startsWith(`${rootPrefix}/`)) {
      continue;
    }
    const outputPath = rootPrefix ? entry.path.slice(rootPrefix.length + 1) : entry.path;
    const destination = resolve(stagingRoot, ...outputPath.split("/"));
    const child = relative(resolve(stagingRoot), destination);
    if (!child || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error(`世界存档路径越界：${entry.name}`);
    }
    totalBytes += entry.data.byteLength;
    if (totalBytes > maximumWorldArchiveBytes) {
      throw new Error("世界存档解压后超过大小限制");
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.data, { flag: "wx" });
  }

  try {
    await readFile(resolve(stagingRoot, "level.dat"));
  } catch {
    throw new Error("世界存档缺少 level.dat");
  }
}

function chooseWorldRoot(levelRoots: readonly string[]): string {
  const uniqueRoots = [...new Set(levelRoots)];
  if (uniqueRoots.includes("")) return "";
  const topLevelRoots = [...new Set(uniqueRoots.map((root) => root.split("/")[0]!))];
  if (topLevelRoots.length !== 1) {
    throw new Error("世界存档必须只包含一个世界根目录");
  }
  const prefix = topLevelRoots[0]!;
  if (!uniqueRoots.every((root) => root === prefix || root.startsWith(`${prefix}/`))) {
    throw new Error("世界存档包含多个世界根目录");
  }
  return prefix;
}

function normalizeArchivePath(value: string): string {
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new Error(`世界存档路径不安全：${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`世界存档路径不安全：${value}`);
  }
  return segments.join("/");
}
