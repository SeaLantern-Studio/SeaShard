import type { ServerConsoleLine } from "@seashard/contracts";
import type { SQLiteDatabaseBroker } from "@seashard/database-sqlite";
import type { PluginKernel } from "@seashard/plugin-system";
import { registerServerFeatures } from "@seashard/server-features";

interface ControllerServerFeatureOptions {
  readonly kernel: PluginKernel;
  readonly database: SQLiteDatabaseBroker;
  readonly hostDataRoot: string;
  readonly seaShardVersion: string;
  readonly publishConsoleLine: (line: ServerConsoleLine) => void;
}

/**
 * Desktop 保持现有 Controller 内执行方式；共享注册器同时供独立 Host 使用，避免两边的
 * 服务器组件集合、路径和默认值逐渐分叉。
 */
export function registerControllerServerFeatures(
  options: ControllerServerFeatureOptions,
): Promise<void> {
  return registerServerFeatures({
    kernel: options.kernel,
    database: options.database,
    dataRoot: options.hostDataRoot,
    seaShardVersion: options.seaShardVersion,
    executionLocation: "controller",
    publishConsoleLine: options.publishConsoleLine,
  });
}
