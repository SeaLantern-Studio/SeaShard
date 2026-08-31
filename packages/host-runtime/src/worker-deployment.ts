import { hostWorkerDeploymentContract } from "@seashard/host-control";
import type { JsonValue } from "@seashard/plugin-sdk";
import type { HostWorkerPackageDeployment, PluginKernel } from "@seashard/plugin-system";

interface HostWorkerDeploymentSnapshot {
  readonly packages: readonly HostWorkerPackageDeployment[];
}

interface HostWorkerDeploymentResult {
  readonly services: readonly {
    readonly contract: string;
    readonly methods: readonly string[];
  }[];
  readonly runtimes: readonly {
    readonly runtimeId: string;
    readonly state: "active" | "failed";
    readonly error?: string;
  }[];
}

/**
 * Host 端只负责校验、安装和运行 Worker 包，不解析插件业务语义。
 * 同步采用完整期望状态：先部署全部目标，再回收 Controller 已不再声明的旧部署。
 */
export function registerHostWorkerDeploymentService(kernel: PluginKernel): void {
  kernel.registerCoreService(hostWorkerDeploymentContract, {
    describe: async () => projectDeploymentResult(kernel) as unknown as JsonValue,
    async synchronize(value) {
      const snapshot = parseDeploymentSnapshot(value);
      const desiredIds = new Set(snapshot.packages.map(({ pluginId }) => pluginId));
      for (const deployment of snapshot.packages) {
        await kernel.deployHostWorkerPackage(deployment);
      }
      for (const pluginId of await kernel.listHostWorkerPluginIds()) {
        if (!desiredIds.has(pluginId)) await kernel.removeHostWorkerPackage(pluginId);
      }
      return projectDeploymentResult(kernel) as unknown as JsonValue;
    },
  });
}

function projectDeploymentResult(kernel: PluginKernel): HostWorkerDeploymentResult {
  return {
    services: projectWorkerServices(kernel),
    runtimes: kernel
      .runtimeSnapshot()
      .plugins.filter(
        ({ runtimeId }) => runtimeId.startsWith("plugin:") || runtimeId.startsWith("dev:"),
      )
      .map(({ runtimeId, state, error }) => ({
        runtimeId,
        state,
        ...(error ? { error } : {}),
      })),
  };
}

function projectWorkerServices(kernel: PluginKernel): HostWorkerDeploymentResult["services"] {
  const contracts = new Map<string, Set<string>>();
  for (const service of kernel.services.snapshot()) {
    if (!service.runtimeId.startsWith("plugin:") && !service.runtimeId.startsWith("dev:")) continue;
    const methods = contracts.get(service.contract) ?? new Set<string>();
    for (const method of service.methods) methods.add(method);
    contracts.set(service.contract, methods);
  }
  return [...contracts.entries()]
    .map(([contract, methods]) => ({ contract, methods: [...methods].sort() }))
    .sort((left, right) => left.contract.localeCompare(right.contract));
}

function parseDeploymentSnapshot(value: JsonValue): HostWorkerDeploymentSnapshot {
  const record = requireRecord(value, "Host Worker deployment snapshot");
  if (!Array.isArray(record.packages)) {
    throw new TypeError("Host Worker deployment packages must be an array");
  }
  return { packages: record.packages.map(parseDeploymentPackage) };
}

function parseDeploymentPackage(value: unknown): HostWorkerPackageDeployment {
  const record = requireRecord(value, "Host Worker deployment package");
  const source = record.source;
  if (source !== "installed" && source !== "development") {
    throw new TypeError("Host Worker deployment source is invalid");
  }
  if (!Array.isArray(record.entries)) {
    throw new TypeError("Host Worker deployment entries must be an array");
  }
  return {
    pluginId: requireString(record.pluginId, "pluginId"),
    digest: requireString(record.digest, "digest"),
    source,
    sourceRoot: requireString(record.sourceRoot, "sourceRoot"),
    entries: record.entries.map((entryValue) => {
      const entry = requireRecord(entryValue, "Host Worker deployment entry");
      if (typeof entry.enabled !== "boolean") {
        throw new TypeError("Host Worker deployment enabled flag is invalid");
      }
      return {
        entryId: requireString(entry.entryId, "entryId"),
        enabled: entry.enabled,
        config: entry.config as JsonValue,
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
