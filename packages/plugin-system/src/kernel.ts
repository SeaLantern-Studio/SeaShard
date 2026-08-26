import type {
  ClientServiceCallRequest,
  PluginManagementEntrySnapshot,
  PluginManagementSnapshot,
} from "@seashard/contracts";
import type {
  ExecutionContext,
  GlobalPluginBindingInput,
  JsonValue,
  PluginBinding,
  PluginStorageBroker,
  RuntimeControlSnapshot,
  ScopeAddress,
  ServiceProvider,
  ServiceProvideOptions,
} from "@seashard/plugin-sdk";
import { Context } from "cordis";
import { mkdir } from "node:fs/promises";
import { PluginInstaller } from "./installer";
import { automaticPluginBindingId, automaticPluginBindingPrefix, PluginRegistry } from "./registry";
import {
  PluginRuntime,
  type PluginRuntimeAdapter,
  type PluginRuntimeLifecycleRecord,
} from "./runtime";
import {
  authorizeEntryServiceCall,
  PluginRuntimeBackend as DefaultPluginRuntimeBackend,
} from "./runtime-backend";
import {
  AgentResourceRegistry,
  AgentProviderTypeRegistry,
  AgentToolRegistry,
  ContributionRegistry,
  PluginEventBus,
  ServiceRegistry,
  type ServiceCallAuthorizer,
} from "./runtime-registries";
import { PluginStore } from "./store";
import type {
  BuiltInPackageRegistration,
  PluginPackageRecord,
  ResolvedClientEntrySnapshot,
  ResolvedEntry,
} from "./types";

export interface PluginKernelOptions {
  dataRoot: string;
  seaShardVersion: string;
  pluginHostEntry: string;
  hostProfile: "electron" | "node" | "docker";
  clientTarget?: "desktop" | "web" | "mobile";
  platform: "win32" | "darwin" | "linux" | "aix" | "freebsd" | "openbsd" | "sunos";
  architecture: "x64" | "arm64" | "ia32" | "arm" | "riscv64" | "ppc64" | "s390x";
  root: Context;
  store: PluginStore;
  pluginStorage: PluginStorageBroker;
}

export class PluginKernel {
  readonly installer: PluginInstaller;
  readonly registry: PluginRegistry;
  readonly services = new ServiceRegistry();
  readonly agentTools = new AgentToolRegistry();
  readonly agentResources = new AgentResourceRegistry();
  readonly agentProviderTypes = new AgentProviderTypeRegistry();
  readonly contributions = new ContributionRegistry();
  readonly events = new PluginEventBus();

  private readonly runtime: PluginRuntime;
  private readonly coreDisposers: Array<() => void> = [];
  private readonly clientEntryListeners = new Set<
    (snapshot: ResolvedClientEntrySnapshot) => void
  >();
  private clientEntries: ResolvedEntry[] = [];
  private clientEntryFingerprint = "";
  private clientEntryRevision = 0;
  private disposeTask?: Promise<void>;

  private constructor(
    private readonly options: PluginKernelOptions,
    readonly store: PluginStore,
  ) {
    this.installer = new PluginInstaller(this.store, options.dataRoot, options.seaShardVersion);
    this.registry = new PluginRegistry(this.store, options.seaShardVersion);
    let runtime: PluginRuntime;
    const backend: PluginRuntimeAdapter = new DefaultPluginRuntimeBackend(
      options.root,
      this.registry,
      {
        services: this.services,
        agentTools: this.agentTools,
        agentProviderTypes: this.agentProviderTypes,
        agentResources: this.agentResources,
        contributions: this.contributions,
        events: this.events,
        storage: options.pluginStorage,
      },
      options.pluginHostEntry,
      (runtimeId, error) => {
        void runtime.runtimeFailed(runtimeId, error);
      },
    );
    runtime = new PluginRuntime(backend, (error) => {
      console.error("plugin runtime failed", error);
    });
    this.runtime = runtime;
  }

  static async create(options: PluginKernelOptions): Promise<PluginKernel> {
    await mkdir(options.dataRoot, { recursive: true });
    return new PluginKernel(options, options.store);
  }

