import type {
  ExecutionContext,
  JsonValue,
  PluginBinding,
  PluginStorageBroker,
  RuntimeControlSnapshot,
  ScopeAddress,
  ServiceProvider,
} from "@seashard/plugin-sdk";
import { Context } from "cordis";
import { mkdir } from "node:fs/promises";
import { PluginInstaller } from "./installer";
import { PluginRegistry } from "./registry";
import { PluginRuntime, type PluginRuntimeAdapter } from "./runtime";
import { PluginRuntimeBackend as DefaultPluginRuntimeBackend } from "./runtime-backend";
import {
  AgentToolRegistry,
  ContributionRegistry,
  PluginEventBus,
  ServiceRegistry,
} from "./runtime-registries";
import { PluginStore } from "./store";
import type {
  BuiltInPackageRegistration,
  PluginPackageRecord,
  ResolvedClientEntrySnapshot,
  ResolvedEntry,
  TrustGrant,
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

  registerCoreService(contract: string, provider: ServiceProvider): void {
    const dispose = this.services.register(contract, "seashard.core", globalScope(), provider);
    this.coreDisposers.push(dispose);
  }

  installDevelopmentDirectory(sourceRoot: string, grant: TrustGrant) {
    return this.installer.registerDevelopmentDirectory(sourceRoot, grant);
  }

  prepareArchive(archivePath: string) {
    return this.installer.prepareArchive(archivePath);
  }

  upsertBinding(binding: PluginBinding): Promise<void> {
    return this.registry.upsertBinding(binding);
  }

  deleteBinding(bindingId: string): Promise<void> {
    return this.registry.deleteBinding(bindingId);
  }

  async selectPackageVersion(record: PluginPackageRecord): Promise<void> {
    const previous = (await this.registry.listCurrentPackages()).find(
      (candidate) => candidate.manifest.id === record.manifest.id,
    );
    await this.registry.selectPackageVersion(record);
    try {
      await this.reconcile();
      const enabledHostBindings = (await this.registry.listBindings(record.manifest.id))
        .filter((binding) => binding.enabled)
        .filter((binding) =>
          record.manifest.entries.some(
            (entry) => entry.id === binding.entryId && entry.runtime === "host",
          ),
        );
      const plugins = new Map(
        this.runtime.snapshot().plugins.map((plugin) => [plugin.runtimeId, plugin]),
      );
      const failed = enabledHostBindings.find((binding) => {
        const plugin = plugins.get(binding.id);
        return (
          !plugin || plugin.pluginVersion !== record.manifest.version || plugin.state !== "active"
        );
      });
      if (failed) throw new Error(`plugin activation failed for binding ${failed.id}`);
    } catch (error) {
      if (previous) {
        await this.registry.selectPackageVersion(previous);
      } else {
        await this.registry.clearPackageSelection(record.manifest.id);
      }
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

  private async disposeKernel(): Promise<void> {
    await this.runtime.dispose();
    for (const dispose of this.coreDisposers.reverse()) dispose();
    this.clientEntryListeners.clear();
  }
}

function globalScope(): ScopeAddress {
  return { type: "global", id: "global" };
}
