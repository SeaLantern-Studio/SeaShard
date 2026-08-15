import type {
  ClientTarget,
  CpuArchitecture,
  HostProfile,
  OperatingSystem,
  PluginBinding,
  PluginManifest,
} from "@seashard/plugin-sdk";
import { createHash } from "node:crypto";
import { parsePluginManifest } from "./manifest";
import { PluginStore } from "./store";
import type {
  BuiltInModuleLoader,
  BuiltInPackageRegistration,
  PluginPackageRecord,
  ResolvedEntry,
} from "./types";

const bindingIdPattern = /^[a-z0-9](?:[a-z0-9._:@/-]{0,254}[a-z0-9])?$/;

export class PluginResolutionError extends Error {
  readonly name = "PluginResolutionError";

  constructor(readonly issues: readonly string[]) {
    super(`plugin resolution failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  }
}

export class PluginRegistry {
  private readonly builtInLoaders = new Map<string, BuiltInModuleLoader>();

  constructor(
    private readonly store: PluginStore,
    private readonly seaShardVersion: string,
  ) {}

  registerBuiltIn(registration: BuiltInPackageRegistration): PluginPackageRecord {
    const manifest = parsePluginManifest(registration.manifest, this.seaShardVersion);
    const digest = createHash("sha256")
      .update(JSON.stringify(manifest))
      .update("\0builtin")
      .digest("hex");
    const record: PluginPackageRecord = {
      manifest,
      digest,
      rootPath: `builtin:${manifest.id}`,
      source: "builtin",
      trust: "builtin",
      installedAt: new Date().toISOString(),
    };
    this.store.registerPackage(record);
    this.store.setCurrentVersion(manifest.id, manifest.version, digest);

    for (const entry of manifest.entries) {
      const loader = registration.loaders[entry.id];
      if (!loader) throw new Error(`missing built-in loader: ${manifest.id}/${entry.id}`);
      this.builtInLoaders.set(`${manifest.id}/${entry.id}`, loader);
    }
    for (const binding of registration.bindings) {
      this.upsertBinding({ ...binding, pluginId: manifest.id });
    }
    return record;
  }

  getBuiltInLoader(pluginId: string, entryId: string): BuiltInModuleLoader | undefined {
    return this.builtInLoaders.get(`${pluginId}/${entryId}`);
  }
  selectPackageVersion(record: PluginPackageRecord): void {
    this.store.setCurrentVersion(record.manifest.id, record.manifest.version, record.digest);
  }
  clearPackageSelection(pluginId: string): void {
    this.store.clearCurrentVersion(pluginId);
  }

  upsertBinding(binding: PluginBinding): void {
    if (!bindingIdPattern.test(binding.id))
      throw new Error(`invalid plugin binding id: ${binding.id}`);
    const current = this.store
      .listCurrentPackages()
      .find((record) => record.manifest.id === binding.pluginId);
    if (!current) throw new Error(`plugin is not selected: ${binding.pluginId}`);
    const entry = current.manifest.entries.find((candidate) => candidate.id === binding.entryId);
    if (!entry)
      throw new Error(`plugin entry does not exist: ${binding.pluginId}/${binding.entryId}`);
    if (!entry.activationScopes.includes(binding.scopeType)) {
      throw new Error(
        `entry ${binding.pluginId}/${binding.entryId} does not support ${binding.scopeType} scope`,
      );
    }
    if (binding.scopeType === "global" && binding.scopeId !== "global") {
      throw new Error("global plugin bindings must use scopeId 'global'");
    }
    JSON.stringify(binding.config);
    this.store.upsertBinding(binding);
  }

  deleteBinding(bindingId: string): void {
    this.store.deleteBinding(bindingId);
  }

  listBindings(pluginId?: string): PluginBinding[] {
    return this.store.listBindings(pluginId);
  }

  resolve(options: {
    hostProfile: HostProfile;
    clientTarget?: ClientTarget;
    platform: OperatingSystem;
    architecture: CpuArchitecture;
  }): ResolvedEntry[] {
    const packages = new Map(
      this.store.listCurrentPackages().map((record) => [record.manifest.id, record]),
    );
    const issues: string[] = [];
    const entries: ResolvedEntry[] = [];
    const runtimeIds = new Set<string>();

    for (const binding of this.store.listBindings()) {
      const record = packages.get(binding.pluginId);
      if (!record) {
        issues.push(`binding ${binding.id} references unavailable plugin ${binding.pluginId}`);
        continue;
      }
      const entry = record.manifest.entries.find((candidate) => candidate.id === binding.entryId);
      if (!entry) {
        issues.push(
          `binding ${binding.id} references unavailable entry ${binding.pluginId}/${binding.entryId}`,
        );
        continue;
      }
      if (!entry.activationScopes.includes(binding.scopeType)) {
        issues.push(`binding ${binding.id} uses unsupported ${binding.scopeType} scope`);
        continue;
      }
      if (entry.os && !entry.os.includes(options.platform)) continue;
      if (entry.arch && !entry.arch.includes(options.architecture)) continue;
      if (entry.runtime === "host" && !entry.hostProfiles?.includes(options.hostProfile)) continue;
      if (
        entry.runtime === "client" &&
        (!options.clientTarget || !entry.targets?.includes(options.clientTarget))
      ) {
        continue;
      }
      if (runtimeIds.has(binding.id)) {
        issues.push(`duplicate runtime id derived from binding ${binding.id}`);
        continue;
      }
      runtimeIds.add(binding.id);
      entries.push({
        package: record,
        entry,
        binding,
        runtimeId: binding.id,
        host:
          entry.runtime === "client"
            ? "client"
            : record.source === "builtin"
              ? "core"
              : "node-plugin-host",
      });
    }

    if (issues.length) throw new PluginResolutionError(issues);
    return entries.sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
  }

  listPackages(pluginId?: string): PluginPackageRecord[] {
    return this.store.listPackages(pluginId);
  }

  listCurrentPackages(): PluginPackageRecord[] {
    return this.store.listCurrentPackages();
  }
}

export function createBuiltInManifest(input: PluginManifest): PluginManifest {
  return input;
}
