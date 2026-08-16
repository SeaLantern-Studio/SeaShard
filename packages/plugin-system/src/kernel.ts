import { ComponentSupervisor } from "@seashard/component-supervisor";
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
import { PluginRuntimeBackend } from "./runtime-backend";
import {
  ContributionRegistry,
  PluginEventBus,
  RuntimePublicationRegistry,
  ServiceRegistry,
} from "./runtime-registries";
import { PluginStore } from "./store";
import type {
  BuiltInPackageRegistration,
  PluginPackageRecord,
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
  readonly publications = new RuntimePublicationRegistry();
  readonly services = new ServiceRegistry(this.publications);
  readonly contributions = new ContributionRegistry(this.publications);
  readonly events = new PluginEventBus(this.publications);

  private readonly supervisor: ComponentSupervisor;
  private readonly coreDisposers: Array<() => void> = [];
  private clientEntries: ResolvedEntry[] = [];
  private disposeTask?: Promise<void>;

  private constructor(
    private readonly options: PluginKernelOptions,
    readonly store: PluginStore,
  ) {
    this.installer = new PluginInstaller(this.store, options.dataRoot, options.seaShardVersion);
    this.registry = new PluginRegistry(this.store, options.seaShardVersion);
    let supervisor: ComponentSupervisor;
    const backend = new PluginRuntimeBackend(
      options.root,
      this.registry,
      {
        publications: this.publications,
        services: this.services,
        contributions: this.contributions,
        events: this.events,
        storage: options.pluginStorage,
      },
      options.pluginHostEntry,
      (runtimeId, generation, error) => {
        void supervisor.runtimeFailed(runtimeId, generation, error).catch((failure) => {
          console.error(
            `failed to persist runtime failure for ${runtimeId}@${generation}`,
            failure,
          );
        });
      },
    );
    supervisor = new ComponentSupervisor(backend, this.store);
    this.supervisor = supervisor;
  }

  static async create(options: PluginKernelOptions): Promise<PluginKernel> {
    await mkdir(options.dataRoot, { recursive: true });
    const kernel = new PluginKernel(options, options.store);
    for (const publication of await options.store.listRuntimePublications()) {
      kernel.publications.seedEpoch(publication.runtimeId, publication.epoch);
    }
    return kernel;
  }

  registerBuiltIn(registration: BuiltInPackageRegistration): Promise<PluginPackageRecord> {
    return this.registry.registerBuiltIn(registration);
  }

  registerCoreService(contract: string, provider: ServiceProvider): void {
    const dispose = this.services.register(contract, "seashard.core", 0, globalScope(), provider);
    this.publications.publish("seashard.core", 0);
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
      if (enabledHostBindings.length) {
        const snapshot = this.supervisor.snapshot();
        const publications = new Map(
          snapshot.publications.map((publication) => [publication.runtimeId, publication]),
        );
        const generations = new Map(
          snapshot.generations.map((generation) => [
            `${generation.runtimeId}@${generation.generation}`,
            generation,
          ]),
        );
        const failed = enabledHostBindings.find((binding) => {
          const publication = publications.get(binding.id);
          const generation =
            publication?.generation === null || publication?.generation === undefined
              ? undefined
              : generations.get(`${binding.id}@${publication.generation}`);
          return (
            !generation ||
            generation.pluginVersion !== record.manifest.version ||
            generation.phase !== "running"
          );
        });
        if (failed) throw new Error(`plugin activation failed for binding ${failed.id}`);
      }
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
    await this.supervisor.reload(runtimeId);
  }

  runtimeSnapshot(): RuntimeControlSnapshot {
    return this.supervisor.snapshot();
  }

  resolvedClientEntries(): readonly ResolvedEntry[] {
    return this.clientEntries;
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
    this.clientEntries = entries.filter((entry) => entry.host === "client");
    await this.supervisor.reconcile(entries.filter((entry) => entry.host !== "client"));
  }

  private async disposeKernel(): Promise<void> {
    await this.supervisor.dispose();
    for (const dispose of this.coreDisposers.reverse()) dispose();
  }
}

function globalScope(): ScopeAddress {
  return { type: "global", id: "global" };
}
