import { hostWorkerDeploymentContract } from "@seashard/host-control";
import type { JsonValue, PluginBinding, ServiceProvider } from "@seashard/plugin-sdk";
import {
  automaticPluginBindingId,
  type HostWorkerPackageDeployment,
  type PluginKernel,
  type PluginPackageRecord,
} from "@seashard/plugin-system";
import type { DesktopHostConnections } from "./desktop-host-connections";

interface HostWorkerServiceDescriptor {
  readonly contract: string;
  readonly methods: readonly string[];
}
interface HostWorkerDeploymentResult {
  readonly services: readonly HostWorkerServiceDescriptor[];
  readonly runtimes: readonly {
    readonly runtimeId: string;
    readonly state: "active" | "failed";
    readonly error?: string;
  }[];
}

/**
 * Controller 插件状态每次收敛后，把显式 Host Worker 投影到当前持有控制权的本机 Host。
 * 旁观 Controller 不写 Host；取得控制权时由连接状态回调补做一次完整同步。
 */
export class HostWorkerDeploymentCoordinator {
  private stopReconciled?: () => void;
  private stopHosts?: () => void;
  private activeSync?: Promise<void>;
  private synchronizeAgain = false;
  private readonly serviceProxies = new Map<string, () => void>();

  constructor(
    private readonly controller: PluginKernel,
    private readonly hosts: DesktopHostConnections,
  ) {}

  start(): void {
    this.stopReconciled = this.controller.onReconciled(() => this.synchronize());
    this.stopHosts = this.hosts.onChanged(() => {
      void this.synchronize().catch((error) => {
        console.error("Host Worker synchronization failed", error);
      });
    });
  }

  dispose(): void {
    this.stopReconciled?.();
    this.stopHosts?.();
    this.stopReconciled = undefined;
    this.stopHosts = undefined;
    for (const dispose of this.serviceProxies.values()) dispose();
    this.serviceProxies.clear();
  }

  async synchronize(): Promise<void> {
    if (this.activeSync) {
      this.synchronizeAgain = true;
      return this.activeSync;
    }
    this.activeSync = this.runSynchronizationLoop();
    try {
      await this.activeSync;
    } finally {
      this.activeSync = undefined;
    }
  }

  private async runSynchronizationLoop(): Promise<void> {
    do {
      this.synchronizeAgain = false;
      const client = this.hosts.clientFor("local");
      if (!client) {
        this.replaceServiceProxies([]);
        this.controller.setExternalRuntimeStates([]);
        return;
      }
      const service = client.service<{
        describe(): Promise<JsonValue>;
        synchronize(snapshot: JsonValue): Promise<JsonValue>;
      }>(hostWorkerDeploymentContract);
      const result = client.hasControl
        ? await service.synchronize({
            packages: await collectHostWorkerDeployments(this.controller),
          } as unknown as JsonValue)
        : await service.describe();
      const parsed = parseDeploymentResult(result);
      this.controller.setExternalRuntimeStates(parsed.runtimes);
      this.replaceServiceProxies(parsed.services);
    } while (this.synchronizeAgain);
  }

  private replaceServiceProxies(descriptors: readonly HostWorkerServiceDescriptor[]): void {
    for (const dispose of this.serviceProxies.values()) dispose();
    this.serviceProxies.clear();
    for (const descriptor of descriptors) {
      if (this.controller.services.has(descriptor.contract)) continue;
      const provider: ServiceProvider = {};
      for (const method of descriptor.methods) {
        provider[method] = (...args) => {
          const client = this.hosts.clientFor("local");
          if (!client) throw new Error("Host Worker 所属 Host 当前不可用");
          const remote = client.service<ServiceProvider>(descriptor.contract);
          return remote[method]!(...args);
        };
      }
      this.serviceProxies.set(
        descriptor.contract,
        this.controller.registerCoreService(descriptor.contract, provider),
      );
    }
  }
}

async function collectHostWorkerDeployments(
  kernel: PluginKernel,
): Promise<readonly HostWorkerPackageDeployment[]> {
  const selected = new Map(
    (await kernel.registry.listCurrentPackages())
      .filter(({ source }) => source === "installed")
      .map((record) => [record.manifest.id, record]),
  );
  for (const record of kernel.registry.listDevelopmentPackages()) {
    selected.set(record.manifest.id, record);
  }

  const deployments: HostWorkerPackageDeployment[] = [];
  for (const record of selected.values()) {
    const workerEntries = record.manifest.entries.filter(
      (entry) => entry.runtime === "host" && entry.execution === "host",
    );
    if (workerEntries.length === 0) continue;
    const bindings =
      record.source === "development"
        ? kernel.registry.listDevelopmentBindings(record.manifest.id)
        : await kernel.registry.listBindings(record.manifest.id);
    deployments.push({
      pluginId: record.manifest.id,
      digest: record.digest,
      source: record.source === "development" ? "development" : "installed",
      sourceRoot: record.rootPath,
      entries: workerEntries.map((entry) => {
        const binding = requireWorkerBinding(record, entry.id, bindings);
        return { entryId: entry.id, enabled: binding.enabled, config: binding.config };
      }),
    });
  }
  return deployments.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function requireWorkerBinding(
  record: PluginPackageRecord,
  entryId: string,
  bindings: readonly PluginBinding[],
): PluginBinding {
  const namespace = record.source === "development" ? "dev" : "plugin";
  const bindingId = automaticPluginBindingId(namespace, record.manifest.id, entryId);
  const binding = bindings.find((candidate) => candidate.id === bindingId);
  if (!binding) throw new Error(`Host Worker Binding 缺失：${bindingId}`);
  return binding;
}

function parseDeploymentResult(value: JsonValue): HostWorkerDeploymentResult {
  const record = requireRecord(value, "Host Worker deployment result");
  if (!Array.isArray(record.services) || !Array.isArray(record.runtimes)) {
    throw new TypeError("Host Worker deployment result arrays are invalid");
  }
  return {
    services: record.services.map((serviceValue) => {
      const service = requireRecord(serviceValue, "Host Worker service descriptor");
      if (!Array.isArray(service.methods)) {
        throw new TypeError("Host Worker service methods must be an array");
      }
      return {
        contract: requireString(service.contract, "contract"),
        methods: service.methods.map((method) => requireString(method, "method")),
      };
    }),
    runtimes: record.runtimes.map((runtimeValue) => {
      const runtime = requireRecord(runtimeValue, "Host Worker runtime descriptor");
      if (runtime.state !== "active" && runtime.state !== "failed") {
        throw new TypeError("Host Worker runtime state is invalid");
      }
      return {
        runtimeId: requireString(runtime.runtimeId, "runtimeId"),
        state: runtime.state,
        ...(runtime.error === undefined
          ? {}
          : { error: requireString(runtime.error, "runtime error") }),
      };
    }),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} must be a string`);
  return value;
}
