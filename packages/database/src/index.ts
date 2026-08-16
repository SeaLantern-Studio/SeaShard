import { createHash } from "node:crypto";

export type DatabaseValue = string | number | bigint | Uint8Array | null;
export type DatabaseRow = Record<string, DatabaseValue>;
export type CommandAccess = "read" | "write";
export type CommandResultKind = "run" | "get" | "all";

export interface DataCommand {
  readonly id: string;
  readonly access: CommandAccess;
  readonly sql: string;
  readonly result: CommandResultKind;
}

export interface MigrationVerification {
  readonly sql: string;
  readonly column: string;
  readonly equals: DatabaseValue;
}

export interface DataMigration {
  readonly version: number;
  readonly statements: readonly string[];
  readonly verify?: readonly MigrationVerification[];
}

export interface DataCapsule {
  readonly namespace: string;
  readonly schemaVersion: number;
  readonly compatibilityFloor: number;
  readonly tables: readonly string[];
  readonly migrations: readonly DataMigration[];
  readonly commands: readonly DataCommand[];
}

export interface RunResult {
  readonly kind: "run";
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface GetResult {
  readonly kind: "get";
  readonly row: DatabaseRow | null;
}

export interface AllResult {
  readonly kind: "all";
  readonly rows: DatabaseRow[];
}

export type DatabaseCommandResult = RunResult | GetResult | AllResult;

export interface DataCommandRequest {
  readonly command: string;
  readonly parameters?: readonly DatabaseValue[];
}

export interface RegisteredDataCapsule {
  readonly namespace: string;
  readonly digest: string;
  execute(command: string, parameters?: readonly DatabaseValue[]): Promise<DatabaseCommandResult>;
  transaction(requests: readonly DataCommandRequest[]): Promise<readonly DatabaseCommandResult[]>;
}

export interface DatabaseDiagnostics {
  readonly writerQueueDepth: number;
  readonly readQueueDepth: number;
  readonly readWorkers: number;
  readonly registeredCapsules: number;
  readonly closed: boolean;
}

export interface DatabaseIntegrityResult {
  readonly ok: boolean;
  readonly messages: readonly string[];
}

export interface DatabaseCheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

export interface DatabaseService {
  registerCapsule(capsule: DataCapsule): Promise<RegisteredDataCapsule>;
  quickCheck(): Promise<DatabaseIntegrityResult>;
  checkpoint(): Promise<DatabaseCheckpointResult>;
  backup(destination: string): Promise<void>;
  diagnostics(): DatabaseDiagnostics;
  close(): Promise<void>;
}

const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/;
const commandPattern = /^[a-z][a-z0-9.-]{0,126}$/;

export function defineDataCapsule(capsule: DataCapsule): DataCapsule {
  validateDataCapsule(capsule);
  return capsule;
}

export function validateDataCapsule(capsule: DataCapsule): void {
  if (!identifierPattern.test(capsule.namespace)) {
    throw new TypeError(`invalid data capsule namespace: ${capsule.namespace}`);
  }
  if (!Number.isSafeInteger(capsule.schemaVersion) || capsule.schemaVersion < 1) {
    throw new TypeError(`invalid schema version for ${capsule.namespace}`);
  }
  if (
    !Number.isSafeInteger(capsule.compatibilityFloor) ||
    capsule.compatibilityFloor < 0 ||
    capsule.compatibilityFloor > capsule.schemaVersion
  ) {
    throw new TypeError(`invalid compatibility floor for ${capsule.namespace}`);
  }

  const tables = new Set<string>();
  for (const table of capsule.tables) {
    if (!identifierPattern.test(table)) throw new TypeError(`invalid capsule table: ${table}`);
    if (table.startsWith("sqlite_") || table.startsWith("seashard_schema_")) {
      throw new TypeError(`reserved capsule table: ${table}`);
    }
    if (tables.has(table)) throw new TypeError(`duplicate capsule table: ${table}`);
    tables.add(table);
  }
  if (!tables.size) throw new TypeError(`data capsule ${capsule.namespace} must own a table`);

  let expectedVersion = 1;
  for (const migration of capsule.migrations) {
    if (migration.version !== expectedVersion) {
      throw new TypeError(
        `data capsule ${capsule.namespace} migration ${migration.version} must be ${expectedVersion}`,
      );
    }
    if (
      !migration.statements.length ||
      migration.statements.some((statement) => !statement.trim())
    ) {
      throw new TypeError(
        `data capsule ${capsule.namespace} migration ${migration.version} is empty`,
      );
    }
    for (const verification of migration.verify ?? []) {
      if (!verification.sql.trim() || !identifierPattern.test(verification.column)) {
        throw new TypeError(
          `invalid verification in ${capsule.namespace} migration ${migration.version}`,
        );
      }
    }
    expectedVersion += 1;
  }
  if (capsule.migrations.length !== capsule.schemaVersion) {
    throw new TypeError(
      `data capsule ${capsule.namespace} declares schema ${capsule.schemaVersion} but has ${capsule.migrations.length} migrations`,
    );
  }

  const commands = new Set<string>();
  for (const command of capsule.commands) {
    if (!commandPattern.test(command.id)) {
      throw new TypeError(`invalid data command id: ${command.id}`);
    }
    if (commands.has(command.id)) throw new TypeError(`duplicate data command: ${command.id}`);
    if (!command.sql.trim()) throw new TypeError(`data command ${command.id} is empty`);
    commands.add(command.id);
  }
}

export function dataCapsuleDigest(capsule: DataCapsule): string {
  validateDataCapsule(capsule);
  return createHash("sha256").update(canonicalJson(capsule)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("data capsule contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`data capsule contains unsupported value: ${typeof value}`);
}
