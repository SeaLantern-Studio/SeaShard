import type { BootstrapDescriptor } from "@seashard/bootstrap-runtime";
import { SQLiteDatabaseBroker } from "@seashard/database-sqlite";
import type { ExecutionContext, PluginStorage, PluginStorageBroker } from "@seashard/plugin-sdk";
import { Context, Service } from "cordis";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pluginDocumentDataCapsule, SQLitePluginDocumentStorage } from "./plugin-storage";

/** SQLite 托管插件存储的启动参数。 */
export interface SQLitePluginStorageBootstrapOptions {
  readonly dataRoot: string;
  readonly workerEntry: string | URL;
  readonly storagePath?: string;
}

/**
 * 将独立 SQLite 文档仓库适配成 PluginKernel 使用的托管存储能力。
 *
 * 调用方只能提交 ExecutionContext；真正的 owner/runtime namespace 由实现推导，
 * 不允许插件自行指定其他命名空间。
 */
export class SQLitePluginStorageService extends Service implements PluginStorageBroker {
  constructor(
    ctx: Context,
    private readonly storage: SQLitePluginDocumentStorage,
  ) {
    super(ctx, "plugin-storage");
  }

  for(execution: ExecutionContext): PluginStorage {
    return this.storage.for(execution);
  }
}

declare module "cordis" {
  interface Context {
    "plugin-storage": SQLitePluginStorageService;
  }
}

/**
 * 创建受保护的 SQLite 托管插件存储描述符。
 *
 * 它依赖 Database Component 以继承 DataRoot Lease 和启动顺序，但使用独立数据库文件，
 * 不与 SeaShard 核心权威事务共享连接或事务。
 */
export function createSQLitePluginStorageBootstrapDescriptor(
  options: SQLitePluginStorageBootstrapOptions,
): BootstrapDescriptor {
  return {
    id: "seashard.plugin-storage-sqlite",
    buildDigest: createHash("sha256")
      .update("seashard.plugin-storage-sqlite.bootstrap.v1")
      .digest("hex"),
    inject: ["database"],
    provides: ["plugin-storage"],
    async load(ctx) {
      // 默认物理库与核心状态库分离，避免第三方文档流量扩大核心库故障面。
      const storageRoot = join(options.dataRoot, "plugin-data");
      let broker: SQLiteDatabaseBroker | undefined;
      try {
        await mkdir(storageRoot, { recursive: true });
        // 使用独立 Broker/Worker lane；插件永远不会获得该连接或任意 SQL 入口。
        broker = await SQLiteDatabaseBroker.create({
          databasePath: options.storagePath ?? join(storageRoot, "documents.sqlite3"),
          workerEntry: options.workerEntry,
          readWorkers: 1,
        });
        const repository = await broker.registerCapsule(pluginDocumentDataCapsule);
        // Capsule 迁移完成后才发布服务，防止插件访问未就绪 Schema。
        new SQLitePluginStorageService(ctx, new SQLitePluginDocumentStorage(repository));
        const activeBroker = broker;
        // Disposer 归当前 Cordis Fiber；逆序关闭时会先于 Database Component 停止。
        return () => activeBroker.close();
      } catch (error) {
        // 启动中途失败也必须关闭已创建的 Worker，随后由 Loader 回滚依赖组件。
        await broker?.close();
        throw error;
      }
    },
  };
}

export { pluginDocumentDataCapsule, SQLitePluginDocumentStorage } from "./plugin-storage";
