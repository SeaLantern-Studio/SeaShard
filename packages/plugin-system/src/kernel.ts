import { ComponentSupervisor } from "@seashard/component-supervisor";
import type {
  ExecutionContext,
  JsonValue,
  PluginBinding,
  RuntimeControlSnapshot,
  ScopeAddress,
  ServiceProvider,
} from "@seashard/plugin-sdk";
import { Context } from "cordis";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
}

export class PluginKernel {
  readonly store: PluginStore;
  readonly installer: PluginInstaller;
  readonly registry: PluginRegistry;
  readonly publications = new RuntimePublicationRegistry();
  readonly services = new ServiceRegistry(this.publications);
  readonly contributions = new ContributionRegistry(this.publications);
  readonly events = new PluginEventBus(this.publications);

  private readonly root = new Context();
  private readonly supervisor: ComponentSupervisor;
  private readonly coreDisposers: Array<() => void> = [];
  private clientEntries: ResolvedEntry[] = [];
  private disposeTask?: Promise<void>;

  private constructor(private readonly options: PluginKernelOptions) {
    this.store = new PluginStore(
      join(options.dataRoot, "seashard.sqlite3"),
      options.seaShardVersion,
    );
    this.installer = new PluginInstaller(this.store, options.dataRoot, options.seaShardVersion);
    this.registry = new PluginRegistry(this.store, options.seaShardVersion);
    this.store.interruptRuntimeOperations();
    this.store.invalidateRuntimePublications();
    for (const publication of this.store.listRuntimePublications()) {
      this.publications.seedEpoch(publication.runtimeId, publication.epoch);
    }
    let supervisor: ComponentSupervisor;
    const backend = new PluginRuntimeBackend(
      this.root,
      this.registry,
      {
        publications: this.publications,
        services: this.services,
        contributions: this.contributions,
        events: this.events,
      },
      options.pluginHostEntry,
      (runtimeId, generation, error) => supervisor.runtimeFailed(runtimeId, generation, error),
    );
    supervisor = new ComponentSupervisor(backend, this.store);
    this.supervisor = supervisor;
  }

  static async create(options: PluginKernelOptions): Promise<PluginKernel> {
    await mkdir(options.dataRoot, { recursive: true });
    return new PluginKernel(options);
  }

  registerBuiltIn(registration: BuiltInPackageRegistration): PluginPackageRecord {
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

  upsertBinding(binding: PluginBinding): void {
    this.registry.upsertBinding(binding);
  }

  deleteBinding(bindingId: string): void {
    this.registry.deleteBinding(bindingId);
  }

  async selectPackageVersion(record: PluginPackageRecord): Promise<void> {
    const previous = this.registry
      .listCurrentPackages()
      .find((candidate) => candidate.manifest.id === record.manifest.id);
    this.registry.selectPackageVersion(record);
    try {
      await this.reconcile();
      const enabledHostBindings = this.registry
        .listBindings(record.manifest.id)
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
        this.registry.selectPackageVersion(previous);
      } else {
        this.registry.clearPackageSelection(record.manifest.id);
      }
      await this.reconcile();
      throw error;
    }
  }

  async start(): Promise<void> {
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
    const entries = this.registry.resolve({
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
    this.store.close();
  }
}

function globalScope(): ScopeAddress {
  return { type: "global", id: "global" };
}