  registerBuiltIn(registration: BuiltInPackageRegistration): Promise<PluginPackageRecord> {
    return this.registry.registerBuiltIn(registration);
  }

  registerCoreService(
    contract: string,
    provider: ServiceProvider,
    options?: ServiceProvideOptions,
  ): void {
    const dispose = this.services.register(
      contract,
      "seashard.core",
      globalScope(),
      provider,
      options,
    );
    this.coreDisposers.push(dispose);
  }

  restrictServiceCalls(contract: string, authorize: ServiceCallAuthorizer): void {
    this.coreDisposers.push(this.services.restrict(contract, authorize));
  }

  prepareDirectory(sourceRoot: string) {
    return this.installer.prepareDirectory(sourceRoot);
  }

  /**
   * 将开发目录重新校验为进程内覆盖，并按最新 Manifest 重建全部开发 Binding。
   *
   * 该路径不写 PluginStore；每次文件变化都会产生新摘要，从而让 Runtime 的正常
   * reconcile 完成停旧、启新和权限刷新。
   */
  async refreshDevelopmentDirectory(
    sourceRoot: string,
    previousPluginId?: string,
  ): Promise<PluginPackageRecord> {
    const candidate = await this.installer.inspectDevelopmentDirectory(sourceRoot);
    const record = this.installer.createDevelopmentRecord(candidate, {
      digest: candidate.digest,
      acknowledgeFullMachineAccess: true,
    });
    this.registry.setDevelopmentPackage(record, previousPluginId);
    await this.reconcile();
    return record;
  }

  prepareArchive(archivePath: string) {
    return this.installer.prepareArchive(archivePath);
  }

  prepareArchiveBytes(archive: Uint8Array) {
    return this.installer.prepareArchiveBytes(archive);
  }

  upsertBinding(binding: GlobalPluginBindingInput): Promise<void> {
    return this.registry.upsertGlobalBinding(binding);
  }

  deleteBinding(bindingId: string): Promise<void> {
    return this.registry.deleteBinding(bindingId);
  }

  async selectPackageVersion(record: PluginPackageRecord): Promise<void> {
    const previous = await this.currentPackage(record.manifest.id);
    await this.registry.selectPackageVersion(record);
    try {
      await this.reconcile();
      await this.assertSelectedHostBindingsActive(record);
    } catch (error) {
      await this.restorePackageSelection(record.manifest.id, previous);
      await this.reconcile();
      throw error;
    }
  }

  /**
   * 安装命令选中包版本后，为每个 Entry 建立稳定的全局 Binding 并立即激活。
   *
   * 插件的用户设置由插件自己的 Storage 或配置 Service 管理，因此初始 Binding
   * 只携带空对象。激活失败时同时恢复旧选择和原自动 Binding。
   */
  async selectPackageVersionAndEnable(record: PluginPackageRecord): Promise<void> {
    const previous = await this.currentPackage(record.manifest.id);
    const prefix = automaticPluginBindingPrefix("plugin", record.manifest.id);
    const previousBindings = (await this.registry.listBindings(record.manifest.id)).filter(
      (binding) => binding.id.startsWith(prefix),
    );
    const nextBindings: PluginBinding[] = record.manifest.entries.map((entry) => ({
      id: automaticPluginBindingId("plugin", record.manifest.id, entry.id),
      pluginId: record.manifest.id,
      entryId: entry.id,
      scopeType: "global",
      scopeId: "global",
      enabled: true,
      config: {},
    }));

    // 包选择、旧自动 Binding 删除和新 Binding 写入必须同时可见，避免重启读到半套安装状态。
    await this.registry.replacePackageSelectionAndBindings(
      record.manifest.id,
      record,
      prefix,
      nextBindings,
    );
    try {
      await this.reconcile();
      await this.assertSelectedHostBindingsActive(record);
    } catch (error) {
      await this.registry.replacePackageSelectionAndBindings(
        record.manifest.id,
        previous,
        prefix,
        previous ? previousBindings : [],
      );
      await this.reconcile();
      throw error;
    }
  }

  async start(): Promise<void> {
    await this.registry.synchronizeBuiltIns();
    await this.reconcile();
  }

  async reload(runtimeId: string): Promise<void> {
    await this.runtime.reload(runtimeId);
  }

