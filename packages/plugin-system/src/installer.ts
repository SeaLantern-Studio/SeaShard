import type { PluginPackageRecord } from "./types";
import type { TrustGrant } from "./types";
import { unzipSync } from "fflate";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { inspectPackageDirectory } from "./package-files";
import { PluginStore } from "./store";

const maximumArchiveSize = 32 * 1024 * 1024;
const maximumUnpackedSize = 128 * 1024 * 1024;
const maximumFileCount = 4_096;

export interface PreparedPluginInstall {
  readonly manifest: PluginPackageRecord["manifest"];
  readonly digest: string;
  commit(grant: TrustGrant): Promise<PluginPackageRecord>;
  dispose(): Promise<void>;
}

export class PluginInstaller {
  private readonly installRoot: string;
  private readonly stagingRoot: string;

  constructor(
    private readonly store: PluginStore,
    dataRoot: string,
    private readonly seaShardVersion: string,
  ) {
    this.installRoot = join(dataRoot, "plugins");
    this.stagingRoot = join(dataRoot, "staging");
  }

  async registerDevelopmentDirectory(
    sourceRoot: string,
    grant: TrustGrant,
  ): Promise<PluginPackageRecord> {
    const candidate = await inspectPackageDirectory(sourceRoot, this.seaShardVersion);
    assertTrust(candidate.digest, grant);
    const record: PluginPackageRecord = {
      manifest: candidate.manifest,
      digest: candidate.digest,
      rootPath: candidate.sourceRoot,
      source: "development",
      trust: "local-full-trust",
      installedAt: new Date().toISOString(),
    };
    this.store.registerPackage(record);
    this.store.grantTrust(record);
    return record;
  }

  async inspectDevelopmentDirectory(sourceRoot: string) {
    return inspectPackageDirectory(sourceRoot, this.seaShardVersion);
  }

  async prepareArchive(archivePath: string): Promise<PreparedPluginInstall> {
    await mkdir(this.stagingRoot, { recursive: true });
    const archive = await readFile(archivePath);
    if (archive.byteLength > maximumArchiveSize) {
      throw new Error("plugin archive exceeds 32 MiB");
    }

    const staging = join(
      this.stagingRoot,
      `plugin-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(staging, { recursive: false });
    try {
      await extractArchive(archive, staging);
      const candidate = await inspectPackageDirectory(staging, this.seaShardVersion);
      let settled = false;
      return {
        manifest: candidate.manifest,
        digest: candidate.digest,
        commit: async (grant) => {
          if (settled) throw new Error("prepared plugin install has already been settled");
          assertTrust(candidate.digest, grant);
          settled = true;
          const finalRoot = join(
            this.installRoot,
            candidate.manifest.id,
            candidate.manifest.version,
            candidate.digest,
          );
          try {
            await mkdir(dirname(finalRoot), { recursive: true });
            if (await directoryExists(finalRoot)) {
              await rm(staging, { recursive: true, force: true });
            } else {
              await rename(staging, finalRoot);
            }
            const record: PluginPackageRecord = {
              manifest: candidate.manifest,
              digest: candidate.digest,
              rootPath: finalRoot,
              source: "installed",
              trust: "package-full-trust",
              installedAt: new Date().toISOString(),
            };
            this.store.registerPackage(record);
            this.store.grantTrust(record);
            return record;
          } catch (error) {
            await rm(staging, { recursive: true, force: true });
            throw error;
          }
        },
        dispose: async () => {
          if (settled) return;
          settled = true;
          await rm(staging, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async uninstall(pluginId: string, version: string, digest: string): Promise<void> {
    const record = this.store.getPackage(pluginId, version, digest);
    if (!record) return;
    if (record.source !== "installed") {
      throw new Error(
        `only immutable installed packages can be uninstalled: ${pluginId}@${version}`,
      );
    }
    const root = await realpath(record.rootPath);
    const installRoot = await realpath(this.installRoot);
    const child = relative(installRoot, root);
    if (!child || child.startsWith("..") || isAbsolute(child)) {
      throw new Error(`refusing to remove path outside plugin store: ${root}`);
    }
    this.store.removePackage(pluginId, version, digest);
    await rm(root, { recursive: true, force: true });
  }
}

async function extractArchive(archive: Uint8Array, targetRoot: string): Promise<void> {
  const entries = unzipSync(archive);
  const names = Object.keys(entries).sort((left, right) => left.localeCompare(right));
  if (names.length > maximumFileCount) throw new Error("plugin archive exceeds 4096 files");

  let total = 0;
  for (const name of names) {
    const data = entries[name];
    if (name.endsWith("/")) continue;
    const relativePath = normalizeArchivePath(name);
    total += data.byteLength;
    if (total > maximumUnpackedSize) throw new Error("plugin archive exceeds 128 MiB unpacked");
    const destination = resolve(targetRoot, ...relativePath.split("/"));
    const child = relative(targetRoot, destination);
    if (!child || child.startsWith("..") || isAbsolute(child)) {
      throw new Error(`archive path escapes target: ${name}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data, { flag: "wx" });
  }
}

function normalizeArchivePath(value: string): string {
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new Error(`unsafe archive path: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`unsafe archive path: ${value}`);
  }
  return segments.join("/");
}

function assertTrust(digest: string, grant: TrustGrant): void {
  if (!grant.acknowledgeFullMachineAccess || grant.digest !== digest) {
    throw new Error("full-machine-access trust must be granted for this exact package digest");
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await realpath(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
