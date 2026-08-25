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

const maximumPluginBindingIdLength = 264;
const bindingIdPattern = /^[a-z0-9](?:[a-z0-9._:@/-]*[a-z0-9])?$/;

/**
 * 自动 Binding 使用 Manifest ID 不允许出现的冒号分隔各段，因此 Plugin/Entry ID
 * 即使包含点号也不会产生拼接歧义。264 是两个最长 Manifest ID 加 installed 前缀的上界。
 */
export function automaticPluginBindingPrefix(
  namespace: "dev" | "plugin",
  pluginId: string,
): string {
  return `${namespace}:${pluginId}:`;
}

export function automaticPluginBindingId(
  namespace: "dev" | "plugin",
  pluginId: string,
  entryId: string,
): string {
  return `${automaticPluginBindingPrefix(namespace, pluginId)}${entryId}`;
}

export class PluginResolutionError extends Error {
  readonly name = "PluginResolutionError";

  constructor(readonly issues: readonly string[]) {
    super(`plugin resolution failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  }
}

interface DevelopmentPackageRegistration {
  readonly record: PluginPackageRecord;
  readonly bindings: readonly PluginBinding[];
}

export class PluginRegistry {
  private readonly builtInLoaders = new Map<string, BuiltInModuleLoader>();
  private readonly registeredBuiltInPluginIds = new Set<string>();
  private readonly developmentPackages = new Map<string, DevelopmentPackageRegistration>();

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
   * 预先校验整套 Binding，再把包选择和自动 Binding 集合作为一个数据库事务提交。
   * bindingPrefix 只标识 Host 生成的自动 Binding，插件自定义 Binding 不参与替换。
   */
  replacePackageSelectionAndBindings(
    pluginId: string,
    record: PluginPackageRecord | undefined,
    bindingPrefix: string,
    bindings: readonly PluginBinding[],
  ): Promise<void> {
    if (record?.manifest.id !== pluginId) {
      if (record) {
        throw new Error(
          `plugin package selection mismatch: expected ${pluginId}, received ${record.manifest.id}`,
        );
      }
      if (bindings.length) {
        throw new Error(`cannot restore plugin bindings without a selected package: ${pluginId}`);
      }
    }
    if (!bindingPrefix) throw new Error(`plugin automatic binding prefix is empty: ${pluginId}`);
    for (const binding of bindings) {
      if (!binding.id.startsWith(bindingPrefix)) {
        throw new Error(`plugin automatic binding uses unexpected id: ${binding.id}`);
      }
      assertBinding(record!, binding);
    }
    return this.store.replaceCurrentPackageBindings(pluginId, record, bindingPrefix, bindings);
  }

  /**
   * 用当前进程内的开发包覆盖同 ID 的持久化选择和 Binding。
   *
   * 开发覆盖不写数据库；Host 正常退出、崩溃或被强制结束后都不会留下开发记录。
   * Manifest 重新注册时一次替换包记录和全部 Entry Binding，避免旧 Entry 残留。
   */
  setDevelopmentPackage(record: PluginPackageRecord, previousPluginId?: string): void {
    if (record.source !== "development") {
      throw new Error(`development package must use development source: ${record.manifest.id}`);
    }
    const bindings = record.manifest.entries.map((entry): PluginBinding => ({
      id: automaticPluginBindingId("dev", record.manifest.id, entry.id),
      pluginId: record.manifest.id,
      entryId: entry.id,
      scopeType: "global",
      scopeId: "global",
      enabled: true,
      // 第三方插件应以空启动配置运行，并通过自身 Storage 或公开配置 Service 管理设置。
      config: {},
    }));
    for (const binding of bindings) assertBinding(record, binding);
    if (previousPluginId && previousPluginId !== record.manifest.id) {
      this.developmentPackages.delete(previousPluginId);
    }
    this.developmentPackages.set(record.manifest.id, { record, bindings });
  }

  clearDevelopmentPackages(): void {
    this.developmentPackages.clear();
  }

  /**
   * 第三方管理入口不接收 Scope；内部统一补成全局 Binding。
   * `plugin:` 与 `dev:` 由 Host 的整套自动替换流程独占，避免自定义 Binding 被覆盖或误删。
   */
  async upsertGlobalBinding(binding: GlobalPluginBindingInput): Promise<void> {
    if (binding.id.startsWith("plugin:") || binding.id.startsWith("dev:")) {
      throw new Error(`plugin binding id uses a reserved automatic namespace: ${binding.id}`);
    }
    await this.upsertBinding({
      ...binding,
      scopeType: "global",
      scopeId: "global",
    });
  }

  async upsertBinding(binding: PluginBinding): Promise<void> {
    const current = (await this.store.listCurrentPackages()).find(
      (record) => record.manifest.id === binding.pluginId,
    );
    if (!current) throw new Error(`plugin is not selected: ${binding.pluginId}`);
    assertBinding(current, binding);
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
    for (const development of this.developmentPackages.values()) {
      packages.set(development.record.manifest.id, development.record);
    }
    const persistentBindings = (await this.store.listBindings()).filter(
      (binding) => !this.developmentPackages.has(binding.pluginId),
    );
    const bindings = [
      ...persistentBindings,
      ...[...this.developmentPackages.values()].flatMap((development) =>
        development.bindings.map((binding) => ({ ...binding })),
      ),
    ];
    const issues: string[] = [];
    const entries: ResolvedEntry[] = [];
    const runtimeIds = new Set<string>();

    for (const binding of bindings) {
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

function assertBinding(record: PluginPackageRecord, binding: PluginBinding): void {
  if (binding.id.length > maximumPluginBindingIdLength || !bindingIdPattern.test(binding.id)) {
    throw new Error(`invalid plugin binding id: ${binding.id}`);
  }
  if (record.manifest.id !== binding.pluginId) {
    throw new Error(
      `plugin binding ${binding.id} targets ${binding.pluginId}, expected ${record.manifest.id}`,
    );
  }
  const entry = record.manifest.entries.find((candidate) => candidate.id === binding.entryId);
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
}

export function createBuiltInManifest(input: PluginManifest): PluginManifest {
  return input;
}
