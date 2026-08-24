import type {
  ClientTarget,
  CpuArchitecture,
  GlobalPluginBindingInput,
  HostProfile,
  OperatingSystem,
  PluginBinding,
  PluginManifest,
} from "@seashard/plugin-sdk";
import { createHash } from "node:crypto";
import { parseInternalPluginManifest } from "./manifest";
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
  private readonly registeredBuiltInPluginIds = new Set<string>();

  constructor(
    private readonly store: PluginStore,
    private readonly seaShardVersion: string,
  ) {}

  async registerBuiltIn(registration: BuiltInPackageRegistration): Promise<PluginPackageRecord> {
    const manifest = parseInternalPluginManifest(registration.manifest, this.seaShardVersion);
    for (const entry of manifest.entries) {
      if (entry.runtime === "host" && !registration.loaders[entry.id]) {
        throw new Error(`missing built-in loader: ${manifest.id}/${entry.id}`);
      }
    }
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
    await this.store.registerPackage(record);
    await this.store.setCurrentVersion(manifest.id, manifest.version, digest);

    for (const entry of manifest.entries) {
      const loader = registration.loaders[entry.id];
      if (loader) this.builtInLoaders.set(`${manifest.id}/${entry.id}`, loader);
    }
    for (const binding of registration.bindings) {
      await this.upsertBinding({ ...binding, pluginId: manifest.id });
    }
    this.registeredBuiltInPluginIds.add(manifest.id);
    return record;
  }

  /**
   * 让持久化的内建插件集合服从本次宿主实际注册的编译期清单。
   *
   * 内建插件没有独立安装来源；代码中已经移除的 Provider 不应继续留下 Binding，
   * 否则重启后会反复生成“loader missing”的失败 Runtime。
   */
  async synchronizeBuiltIns(): Promise<void> {
    const retired = (await this.store.listCurrentPackages()).filter(
      (record) =>
        record.source === "builtin" && !this.registeredBuiltInPluginIds.has(record.manifest.id),
    );

    for (const record of retired) {
      for (const binding of await this.store.listBindings(record.manifest.id)) {
        await this.store.deleteBinding(binding.id);
      }
      await this.store.clearCurrentVersion(record.manifest.id);
      for (const stored of await this.store.listPackages(record.manifest.id)) {
        if (stored.source === "builtin") {
          await this.store.removePackage(
            stored.manifest.id,
            stored.manifest.version,
            stored.digest,
          );
        }
      }
    }
  }

  getBuiltInLoader(pluginId: string, entryId: string): BuiltInModuleLoader | undefined {
    return this.builtInLoaders.get(`${pluginId}/${entryId}`);
  }

  selectPackageVersion(record: PluginPackageRecord): Promise<void> {
    return this.store.setCurrentVersion(record.manifest.id, record.manifest.version, record.digest);
  }

  clearPackageSelection(pluginId: string): Promise<void> {
    return this.store.clearCurrentVersion(pluginId);
  }

  /**
   * 第三方管理入口不接收 Scope；内部统一补成全局 Binding。
   * 内建组件继续通过 upsertBinding 使用原有范围模型。
   */
  upsertGlobalBinding(binding: GlobalPluginBindingInput): Promise<void> {
    return this.upsertBinding({
      ...binding,
      scopeType: "global",
      scopeId: "global",
    });
  }

  async upsertBinding(binding: PluginBinding): Promise<void> {
    if (!bindingIdPattern.test(binding.id)) {
      throw new Error(`invalid plugin binding id: ${binding.id}`);
    }
    const current = (await this.store.listCurrentPackages()).find(
      (record) => record.manifest.id === binding.pluginId,
    );
    if (!current) throw new Error(`plugin is not selected: ${binding.pluginId}`);
    const entry = current.manifest.entries.find((candidate) => candidate.id === binding.entryId);
    if (!entry) {
      throw new Error(`plugin entry does not exist: ${binding.pluginId}/${binding.entryId}`);
    }
    if (!entry.activationScopes.includes(binding.scopeType)) {
      throw new Error(
        `entry ${binding.pluginId}/${binding.entryId} does not support ${binding.scopeType} scope`,
      );
    }
    if (binding.scopeType === "global" && binding.scopeId !== "global") {
      throw new Error("global plugin bindings must use scopeId 'global'");
    }
    JSON.stringify(binding.config);
    await this.store.upsertBinding(binding);
  }

  deleteBinding(bindingId: string): Promise<void> {
    return this.store.deleteBinding(bindingId);
  }

  listBindings(pluginId?: string): Promise<PluginBinding[]> {
    return this.store.listBindings(pluginId);
  }

  async resolve(options: {
    hostProfile: HostProfile;
    clientTarget?: ClientTarget;
    platform: OperatingSystem;
    architecture: CpuArchitecture;
  }): Promise<ResolvedEntry[]> {
    const packages = new Map(
      (await this.store.listCurrentPackages()).map((record) => [record.manifest.id, record]),
    );
    const issues: string[] = [];
    const entries: ResolvedEntry[] = [];
    const runtimeIds = new Set<string>();

    for (const binding of await this.store.listBindings()) {
      if (!binding.enabled) continue;
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

  listPackages(pluginId?: string): Promise<PluginPackageRecord[]> {
    return this.store.listPackages(pluginId);
  }

  listCurrentPackages(): Promise<PluginPackageRecord[]> {
    return this.store.listCurrentPackages();
  }
}

export function createBuiltInManifest(input: PluginManifest): PluginManifest {
  return input;
}
