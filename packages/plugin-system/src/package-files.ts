import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { parsePluginManifest } from "./manifest";
import type { InstallCandidate, PackageFile } from "./types";

const maximumFileCount = 4_096;
const maximumFileSize = 32 * 1024 * 1024;
const maximumPackageSize = 128 * 1024 * 1024;
const maximumManifestSize = 256 * 1024;

export async function inspectPackageDirectory(
  sourceRoot: string,
  seaShardVersion: string,
): Promise<InstallCandidate> {
  const root = await realpath(sourceRoot);
  const state = { files: [] as PackageFile[], totalSize: 0 };
  await walk(root, root, state);
  const files = state.files;
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const manifestFile = files.find((file) => file.relativePath === "plugin.json");
  if (!manifestFile) throw new Error("plugin package does not contain plugin.json");
  if (manifestFile.size > maximumManifestSize) throw new Error("plugin.json exceeds 256 KiB");

  const manifest = parsePluginManifest(
    JSON.parse(await readFile(manifestFile.absolutePath, "utf8")) as unknown,
    seaShardVersion,
  );
  const paths = new Set(files.map((file) => file.relativePath));
  for (const entry of manifest.entries) {
    const modulePath = entry.module.slice(2);
    if (!paths.has(modulePath)) {
      throw new Error(`plugin entry module is missing: ${entry.id} -> ${entry.module}`);
    }
  }

  return {
    manifest,
    digest: await digestFiles(files),
    sourceRoot: root,
    files,
  };
}

async function walk(
  root: string,
  directory: string,
  state: { files: PackageFile[]; totalSize: number },
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    const relativePath = normalizeRelativePath(relative(root, absolutePath));
    const status = await lstat(absolutePath);
    if (status.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${relativePath}`);
    if (status.isDirectory()) {
      await walk(root, absolutePath, state);
      continue;
    }
    if (!status.isFile()) throw new Error(`unsupported package entry: ${relativePath}`);
    if (status.size > maximumFileSize)
      throw new Error(`plugin file exceeds 32 MiB: ${relativePath}`);
    state.files.push({ relativePath, absolutePath, size: status.size });
    state.totalSize += status.size;
    if (state.files.length > maximumFileCount) throw new Error("plugin package exceeds 4096 files");
    if (state.totalSize > maximumPackageSize) {
      throw new Error("plugin package exceeds 128 MiB unpacked");
    }
  }
}

async function digestFiles(files: readonly PackageFile[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath, "utf8");
    hash.update("\0");
    hash.update(String(file.size), "utf8");
    hash.update("\0");
    await new Promise<void>((resolvePromise, reject) => {
      const input = createReadStream(file.absolutePath);
      input.on("data", (chunk) => hash.update(chunk));
      input.once("error", reject);
      input.once("end", resolvePromise);
    });
    hash.update("\0");
  }
  return hash.digest("hex");
}

function normalizeRelativePath(value: string): string {
  const normalized = sep === "/" ? value : value.split(sep).join("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe package path: ${value}`);
  }
  return normalized;
}
