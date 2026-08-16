import {
  runtimeDiagnosticsContract,
  type ComponentSnapshot,
  type RuntimeSnapshot,
} from "@seashard/contracts";
import type { PluginManifest, PluginModule, RuntimeControlSnapshot } from "@seashard/plugin-sdk";

/** 运行态投影需要的宿主元数据，不包含 Supervisor 的可变内部对象。 */
export interface RuntimeProjectionOptions {
  readonly host: RuntimeSnapshot["host"];
  readonly startedAt: string;
  readonly stopping: boolean;
}

/**
 * 内建诊断组件的 Core 适配边界。
 *
 * Component 只读取不可变快照和宿主状态，不持有 PluginKernel、Supervisor 或数据库引用，
 * 因此投影逻辑可以由 Desktop、Web 和 Headless Host 复用。
 */
export interface RuntimeDiagnosticsConfig {
  readonly host: RuntimeSnapshot["host"];
  readonly startedAt: string;
  readControlSnapshot(): RuntimeControlSnapshot;
  isStopping(): boolean;
}

export const runtimeDiagnosticsManifest: PluginManifest = {
  id: "seashard.runtime-diagnostics",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "runtime-diagnostics.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [],
      upgradeMode: "hot-swap",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/**
 * 创建可重载的运行诊断内建组件。
 *
 * 组件通过类型化 Service 发布投影结果；Desktop Shell 只消费该 Service，
 * 不再理解 Generation、Publication 和 Operation 的组合规则。
 */
export function createRuntimeDiagnosticsModule(config: RuntimeDiagnosticsConfig): PluginModule {
  return {
    provides: [runtimeDiagnosticsContract],
    apply(ctx) {
      ctx.provide(runtimeDiagnosticsContract, {
        getSnapshot: () =>
          projectRuntimeSnapshot(config.readControlSnapshot(), {
            host: config.host,
            startedAt: config.startedAt,
            stopping: config.isStopping(),
          }),
      });
    },
  };
}

/**
 * 把 Supervisor 的权威控制快照转换成稳定、只读、可跨 IPC 传输的诊断视图。
 *
 * 投影不修改运行态；即使投影失败，也不会改变组件的实际 Publication 或 Operation。
 */
export function projectRuntimeSnapshot(
  control: RuntimeControlSnapshot,
  options: RuntimeProjectionOptions,
): RuntimeSnapshot {
  const components = projectComponents(control);
  return {
    protocolVersion: 1,
    host: options.host,
    state: options.stopping
      ? "stopping"
      : components.some((component) => component.phase === "failed")
        ? "degraded"
        : "active",
    startedAt: options.startedAt,
    components,
  };
}

/** 将多张运行态表合并成每个 runtime 唯一的用户可读状态。 */
function projectComponents(control: RuntimeControlSnapshot): ComponentSnapshot[] {
  const publications = new Map(
    control.publications.map((publication) => [publication.runtimeId, publication]),
  );
  const operations = new Map(
    control.operations.map((operation) => [operation.runtimeId, operation]),
  );
  const latest = new Map<string, (typeof control.generations)[number]>();

  // Generation 表保留历史；投影先找出每个 runtime 最新候选，再结合 Publication 决定展示对象。
  for (const generation of control.generations) {
    const current = latest.get(generation.runtimeId);
    if (!current || current.generation < generation.generation) {
      latest.set(generation.runtimeId, generation);
    }
  }

  return [...latest.values()]
    .flatMap((generation) => {
      const publication = publications.get(generation.runtimeId);
      const published =
        publication?.generation === null || publication?.generation === undefined
          ? undefined
          : control.generations.find(
              (candidate) =>
                candidate.runtimeId === generation.runtimeId &&
                candidate.generation === publication.generation,
            );
      const operation = operations.get(generation.runtimeId);

      // 已完成停用且没有 Publication 的历史 Generation 不应继续占据组件列表。
      if (!published && generation.phase === "terminated" && operation?.status === "completed") {
        return [];
      }

      // 已发布 generation 仍在服务时优先报告 active；候选升级状态通过 Operation 单独推导。
      const phase =
        published?.phase === "running"
          ? ("active" as const)
          : operation?.status === "running"
            ? operation.step === "wait-dependencies"
              ? ("blocked" as const)
              : ("updating" as const)
            : ("failed" as const);
      const displayed = published ?? generation;
      return [
        {
          id: displayed.runtimeId,
          displayName: `${displayed.pluginId}/${displayed.entryId}`,
          generation: displayed.generation,
          phase,
          ...(operation?.error ? { error: operation.error } : {}),
        },
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