  runtimeSnapshot(): RuntimeControlSnapshot {
    return this.runtime.snapshot();
  }

  runtimeLifecycle(runtimeId?: string): readonly PluginRuntimeLifecycleRecord[] {
    return this.runtime.lifecycle(runtimeId);
  }

  /** 只投影当前实际生效的第三方版本；开发包覆盖同 ID 的已安装版本。 */
  async listThirdPartyPlugins(): Promise<readonly PluginManagementSnapshot[]> {
    const packages = new Map<string, PluginPackageRecord>();
    for (const record of await this.registry.listCurrentPackages()) {
      if (record.source === "installed") packages.set(record.manifest.id, record);
    }
    for (const record of this.registry.listDevelopmentPackages()) {
      packages.set(record.manifest.id, record);
    }

    const persistentBindings = await this.registry.listBindings();
    const hostRuntimes = new Map(
      this.runtime.snapshot().plugins.map((runtime) => [runtime.runtimeId, runtime]),
    );
    const clientRuntimeIds = new Set(this.clientEntries.map(({ runtimeId }) => runtimeId));

    return [...packages.values()]
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
      .map((record) => {
        if (record.source === "builtin") {
          throw new Error(`built-in package entered third-party projection: ${record.manifest.id}`);
        }
        const bindings =
          record.source === "development"
            ? this.registry.listDevelopmentBindings(record.manifest.id)
            : persistentBindings.filter((binding) =>
                binding.id.startsWith(automaticPluginBindingPrefix("plugin", record.manifest.id)),
              );
        const bindingsByEntry = new Map(bindings.map((binding) => [binding.entryId, binding]));
        const entries = record.manifest.entries.map((entry): PluginManagementEntrySnapshot => {
          const binding = bindingsByEntry.get(entry.id);
          const runtime = binding ? hostRuntimes.get(binding.id) : undefined;
          const enabled = binding?.enabled ?? false;
          const state =
            enabled && runtime
              ? runtime.state
              : enabled && binding && clientRuntimeIds.has(binding.id)
                ? "active"
                : "inactive";
          return {
            id: entry.id,
            runtimeId:
              binding?.id ??
              automaticPluginBindingId(
                record.source === "development" ? "dev" : "plugin",
                record.manifest.id,
                entry.id,
              ),
            runtime: entry.runtime,
            enabled,
            state,
            uses: entry.uses ?? {},
            ...(runtime?.error ? { error: runtime.error } : {}),
          };
        });
        return {
          id: record.manifest.id,
          version: record.manifest.version,
          publisher: record.manifest.publisher,
          source: record.source,
          trust: thirdPartyTrust(record),
          digest: record.digest,
          installedAt: record.installedAt,
          enabled: entries.every(({ enabled }) => enabled),
          entries,
        };
      });
  }

  /** 包级开关始终成组更新全部自动 Binding，失败时恢复开关和原 Runtime。 */
  async setThirdPartyPluginEnabled(
    pluginId: string,
    enabled: boolean,
  ): Promise<PluginManagementSnapshot> {
    if (typeof pluginId !== "string" || !pluginId) {
      throw new TypeError("plugin ID must be a non-empty string");
    }
    if (typeof enabled !== "boolean") throw new TypeError("plugin enabled must be a boolean");

    const development = this.registry
      .listDevelopmentPackages()
      .find((record) => record.manifest.id === pluginId);
    if (development) {
      const previous = this.registry
        .listDevelopmentBindings(pluginId)
        .every((binding) => binding.enabled);
      if (previous !== enabled) {
        this.registry.setDevelopmentPackageEnabled(pluginId, enabled);
        try {
          await this.reconcile();
          if (enabled) await this.assertSelectedHostBindingsActive(development);
        } catch (error) {
          this.registry.setDevelopmentPackageEnabled(pluginId, previous);
          await this.reconcile();
          throw error;
        }
      }
      return await this.requireThirdPartyPlugin(pluginId);
    }

    const record = (await this.registry.listCurrentPackages()).find(
      (candidate) => candidate.manifest.id === pluginId && candidate.source === "installed",
    );
    if (!record) throw new Error(`third-party plugin is not available: ${pluginId}`);
    const prefix = automaticPluginBindingPrefix("plugin", pluginId);
    const previousBindings = (await this.registry.listBindings(pluginId)).filter((binding) =>
      binding.id.startsWith(prefix),
    );
    const bindingsById = new Map(previousBindings.map((binding) => [binding.id, binding]));
    const nextBindings = record.manifest.entries.map((entry) => {
      const id = automaticPluginBindingId("plugin", pluginId, entry.id);
      const binding = bindingsById.get(id);
      if (!binding) throw new Error(`plugin automatic binding is missing: ${id}`);
      return { ...binding, enabled };
    });
    if (previousBindings.every((binding) => binding.enabled === enabled)) {
      return await this.requireThirdPartyPlugin(pluginId);
    }

    await this.registry.replacePackageSelectionAndBindings(pluginId, record, prefix, nextBindings);
    try {
      await this.reconcile();
      if (enabled) await this.assertSelectedHostBindingsActive(record);
    } catch (error) {
      await this.registry.replacePackageSelectionAndBindings(
        pluginId,
        record,
        prefix,
        previousBindings,
      );
      await this.reconcile();
      throw error;
    }
    return await this.requireThirdPartyPlugin(pluginId);
  }

