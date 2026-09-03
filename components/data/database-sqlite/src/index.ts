import type { BootstrapDescriptor } from "@seashard/bootstrap-runtime";
import type {
  DataCapsule,
  DatabaseCheckpointResult,
  DatabaseDiagnostics,
  DatabaseIntegrityResult,
  DatabaseService,
  RegisteredDataCapsule,
} from "@seashard/database";
import { Context, Service } from "cordis";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SQLiteDatabaseBroker } from "./broker";
import { DataRootLease } from "./data-root-lease";

/** 核心权威 SQLite 数据库的受保护启动参数；dataRoot 仅用于当前进程的互斥租约。 */
export interface SQLiteBootstrapOptions {
  readonly dataRoot: string;
  readonly workerEntry: string | URL;
  readonly databasePath?: string;
  readonly readWorkers?: number;
}

/** 只暴露类型化 Data Capsule 和维护操作，不暴露连接或任意 SQL。 */
export class SQLiteDatabaseService extends Service implements DatabaseService {
  constructor(
    ctx: Context,
    private readonly broker: SQLiteDatabaseBroker,
  ) {
    super(ctx, "database");
  }

  registerCapsule(capsule: DataCapsule): Promise<RegisteredDataCapsule> {
    return this.broker.registerCapsule(capsule);
  }

  quickCheck(): Promise<DatabaseIntegrityResult> {
    return this.broker.quickCheck();
  }

  checkpoint(): Promise<DatabaseCheckpointResult> {
    return this.broker.checkpoint();
  }

  backup(destination: string): Promise<void> {
    return this.broker.backup(destination);
  }

  diagnostics(): DatabaseDiagnostics {
    return this.broker.diagnostics();
  }

  close(): Promise<void> {
    return this.broker.close();
  }
}

declare module "cordis" {
  interface Context {
    database: SQLiteDatabaseService;
  }
}

/**
 * 创建核心权威数据库的 Bootstrap Descriptor。
 *
 * dataRoot 保护一个 Controller 实例的数据库 Worker 生命周期；databasePath 可以指向
 * 多个 Controller 共同使用的 WAL 数据库。调用方必须为每个实例提供不同的 dataRoot。
 */
export function createSQLiteBootstrapDescriptor(
  options: SQLiteBootstrapOptions,
): BootstrapDescriptor {
  return {
    id: "seashard.database-sqlite",
    buildDigest: createHash("sha256").update("seashard.database-sqlite.bootstrap.v1").digest("hex"),
    inject: [],
    provides: ["database"],
    async load(ctx) {
      // 租约避免同一 Controller 实例目录被重复启动，不限制其他 Controller 打开共享数据库。
      const lease = await DataRootLease.acquire(options.dataRoot);
      let broker: SQLiteDatabaseBroker | undefined;
      try {
        broker = await SQLiteDatabaseBroker.create({
          databasePath: options.databasePath ?? join(options.dataRoot, "seashard.sqlite3"),
          workerEntry: options.workerEntry,
          readWorkers: options.readWorkers,
        });
        // 连接成功后才发布 Database Service，避免依赖者观察到不可用 Broker。
        new SQLiteDatabaseService(ctx, broker);
        const activeBroker = broker;
        // 先关闭 Worker/连接，再释放实例租约，防止相同 Controller 被提前重复启动。
        return async () => {
          try {
            await activeBroker.close();
          } finally {
            await lease.release();
          }
        };
      } catch (error) {
        try {
          await broker?.close();
        } finally {
          await lease.release();
        }
        throw error;
      }
    },
  };
}

export { SQLiteDatabaseBroker } from "./broker";
export { DataRootLease } from "./data-root-lease";
