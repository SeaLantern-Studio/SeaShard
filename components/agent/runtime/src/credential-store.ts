import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const agentCredentialsFileName = "credentials.json";

export interface AgentCredentialCipher {
  encrypt(value: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}

interface StoredCredentialDocument {
  readonly version: 1;
  readonly entries: Readonly<Record<string, string>>;
}

const emptyCredentialDocument = `${JSON.stringify({ version: 1, entries: {} }, null, 2)}\n`;
const credentialIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const maximumCredentialFileBytes = 1024 * 1024;

/**
 * 凭据文件只保存 safeStorage 等 Host Cipher 产生的密文。
 *
 * models.yml 仍是供应商配置的唯一来源；该 Vault 只回答 credentialId 对应的秘密，
 * 从不向 Contract 返回明文。环境变量作为只读回退，便于 Node/Docker Host 注入凭据。
 */
export class AgentCredentialVault {
  readonly filePath: string;

  private readonly cipher: AgentCredentialCipher;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private plaintext = new Map<string, string>();
  private encrypted = new Map<string, string>();
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private disposed = false;

  constructor(options: {
    readonly userDataRoot: string;
    readonly cipher: AgentCredentialCipher;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  }) {
    this.filePath = join(options.userDataRoot, "agent", agentCredentialsFileName);
    this.cipher = options.cipher;
    this.environment = options.environment ?? process.env;
  }

  async initialize(): Promise<void> {
    this.assertNotDisposed();
    if (this.initialized) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await writeFile(this.filePath, emptyCredentialDocument, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const document = await readCredentialDocument(this.filePath);
    const plaintext = new Map<string, string>();
    for (const [credentialId, encoded] of Object.entries(document.entries)) {
      requireCredentialId(credentialId);
      let encrypted: Buffer;
      try {
        encrypted = Buffer.from(encoded, "base64");
      } catch {
        throw new Error(`Agent 凭据 ${credentialId} 的密文编码无效`);
      }
      if (!encrypted.byteLength) throw new Error(`Agent 凭据 ${credentialId} 的密文为空`);
      const value = this.cipher.decrypt(encrypted);
      if (!value) throw new Error(`Agent 凭据 ${credentialId} 解密后为空`);
      plaintext.set(credentialId, value);
    }
    this.encrypted = new Map(Object.entries(document.entries));
    this.plaintext = plaintext;
    this.initialized = true;
  }

  read(credentialIdValue: string): string | undefined {
    this.assertReady();
    const credentialId = requireCredentialId(credentialIdValue);
    const stored = this.plaintext.get(credentialId);
    if (stored !== undefined) return stored;
    const environmentValue = this.environment[credentialId];
    return environmentValue?.trim() || undefined;
  }

  write(credentialIdValue: string, value: string): Promise<void> {
    this.assertReady();
    const credentialId = requireCredentialId(credentialIdValue);
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError("Agent 凭据不能为空");
    }
    return this.enqueue(async () => {
      const encrypted = Buffer.from(this.cipher.encrypt(value)).toString("base64");
      if (!encrypted) throw new Error(`Agent 凭据 ${credentialId} 加密失败`);
      const nextEncrypted = new Map(this.encrypted);
      nextEncrypted.set(credentialId, encrypted);
      await this.persist(nextEncrypted);
      this.encrypted = nextEncrypted;
      const nextPlaintext = new Map(this.plaintext);
      nextPlaintext.set(credentialId, value);
      this.plaintext = nextPlaintext;
    });
  }

  remove(credentialIdValue: string): Promise<void> {
    this.assertReady();
    const credentialId = requireCredentialId(credentialIdValue);
    return this.enqueue(async () => {
      if (!this.encrypted.has(credentialId)) return;
      const nextEncrypted = new Map(this.encrypted);
      nextEncrypted.delete(credentialId);
      await this.persist(nextEncrypted);
      this.encrypted = nextEncrypted;
      const nextPlaintext = new Map(this.plaintext);
      nextPlaintext.delete(credentialId);
      this.plaintext = nextPlaintext;
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.writeQueue;
    this.plaintext.clear();
    this.encrypted.clear();
    this.initialized = false;
  }

  private async persist(entries: ReadonlyMap<string, string>): Promise<void> {
    const document: StoredCredentialDocument = {
      version: 1,
      entries: Object.fromEntries(
        [...entries].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    if (bytes.byteLength > maximumCredentialFileBytes) {
      throw new RangeError("Agent 凭据文件不能超过 1 MB");
    }
    const temporaryPath = join(
      dirname(this.filePath),
      `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  private assertReady(): void {
    this.assertNotDisposed();
    if (!this.initialized) throw new Error("Agent 凭据 Vault 尚未初始化");
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("Agent 凭据 Vault 已停止");
  }
}

async function readCredentialDocument(path: string): Promise<StoredCredentialDocument> {
  const bytes = await readFile(path);
  if (bytes.byteLength > maximumCredentialFileBytes) {
    throw new RangeError("Agent 凭据文件不能超过 1 MB");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Agent 凭据文件不是有效的 UTF-8 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent 凭据文件根节点必须是对象");
  }
  const record = value as { readonly version?: unknown; readonly entries?: unknown };
  if (record.version !== 1) throw new Error("Agent 凭据文件版本不受支持");
  if (!record.entries || typeof record.entries !== "object" || Array.isArray(record.entries)) {
    throw new Error("Agent 凭据文件 entries 必须是对象");
  }
  const entries = Object.fromEntries(
    Object.entries(record.entries).map(([credentialId, encoded]) => {
      requireCredentialId(credentialId);
      if (typeof encoded !== "string" || !encoded) {
        throw new Error(`Agent 凭据 ${credentialId} 的密文必须是非空字符串`);
      }
      return [credentialId, encoded];
    }),
  );
  return { version: 1, entries };
}

function requireCredentialId(value: unknown): string {
  if (typeof value !== "string" || !credentialIdPattern.test(value)) {
    throw new TypeError(`Agent credentialId 无效：${String(value)}`);
  }
  return value;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
