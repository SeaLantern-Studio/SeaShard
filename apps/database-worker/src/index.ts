import {
  dataCapsuleDigest,
  validateDataCapsule,
  type AllResult,
  type CommandAccess,
  type DataCapsule,
  type DataCommand,
  type DataCommandRequest,
  type DatabaseCheckpointResult,
  type DatabaseCommandResult,
  type DatabaseIntegrityResult,
  type DatabaseRow,
  type DatabaseValue,
  type GetResult,
  type RunResult,
} from "@seashard/database";
import type {
  DatabaseWorkerCommand,
  DatabaseWorkerData,
  DatabaseWorkerRequest,
  DatabaseWorkerResponse,
  DatabaseWorkerResult,
} from "@seashard/database/worker-protocol";
import { createHash } from "node:crypto";
import { backup, constants, DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

interface NamespaceRow {
  version: number;
}

interface MigrationRow {
  version: number;
  migration_digest: string;
}

interface RegisteredCapsule {
  capsule: DataCapsule;
  commands: ReadonlyMap<string, DataCommand>;
}

const commandVirtualTables = new Set(["json_each", "json_tree"]);
const migrationInternalTables = new Set([
  "sqlite_master",
  "sqlite_schema",
  "sqlite_sequence",
  "sqlite_temp_master",
  "sqlite_temp_schema",
]);
const schemaActionCodes = new Set([
  constants.SQLITE_ALTER_TABLE,
  constants.SQLITE_CREATE_INDEX,
  constants.SQLITE_CREATE_TABLE,
  constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_TEMP_TRIGGER,
  constants.SQLITE_CREATE_TEMP_VIEW,
  constants.SQLITE_CREATE_TRIGGER,
  constants.SQLITE_CREATE_VIEW,
  constants.SQLITE_CREATE_VTABLE,
  constants.SQLITE_DROP_INDEX,
  constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_TEMP_INDEX,
  constants.SQLITE_DROP_TEMP_TABLE,
  constants.SQLITE_DROP_TEMP_TRIGGER,
  constants.SQLITE_DROP_TEMP_VIEW,
  constants.SQLITE_DROP_TRIGGER,
  constants.SQLITE_DROP_VIEW,
  constants.SQLITE_DROP_VTABLE,
]);
const writeActionCodes = new Set([
  ...schemaActionCodes,
  constants.SQLITE_DELETE,
  constants.SQLITE_INSERT,
  constants.SQLITE_UPDATE,
]);

if (!parentPort) throw new Error("database worker requires a parent port");
const port = parentPort;
const data = workerData as DatabaseWorkerData;
const database = openDatabase(data);
const capsules = new Map<string, RegisteredCapsule>();

port.on("message", (request: DatabaseWorkerRequest) => {
  void receive(request);
});

async function receive(request: DatabaseWorkerRequest): Promise<void> {
  if (request.type !== "request") return;
  try {
    const value = await execute(request.command);
    const response: DatabaseWorkerResponse = {
      type: "response",
      id: request.id,
      ok: true,
      ...(value === undefined ? {} : { value }),
    };
    port.postMessage(response);
    if (request.command.type === "close") port.close();
  } catch (error) {
    const response: DatabaseWorkerResponse = {
      type: "response",
      id: request.id,
      ok: false,
      error: formatError(error),
    };
    port.postMessage(response);
  }
}

async function execute(command: DatabaseWorkerCommand): Promise<DatabaseWorkerResult> {
  switch (command.type) {
    case "ping":
      return undefined;
    case "register":
      registerCapsule(command.capsule, command.digest);
      return undefined;
    case "execute":
      return executeDataCommand(
        requireCapsule(command.namespace, command.digest),
        command.command,
        command.parameters,
      );
    case "transaction":
      assertRole("writer");
      return executeTransaction(
        requireCapsule(command.namespace, command.digest),
        command.requests,
      );
    case "quick-check":
      assertRole("maintenance");
      return quickCheck();
    case "checkpoint":
      assertRole("maintenance");
      return checkpoint();
    case "backup":
      assertRole("maintenance");
      await backup(database, command.destination);
      return undefined;
    case "close":
      database.close();
      return undefined;
  }
}

function openDatabase(options: DatabaseWorkerData): DatabaseSync {
  const connection = new DatabaseSync(options.databasePath, {
    readOnly: options.role === "reader",
    enableForeignKeyConstraints: true,
    timeout: 5_000,
    defensive: true,
    allowExtension: false,
    limits: {
      attach: 0,
      sqlLength: 1_000_000,
      variableNumber: 2_048,
    },
  });
  if (options.role === "reader") {
    connection.exec("PRAGMA query_only = ON;");
  } else {
    connection.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    ensureFoundation(connection);
  }
  return connection;
}

function ensureFoundation(connection: DatabaseSync): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS seashard_schema_namespaces (
      namespace TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      compatibility_floor INTEGER NOT NULL,
      capsule_digest TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS seashard_schema_migrations (
      namespace TEXT NOT NULL,
      version INTEGER NOT NULL,
      migration_digest TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (namespace, version),
      FOREIGN KEY (namespace) REFERENCES seashard_schema_namespaces(namespace) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS seashard_schema_tables (
      table_name TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      FOREIGN KEY (namespace) REFERENCES seashard_schema_namespaces(namespace) ON DELETE RESTRICT
    ) STRICT;
  `);
}

function registerCapsule(capsule: DataCapsule, digest: string): void {
  validateDataCapsule(capsule);
  if (dataCapsuleDigest(capsule) !== digest) {
    throw new Error(`data capsule digest mismatch: ${capsule.namespace}`);
  }
  if (data.role === "reader") {
    capsules.set(digest, compileCapsule(capsule));
    return;
  }
  assertRole("writer");

  // 多个 Controller 可以打开同一权威数据库。命名空间检查、建表和全部迁移必须共享一个
  // BEGIN IMMEDIATE 临界区，否则两个进程会同时把“尚未注册”判断为真并重复写入。
  database.exec("BEGIN IMMEDIATE");
  try {
    let namespace = database
      .prepare("SELECT version FROM seashard_schema_namespaces WHERE namespace = ?")
      .get(capsule.namespace) as NamespaceRow | undefined;
    if (!namespace) {
      const timestamp = now();
      database
        .prepare(
          `INSERT INTO seashard_schema_namespaces (
             namespace, version, compatibility_floor, capsule_digest, updated_at
           ) VALUES (?, 0, ?, ?, ?)`,
        )
        .run(capsule.namespace, capsule.compatibilityFloor, digest, timestamp);
      namespace = { version: 0 };
    }
    for (const table of capsule.tables) claimTable(capsule.namespace, table);

    if (namespace.version > capsule.schemaVersion) {
      throw new Error(
        `database namespace ${capsule.namespace} schema ${namespace.version} is newer than this build (${capsule.schemaVersion})`,
      );
    }
    verifyAppliedMigrations(capsule, namespace.version);
    for (const migration of capsule.migrations) {
      if (migration.version <= namespace.version) continue;
      applyMigration(capsule, migration);
      namespace = { version: migration.version };
    }
    if (namespace.version < capsule.compatibilityFloor) {
      throw new Error(
        `database namespace ${capsule.namespace} schema ${namespace.version} is below compatibility floor ${capsule.compatibilityFloor}`,
      );
    }
    database
      .prepare(
        `UPDATE seashard_schema_namespaces
            SET compatibility_floor = ?, capsule_digest = ?, updated_at = ?
          WHERE namespace = ?`,
      )
      .run(capsule.compatibilityFloor, digest, now(), capsule.namespace);
    database.exec("COMMIT");
  } catch (error) {
    database.setAuthorizer(null);
    database.exec("ROLLBACK");
    throw error;
  }
  capsules.set(digest, compileCapsule(capsule));
}

function claimTable(namespace: string, table: string): void {
  const row = database
    .prepare("SELECT namespace FROM seashard_schema_tables WHERE table_name = ?")
    .get(table) as { namespace: string } | undefined;
  if (row && row.namespace !== namespace) {
    throw new Error(`database table ${table} is already owned by ${row.namespace}`);
  }
  database
    .prepare("INSERT OR IGNORE INTO seashard_schema_tables (table_name, namespace) VALUES (?, ?)")
    .run(table, namespace);
}

function verifyAppliedMigrations(capsule: DataCapsule, currentVersion: number): void {
  const rows = database
    .prepare(
      `SELECT version, migration_digest
         FROM seashard_schema_migrations
        WHERE namespace = ? AND version <= ?
        ORDER BY version`,
    )
    .all(capsule.namespace, currentVersion) as unknown as MigrationRow[];
  const byVersion = new Map(rows.map((row) => [row.version, row.migration_digest]));
  for (let version = 1; version <= currentVersion; version += 1) {
    const stored = byVersion.get(version);
    if (!stored) throw new Error(`missing migration ledger: ${capsule.namespace}@${version}`);
    const migration = capsule.migrations[version - 1];
    const expected = migrationDigest(migration);
    if (stored !== expected) {
      throw new Error(`migration digest changed: ${capsule.namespace}@${version}`);
    }
  }
}

function applyMigration(capsule: DataCapsule, migration: DataCapsule["migrations"][number]): void {
  try {
    withAuthorizer(capsule, "migration", () => {
      for (const [index, statement] of migration.statements.entries()) {
        try {
          database.exec(statement);
        } catch (error) {
          throw new Error(`statement ${index + 1} failed: ${formatError(error)}`, {
            cause: error,
          });
        }
      }
      verifyMigration(capsule, migration);
    });
    database
      .prepare(
        `INSERT INTO seashard_schema_migrations (
           namespace, version, migration_digest, applied_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(capsule.namespace, migration.version, migrationDigest(migration), now());
    database
      .prepare(
        `UPDATE seashard_schema_namespaces
            SET version = ?, compatibility_floor = ?, updated_at = ?
          WHERE namespace = ?`,
      )
      .run(migration.version, capsule.compatibilityFloor, now(), capsule.namespace);
  } catch (error) {
    database.setAuthorizer(null);
    throw new Error(
      `database migration failed: ${capsule.namespace}@${migration.version}: ${formatError(error)}`,
      { cause: error },
    );
  }
}

function verifyMigration(capsule: DataCapsule, migration: DataCapsule["migrations"][number]): void {
  for (const verification of migration.verify ?? []) {
    const row = database.prepare(verification.sql).get() as DatabaseRow | undefined;
    if (!row || !sameValue(row[verification.column], verification.equals)) {
      throw new Error(
        `migration verification failed: ${capsule.namespace}@${migration.version}.${verification.column}`,
      );
    }
  }
}

function compileCapsule(capsule: DataCapsule): RegisteredCapsule {
  return {
    capsule,
    commands: new Map(capsule.commands.map((command) => [command.id, command])),
  };
}

function requireCapsule(namespace: string, digest: string): RegisteredCapsule {
  const registered = capsules.get(digest);
  if (!registered || registered.capsule.namespace !== namespace) {
    throw new Error(`data capsule is not registered: ${namespace}#${digest}`);
  }
  return registered;
}

function executeDataCommand(
  registered: RegisteredCapsule,
  commandId: string,
  parameters: readonly DatabaseValue[],
): DatabaseCommandResult {
  const command = registered.commands.get(commandId);
  if (!command) {
    throw new Error(`unknown data command: ${registered.capsule.namespace}.${commandId}`);
  }
  if (data.role === "reader" && command.access !== "read") {
    throw new Error(`write command routed to database reader: ${command.id}`);
  }
  if (data.role === "maintenance") throw new Error("maintenance worker cannot execute commands");
  return withAuthorizer(registered.capsule, command.access, () =>
    runStatement(command, parameters),
  );
}

function executeTransaction(
  registered: RegisteredCapsule,
  requests: readonly DataCommandRequest[],
): readonly DatabaseCommandResult[] {
  if (!requests.length) return [];
  database.exec("BEGIN IMMEDIATE");
  try {
    const results = requests.map((request) =>
      executeDataCommand(registered, request.command, request.parameters ?? []),
    );
    database.exec("COMMIT");
    return results;
  } catch (error) {
    database.setAuthorizer(null);
    database.exec("ROLLBACK");
    throw error;
  }
}

function runStatement(
  command: DataCommand,
  parameters: readonly DatabaseValue[],
): DatabaseCommandResult {
  const statement = database.prepare(command.sql);
  switch (command.result) {
    case "run": {
      const result = statement.run(...parameters);
      return {
        kind: "run",
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      } satisfies RunResult;
    }
    case "get": {
      const row = statement.get(...parameters) as DatabaseRow | undefined;
      return { kind: "get", row: row ?? null } satisfies GetResult;
    }
    case "all": {
      const rows = statement.all(...parameters) as unknown as DatabaseRow[];
      return { kind: "all", rows } satisfies AllResult;
    }
  }
}

function withAuthorizer<T>(
  capsule: DataCapsule,
  mode: CommandAccess | "migration",
  executeAuthorized: () => T,
): T {
  const tables = new Set(capsule.tables);
  database.setAuthorizer((action, arg1, arg2, dbName) => {
    if (dbName && dbName !== "main" && dbName !== "temp") return constants.SQLITE_DENY;
    if (
      action === constants.SQLITE_ATTACH ||
      action === constants.SQLITE_DETACH ||
      action === constants.SQLITE_PRAGMA ||
      action === constants.SQLITE_CREATE_VTABLE ||
      action === constants.SQLITE_DROP_VTABLE
    ) {
      return constants.SQLITE_DENY;
    }
    if (
      action === constants.SQLITE_FUNCTION &&
      (arg2 ?? arg1)?.toLowerCase() === "load_extension"
    ) {
      return constants.SQLITE_DENY;
    }
    if (mode === "read" && writeActionCodes.has(action)) return constants.SQLITE_DENY;
    if (mode !== "migration" && schemaActionCodes.has(action)) return constants.SQLITE_DENY;

    let accessedTable: string | null = null;
    if (
      action === constants.SQLITE_READ ||
      action === constants.SQLITE_INSERT ||
      action === constants.SQLITE_UPDATE ||
      action === constants.SQLITE_DELETE ||
      action === constants.SQLITE_CREATE_TABLE ||
      action === constants.SQLITE_DROP_TABLE
    ) {
      accessedTable = arg1;
    } else if (
      action === constants.SQLITE_ALTER_TABLE ||
      action === constants.SQLITE_CREATE_INDEX ||
      action === constants.SQLITE_DROP_INDEX
    ) {
      accessedTable = arg2;
    }
    if (
      accessedTable &&
      !tables.has(accessedTable) &&
      !commandVirtualTables.has(accessedTable) &&
      !(mode === "migration" && migrationInternalTables.has(accessedTable))
    ) {
      return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
  });
  try {
    return executeAuthorized();
  } finally {
    database.setAuthorizer(null);
  }
}

function quickCheck(): DatabaseIntegrityResult {
  const rows = database.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
  const messages = rows.map((row) => row.quick_check);
  return { ok: messages.length === 1 && messages[0] === "ok", messages };
}

function checkpoint(): DatabaseCheckpointResult {
  const row = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
    busy: number;
    log: number;
    checkpointed: number;
  };
  return { busy: row.busy, log: row.log, checkpointed: row.checkpointed };
}

function assertRole(expected: DatabaseWorkerData["role"]): void {
  if (data.role !== expected) {
    throw new Error(`database command requires ${expected} worker, received ${data.role}`);
  }
}

function migrationDigest(migration: DataCapsule["migrations"][number]): string {
  return createHash("sha256").update(JSON.stringify(migration)).digest("hex");
}

function sameValue(left: DatabaseValue | undefined, right: DatabaseValue): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return (
      left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
  }
  return left === right;
}

function now(): string {
  return new Date().toISOString();
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