  clientEntrySnapshot(): ResolvedClientEntrySnapshot {
    return {
      revision: this.clientEntryRevision,
      entries: this.clientEntries,
    };
  }

  onClientEntriesChanged(listener: (snapshot: ResolvedClientEntrySnapshot) => void): () => void {
    this.clientEntryListeners.add(listener);
    return () => this.clientEntryListeners.delete(listener);
  }

  /**
   * 以当前仍活动的 Client Entry 身份调用 Host Service。
   *
   * 摘要参与身份校验，令刷新前仍持有旧模块的 Renderer 代码无法借稳定 runtimeId
   * 穿透到新版本。方法授权继续以 Main 持有的 Manifest `uses` 为准。
   */
  async callClientService(request: ClientServiceCallRequest): Promise<JsonValue | void> {
    const entry = this.clientEntries.find(
      (candidate) =>
        candidate.runtimeId === request.runtimeId && candidate.package.digest === request.integrity,
    );
    if (!entry) throw new Error(`client runtime is not active: ${request.runtimeId}`);

    const call = authorizeEntryServiceCall(entry, {
      contract: request.contract,
      method: request.method,
      args: [...request.args],
    });
    const ownScope = {
      type: entry.binding.scopeType,
      id: entry.binding.scopeId,
    } satisfies ScopeAddress;
    const execution: ExecutionContext = {
      actorType: "client",
      actorId: entry.package.manifest.id,
      runtimeId: entry.runtimeId,
      scopeType: ownScope.type,
      scopeId: ownScope.id,
      scopeChain: ownScope.type === "global" ? [ownScope] : [globalScope(), ownScope],
      permissions: entry.entry.permissions,
      permissionRevision: 1,
    };
    return this.services.call(call.contract, call.method, call.args, execution);
  }

  diagnostics(): {
    services: number;
    contributions: number;
    clientEntries: number;
  } {
    return {
      services: this.services.countRuntime(),
      contributions: this.contributions.list().length,
      clientEntries: this.clientEntries.length,
    };
  }

