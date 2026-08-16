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

/** 核心权威 SQLite 数据库的受保护启动参数。 */
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
 * 该组件拥有 DataRoot Lease，因此必须最先启动、最后停止；其他持久化 Foundation
 * 通过 inject 依赖它，但各自拥有独立的领域 Repository。
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
      // Lease 覆盖数据库、托管存储和 Foundation 的完整生命周期。
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
        // 先关闭 Worker/连接，再释放 DataRoot Lease，防止另一个进程提前接管目录。
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
