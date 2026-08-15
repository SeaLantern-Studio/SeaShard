import type { BootstrapDescriptor } from "@seashard/bootstrap-runtime";
import type {
  DataCapsule,
  DatabaseCheckpointResult,
  DatabaseDiagnostics,
  DatabaseIntegrityResult,
  DatabaseService,
  RegisteredDataCapsule,
} from "@seashard/database";
import type { ExecutionContext, PluginStorage, PluginStorageBroker } from "@seashard/plugin-sdk";
import { Context, Service } from "cordis";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SQLiteDatabaseBroker } from "./broker";
import { DataRootLease } from "./data-root-lease";
import { pluginDocumentDataCapsule, SQLitePluginDocumentStorage } from "./plugin-storage";

export interface SQLiteBootstrapOptions {
  readonly dataRoot: string;
  readonly workerEntry: string | URL;
  readonly databasePath?: string;
  readonly pluginStoragePath?: string;
  readonly readWorkers?: number;
}

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
export class SQLitePluginStorageService extends Service implements PluginStorageBroker {
  constructor(
    ctx: Context,
    private readonly storage: SQLitePluginDocumentStorage,
  ) {
    super(ctx, "pluginStorage");
  }

  for(execution: ExecutionContext): PluginStorage {
    return this.storage.for(execution);
  }
}

declare module "cordis" {
  interface Context {
    database: SQLiteDatabaseService;
    pluginStorage: SQLitePluginStorageService;
  }
}

export function createSQLiteBootstrapDescriptor(
  options: SQLiteBootstrapOptions,
): BootstrapDescriptor {
  return {
    id: "seashard.database-sqlite",
    buildDigest: createHash("sha256").update("seashard.database-sqlite.bootstrap.v1").digest("hex"),
    inject: [],
    provides: ["database", "plugin-storage"],
    async load(ctx) {
      const lease = await DataRootLease.acquire(options.dataRoot);
      const pluginStorageRoot = join(options.dataRoot, "plugin-data");
      let databaseBroker: SQLiteDatabaseBroker | undefined;
      let storageBroker: SQLiteDatabaseBroker | undefined;
      try {
        await mkdir(pluginStorageRoot, { recursive: true });
        databaseBroker = await SQLiteDatabaseBroker.create({
          databasePath: options.databasePath ?? join(options.dataRoot, "seashard.sqlite3"),
          workerEntry: options.workerEntry,
          readWorkers: options.readWorkers,
        });
        storageBroker = await SQLiteDatabaseBroker.create({
          databasePath: options.pluginStoragePath ?? join(pluginStorageRoot, "documents.sqlite3"),
          workerEntry: options.workerEntry,
          readWorkers: 1,
        });
        const storageRepository = await storageBroker.registerCapsule(pluginDocumentDataCapsule);
        new SQLiteDatabaseService(ctx, databaseBroker);
        new SQLitePluginStorageService(ctx, new SQLitePluginDocumentStorage(storageRepository));
        const activeDatabaseBroker = databaseBroker;
        const activeStorageBroker = storageBroker;
        return async () => {
          try {
            await activeStorageBroker.close();
          } finally {
            try {
              await activeDatabaseBroker.close();
            } finally {
              await lease.release();
            }
          }
        };
      } catch (error) {
        try {
          await storageBroker?.close();
        } finally {
          try {
            await databaseBroker?.close();
          } finally {
            await lease.release();
          }
        }
        throw error;
      }
    },
  };
}

export { SQLiteDatabaseBroker } from "./broker";
export { DataRootLease } from "./data-root-lease";
export { pluginDocumentDataCapsule, SQLitePluginDocumentStorage } from "./plugin-storage";
