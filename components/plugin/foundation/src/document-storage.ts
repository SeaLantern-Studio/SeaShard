import {
  defineDataCapsule,
  type DatabaseRow,
  type RegisteredDataCapsule,
} from "@seashard/database";
import type {
  ExecutionContext,
  JsonValue,
  PluginStorage,
  PluginStorageBroker,
  PluginStorageDeleteOptions,
  PluginStoragePutOptions,
  PluginStoredDocument,
} from "@seashard/plugin-sdk";

interface DocumentRow extends DatabaseRow {
  value_json: string;
  revision: number;
  updated_at: string;
  expires_at: string | null;
}

const maximumDocumentBytes = 1024 * 1024;
const maximumTtlMs = 365 * 24 * 60 * 60 * 1_000;
const storageKeyPattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9._/-]{0,254})?$/;

/**
 * 托管 JSON 文档存储的 Data Capsule。
 *
 * 主键同时包含插件 owner、runtime binding 和文档 key；namespace 隔离在 SQL 条件中
 * 固化，不能依赖上层调用者自觉过滤。
 */
export const pluginDocumentDataCapsule = defineDataCapsule({
  namespace: "plugin_documents",
  schemaVersion: 1,
  compatibilityFloor: 1,
  tables: ["plugin_documents"],
  migrations: [
    {
      version: 1,
      statements: [
        `CREATE TABLE plugin_documents (
          owner_id TEXT NOT NULL,
          runtime_id TEXT NOT NULL,
          document_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT,
          PRIMARY KEY (owner_id, runtime_id, document_key)
        ) STRICT`,
        `CREATE INDEX plugin_documents_expiry_idx
           ON plugin_documents(expires_at)
         WHERE expires_at IS NOT NULL`,
      ],
      verify: [
        {
          sql: `SELECT COUNT(*) = 1 AS valid
                  FROM sqlite_schema
                 WHERE type = 'table' AND name = 'plugin_documents'`,
          column: "valid",
          equals: 1,
        },
      ],
    },
  ],
  commands: [
    {
      id: "document.get",
      access: "read",
      result: "get",
      sql: `SELECT value_json, revision, updated_at, expires_at
              FROM plugin_documents
             WHERE owner_id = ?
               AND runtime_id = ?
               AND document_key = ?
               AND (expires_at IS NULL OR expires_at > ?)`,
    },
    {
      id: "document.delete-expired",
      access: "write",
      result: "run",
      sql: `DELETE FROM plugin_documents
             WHERE owner_id = ?
               AND runtime_id = ?
               AND document_key = ?
               AND expires_at IS NOT NULL
               AND expires_at <= ?`,
    },
    {
      id: "document.put",
      access: "write",
      result: "get",
      sql: `INSERT INTO plugin_documents (
              owner_id, runtime_id, document_key, value_json, revision, updated_at, expires_at
            ) VALUES (?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(owner_id, runtime_id, document_key) DO UPDATE SET
              value_json = excluded.value_json,
              revision = CASE
                WHEN plugin_documents.expires_at IS NOT NULL
                 AND plugin_documents.expires_at <= excluded.updated_at
                THEN 1
                ELSE plugin_documents.revision + 1
              END,
              updated_at = excluded.updated_at,
              expires_at = excluded.expires_at
            RETURNING value_json, revision, updated_at, expires_at`,
    },
    {
      id: "document.create",
      access: "write",
      result: "get",
      sql: `INSERT INTO plugin_documents (
              owner_id, runtime_id, document_key, value_json, revision, updated_at, expires_at
            ) VALUES (?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(owner_id, runtime_id, document_key) DO NOTHING
            RETURNING value_json, revision, updated_at, expires_at`,
    },
    {
      id: "document.update",
      access: "write",
      result: "get",
      sql: `UPDATE plugin_documents
               SET value_json = ?,
                   revision = revision + 1,
                   updated_at = ?,
                   expires_at = ?
             WHERE owner_id = ?
               AND runtime_id = ?
               AND document_key = ?
               AND revision = ?
               AND (expires_at IS NULL OR expires_at > ?)
         RETURNING value_json, revision, updated_at, expires_at`,
    },
    {
      id: "document.delete",
      access: "write",
      result: "run",
      sql: `DELETE FROM plugin_documents
             WHERE owner_id = ? AND runtime_id = ? AND document_key = ?`,
    },
    {
      id: "document.delete-revision",
      access: "write",
      result: "run",
      sql: `DELETE FROM plugin_documents
             WHERE owner_id = ?
               AND runtime_id = ?
               AND document_key = ?
               AND revision = ?`,
    },
  ],
});

/**
 * 基于类型化 Data Capsule 的插件文档仓库。
 *
 * 该类只接收由 Core 生成的 ExecutionContext，并把插件身份固化进返回的闭包，
 * 后续 get/put/delete API 不再接受 ownerId 或 runtimeId。
 */
export class SQLitePluginDocumentStorage implements PluginStorageBroker {
  constructor(private readonly repository: RegisteredDataCapsule) {}

  /** 为单个插件 runtime 创建命名空间已绑定的存储视图。 */
  for(execution: ExecutionContext): PluginStorage {
    if (execution.actorType !== "plugin" || !execution.runtimeId) {
      throw new Error("managed plugin storage requires a plugin runtime execution context");
    }
    const ownerId = execution.actorId;
    const runtimeId = execution.runtimeId;
    return {
      get: (key) => this.get(ownerId, runtimeId, key),
      put: (key, value, options) => this.put(ownerId, runtimeId, key, value, options),
      delete: (key, options) => this.delete(ownerId, runtimeId, key, options),
    };
  }

