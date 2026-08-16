import type { BootstrapDescriptor } from "@seashard/bootstrap-runtime";
import type { DatabaseService } from "@seashard/database";
import { PluginStore } from "@seashard/plugin-system";
import { Context, Service } from "cordis";
import { createHash } from "node:crypto";

/** Plugin System Foundation 启动时所需的 Core 版本信息。 */
export interface PluginSystemFoundationBootstrapOptions {
  readonly seaShardVersion: string;
}

/**
 * 向后续 Core 运行时发布已经完成迁移和启动恢复的 PluginStore。
 *
 * 普通插件不能取得或替换该服务；它只用于 Bootstrap 与 PluginKernel 之间交接。
 */
export class PluginSystemFoundationService extends Service {
  constructor(
    ctx: Context,
    readonly store: PluginStore,
  ) {
    super(ctx, "plugin-system-foundation");
  }
}

declare module "cordis" {
  interface Context {
    "plugin-system-foundation": PluginSystemFoundationService;
  }
}

/**
 * 创建 Plugin System Foundation 的受保护启动描述符。
 *
 * 该组件必须在 Database Ready 后、ComponentSupervisor 创建前运行。
 */
export function createPluginSystemFoundationBootstrapDescriptor(
  options: PluginSystemFoundationBootstrapOptions,
): BootstrapDescriptor {
  return {
    id: "seashard.plugin-system-foundation",
    buildDigest: createHash("sha256")
      .update("seashard.plugin-system-foundation.bootstrap.v1")
      .digest("hex"),
    inject: ["database"],
    provides: ["plugin-system-foundation"],
    async load(ctx) {
      const database = requireDatabase(ctx);

      const store = await PluginStore.create(database, options.seaShardVersion);
      // Repository 注册成功后先修复上次异常退出留下的瞬时运行态。
      await store.interruptRuntimeOperations();
      await store.invalidateRuntimePublications();
      // 只有迁移和恢复全部成功后才发布 Store，禁止下游看到半初始化仓库。
      new PluginSystemFoundationService(ctx, store);
    },
  };
}

/** 从 Cordis Context 读取并校验 Bootstrap Database Service。 */
function requireDatabase(ctx: Context): DatabaseService {
  const candidate: unknown = Reflect.get(ctx, "database");
  if (!isDatabaseService(candidate)) {
    throw new Error("plugin system foundation requires the database service");
  }
  return candidate;
}

function isDatabaseService(value: unknown): value is DatabaseService {
  if (!value || typeof value !== "object") return false;
  return ["registerCapsule", "quickCheck", "checkpoint", "backup", "diagnostics", "close"].every(
    (member) => member in value && typeof Reflect.get(value, member) === "function",
  );
}