  /**
   * Core 侧按公开 Contract 取得类型化 Service façade；实际 Provider 仍由每次调用时按 Scope 选择。
   */
  service<T extends object>(
    contract: string,
    scopeChain: readonly ScopeAddress[] = [globalScope()],
  ): T {
    return new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "then") return undefined;
          if (typeof property !== "string") return undefined;
          return (...args: JsonValue[]) => this.callService(contract, property, args, scopeChain);
        },
      },
    ) as T;
  }

  callService(
    contract: string,
    method: string,
    args: JsonValue[],
    scopeChain: readonly ScopeAddress[] = [globalScope()],
  ): Promise<JsonValue | void> {
    const execution: ExecutionContext = {
      actorType: "core",
      actorId: "seashard.core",
      scopeType: scopeChain.at(-1)?.type ?? "global",
      scopeId: scopeChain.at(-1)?.id ?? "global",
      scopeChain,
      permissions: ["*"],
      permissionRevision: 1,
    };
    return this.services.call(contract, method, args, execution);
  }

  dispose(): Promise<void> {
    this.disposeTask ??= this.disposeKernel();
    return this.disposeTask;
  }

  private async reconcile(): Promise<void> {
    const entries = await this.registry.resolve({
      hostProfile: this.options.hostProfile,
      clientTarget: this.options.clientTarget,
      platform: this.options.platform,
      architecture: this.options.architecture,
    });
    const clientEntries = entries.filter((entry) => entry.host === "client");
    await this.runtime.reconcile(entries.filter((entry) => entry.host !== "client"));
    this.publishClientEntries(clientEntries);
  }

  private publishClientEntries(entries: ResolvedEntry[]): void {
    const fingerprint = JSON.stringify(
      entries.map((entry) => ({
        runtimeId: entry.runtimeId,
        pluginId: entry.package.manifest.id,
        pluginVersion: entry.package.manifest.version,
        digest: entry.package.digest,
        entryId: entry.entry.id,
        scopeType: entry.binding.scopeType,
        scopeId: entry.binding.scopeId,
        config: entry.binding.config,
      })),
    );
    if (fingerprint === this.clientEntryFingerprint) return;

    this.clientEntryFingerprint = fingerprint;
    this.clientEntries = entries;
    this.clientEntryRevision += 1;
    const snapshot = this.clientEntrySnapshot();
    for (const listener of this.clientEntryListeners) listener(snapshot);
  }

  private async requireThirdPartyPlugin(pluginId: string): Promise<PluginManagementSnapshot> {
    const snapshot = (await this.listThirdPartyPlugins()).find(
      (candidate) => candidate.id === pluginId,
    );
    if (!snapshot) throw new Error(`third-party plugin disappeared during update: ${pluginId}`);
    return snapshot;
  }

  private async currentPackage(pluginId: string): Promise<PluginPackageRecord | undefined> {
    return (await this.registry.listCurrentPackages()).find(
      (candidate) => candidate.manifest.id === pluginId,
    );
  }

  private async restorePackageSelection(
    pluginId: string,
    previous: PluginPackageRecord | undefined,
  ): Promise<void> {
    if (previous) {
      await this.registry.selectPackageVersion(previous);
    } else {
      await this.registry.clearPackageSelection(pluginId);
    }
  }

  private async assertSelectedHostBindingsActive(record: PluginPackageRecord): Promise<void> {
    // 与 reconcile 共用 Registry 的环境解析结果；不适用于当前 Host 的 Entry 会被正常保留，
    // 但不会被误判为“应该已经激活”。
    const applicableHostEntries = (
      await this.registry.resolve({
        hostProfile: this.options.hostProfile,
        clientTarget: this.options.clientTarget,
        platform: this.options.platform,
        architecture: this.options.architecture,
      })
    ).filter(
      (entry) =>
        entry.host !== "client" &&
        entry.package.manifest.id === record.manifest.id &&
        entry.package.digest === record.digest,
    );
    const plugins = new Map(
      this.runtime.snapshot().plugins.map((plugin) => [plugin.runtimeId, plugin]),
    );
    const failed = applicableHostEntries.find((entry) => {
      const plugin = plugins.get(entry.runtimeId);
      return (
        !plugin || plugin.pluginVersion !== record.manifest.version || plugin.state !== "active"
      );
    });
    if (failed) throw new Error(`plugin activation failed for binding ${failed.runtimeId}`);
  }

  private async disposeKernel(): Promise<void> {
    await this.runtime.dispose();
    // 开发包从未写入数据库；清空覆盖表后，后续 Host 只会看到原持久化选择。
    this.registry.clearDevelopmentPackages();
    for (const dispose of this.coreDisposers.reverse()) dispose();
    this.clientEntryListeners.clear();
  }
}

function globalScope(): ScopeAddress {
  return { type: "global", id: "global" };
}

function thirdPartyTrust(record: PluginPackageRecord): "local-full-trust" | "package-full-trust" {
  if (record.trust === "local-full-trust" || record.trust === "package-full-trust") {
    return record.trust;
  }
  throw new Error(`third-party plugin uses an invalid trust level: ${record.manifest.id}`);
}