  private async get(
    ownerId: string,
    runtimeId: string,
    key: string,
  ): Promise<PluginStoredDocument | undefined> {
    validateKey(key);
    const result = await this.repository.execute("document.get", [ownerId, runtimeId, key, now()]);
    if (result.kind !== "get") throw unexpectedResult("document.get", result.kind);
    return result.row ? decodeDocument(result.row as DocumentRow) : undefined;
  }

  private async put(
    ownerId: string,
    runtimeId: string,
    key: string,
    value: JsonValue,
    options: PluginStoragePutOptions = {},
  ): Promise<PluginStoredDocument> {
    validateKey(key);
    const valueJson = serializeValue(value);
    const timestamp = now();
    const expiresAt = resolveExpiry(options.ttlMs, timestamp);
    const expectedRevision = options.expectedRevision;
    // 未提供 expectedRevision 表示显式接受 last-write-wins，并原子递增 revision。
    if (expectedRevision === undefined) {
      const result = await this.repository.execute("document.put", [
        ownerId,
        runtimeId,
        key,
        valueJson,
        timestamp,
        expiresAt,
      ]);
      return requiredDocument("document.put", result);
    }
    // null 表示 create-only。先在同一事务清理已过期记录，避免过期 key 永久阻塞创建。
    if (expectedRevision === null) {
      const results = await this.repository.transaction([
        {
          command: "document.delete-expired",
          parameters: [ownerId, runtimeId, key, timestamp],
        },
        {
          command: "document.create",
          parameters: [ownerId, runtimeId, key, valueJson, timestamp, expiresAt],
        },
      ]);
      const result = results[1];
      if (!result || result.kind !== "get") throw unexpectedResult("document.create", result?.kind);
      if (!result.row) throw new Error(`plugin storage revision conflict: ${key}`);
      return decodeDocument(result.row as DocumentRow);
    }
    // 数字 revision 走 CAS 更新；不匹配时 SQL 不返回行，调用方得到明确冲突。
    validateRevision(expectedRevision);
    const result = await this.repository.execute("document.update", [
      valueJson,
      timestamp,
      expiresAt,
      ownerId,
      runtimeId,
      key,
      expectedRevision,
      timestamp,
    ]);
    if (result.kind !== "get") throw unexpectedResult("document.update", result.kind);
    if (!result.row) throw new Error(`plugin storage revision conflict: ${key}`);
    return decodeDocument(result.row as DocumentRow);
  }

  /** 删除也支持 revision 前置条件，防止旧运行实例删除新运行实例的数据。 */
  private async delete(
    ownerId: string,
    runtimeId: string,
    key: string,
    options: PluginStorageDeleteOptions = {},
  ): Promise<boolean> {
    validateKey(key);
    if (options.expectedRevision !== undefined) validateRevision(options.expectedRevision);
    const result = await this.repository.execute(
      options.expectedRevision === undefined ? "document.delete" : "document.delete-revision",
      options.expectedRevision === undefined
        ? [ownerId, runtimeId, key]
        : [ownerId, runtimeId, key, options.expectedRevision],
    );
    if (result.kind !== "run") throw unexpectedResult("document.delete", result.kind);
    return Number(result.changes) === 1;
  }
}

function requiredDocument(
  command: string,
  result: Awaited<ReturnType<RegisteredDataCapsule["execute"]>>,
): PluginStoredDocument {
  if (result.kind !== "get") throw unexpectedResult(command, result.kind);
  if (!result.row) throw new Error(`database command ${command} returned no document`);
  return decodeDocument(result.row as DocumentRow);
}

function decodeDocument(row: DocumentRow): PluginStoredDocument {
  return {
    value: JSON.parse(row.value_json) as JsonValue,
    revision: row.revision,
    updatedAt: row.updated_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  };
}

/** 校验可诊断、可导出的层级 key，并拒绝空段及路径穿越语义。 */
function validateKey(key: string): void {
  if (
    !storageKeyPattern.test(key) ||
    key.includes("//") ||
    key.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError(`invalid plugin storage key: ${key}`);
  }
}

/** 在进入 Worker 前验证 JSON 形状和字节上限，避免 IPC 携带无效或超大文档。 */
function serializeValue(value: JsonValue): string {
  assertJsonValue(value, new WeakSet());
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("plugin storage value must be JSON serializable");
  if (Buffer.byteLength(json, "utf8") > maximumDocumentBytes) {
    throw new RangeError("plugin storage document exceeds 1 MiB");
  }
  return json;
}

/** 递归检查纯 JSON 值，同时用祖先集合识别循环引用。 */
function assertJsonValue(value: unknown, ancestors: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError("plugin storage value contains a non-finite number");
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(`plugin storage value contains unsupported ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("plugin storage value contains a cycle");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("plugin storage value must contain only arrays and plain objects");
  }
  ancestors.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    assertJsonValue(child, ancestors);
  }
  ancestors.delete(value);
}

/** 将相对 TTL 固化为 UTC 时间；持久层只比较绝对时间。 */
function resolveExpiry(ttlMs: number | undefined, timestamp: string): string | null {
  if (ttlMs === undefined) return null;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > maximumTtlMs) {
    throw new RangeError("plugin storage ttlMs must be between 1 ms and 365 days");
  }
  return new Date(Date.parse(timestamp) + ttlMs).toISOString();
}

function validateRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RangeError("plugin storage revision must be a positive integer");
  }
}

function unexpectedResult(command: string, kind: string | undefined): Error {
  return new Error(`database command ${command} returned ${kind ?? "no result"}`);
}

function now(): string {
  return new Date().toISOString();
}
