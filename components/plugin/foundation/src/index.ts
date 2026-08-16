import type { BootstrapDescriptor } from "@seashard/bootstrap-runtime";
import type { DatabaseService } from "@seashard/database";
import { SQLiteDatabaseBroker } from "@seashard/database-sqlite";
import type { PluginStorageBroker } from "@seashard/plugin-sdk";
import { PluginStore } from "@seashard/plugin-system";
import { Context, Service } from "cordis";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pluginDocumentDataCapsule, SQLitePluginDocumentStorage } from "./document-storage";

/** Plugin Kernel 持久化基础的受保护启动参数。 */
export interface PluginFoundationBootstrapOptions {
  readonly dataRoot: string;
  readonly workerEntry: string | URL;
  readonly seaShardVersion: string;
  readonly storagePath?: string;
}

/**
 * 向 PluginKernel 原子发布已经恢复的权威 Store 和已经就绪的托管文档存储。
 *
 * 两者始终在同一 Bootstrap 阶段创建、失败回滚和停止，不再为同一插件基础功能
 * 制造两个不可独立运行的组件生命周期。
 */
export class PluginFoundationService extends Service {
  constructor(
    ctx: Context,
    readonly store: PluginStore,
    readonly storage: PluginStorageBroker,
  ) {
    super(ctx, "plugin-foundation");
  }
}

declare module "cordis" {
  interface Context {
    "plugin-foundation": PluginFoundationService;
  }
}

/**
 * 创建受保护的插件持久化 Foundation。
 *
 * 权威插件状态使用核心 Database Service；普通插件文档继续使用独立 SQLite 文件和
 * Worker Lane。物理隔离保留为内部模块边界，不再提升成第二个 Bootstrap Component。
 */
export function createPluginFoundationBootstrapDescriptor(
  options: PluginFoundationBootstrapOptions,
): BootstrapDescriptor {
  return {
    id: "seashard.plugin-foundation",
    buildDigest: createHash("sha256")
      .update("seashard.plugin-foundation.bootstrap.v1")
      .digest("hex"),
    inject: ["database"],
    provides: ["plugin-foundation"],
    async load(ctx) {
      const database = requireDatabase(ctx);
      let storageBroker: SQLiteDatabaseBroker | undefined;

      try {
        const store = await PluginStore.create(database, options.seaShardVersion);
        await store.interruptRuntimeOperations();
        await store.invalidateRuntimePublications();

        const storageRoot = join(options.dataRoot, "plugin-data");
        await mkdir(storageRoot, { recursive: true });
        storageBroker = await SQLiteDatabaseBroker.create({
          databasePath: options.storagePath ?? join(storageRoot, "documents.sqlite3"),
          workerEntry: options.workerEntry,
          readWorkers: 1,
        });
        const repository = await storageBroker.registerCapsule(pluginDocumentDataCapsule);
        const storage = new SQLitePluginDocumentStorage(repository);

        // 下游只能观察到同时就绪的 Store 和 Storage，不能取得半初始化 Foundation。
        new PluginFoundationService(ctx, store, storage);
        const activeStorageBroker = storageBroker;
        return () => activeStorageBroker.close();
      } catch (error) {
        await storageBroker?.close();
        throw error;
      }
    },
  };
}

/** 从 Cordis Context 读取并校验受保护 Database Service。 */
function requireDatabase(ctx: Context): DatabaseService {
  const candidate: unknown = Reflect.get(ctx, "database");
  if (!isDatabaseService(candidate)) {
    throw new Error("plugin foundation requires the database service");
  }
  return candidate;
}

function isDatabaseService(value: unknown): value is DatabaseService {
  if (!value || typeof value !== "object") return false;
  return ["registerCapsule", "quickCheck", "checkpoint", "backup", "diagnostics", "close"].every(
    (member) => member in value && typeof Reflect.get(value, member) === "function",
  );
}

export { pluginDocumentDataCapsule, SQLitePluginDocumentStorage } from "./document-storage";
