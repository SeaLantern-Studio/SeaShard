import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withWriterLock, writeFileAtomically } from "./model-config/storage";

export const agentCredentialsFileName = "credentials.aes.json";
export const legacyAgentCredentialsFileName = "credentials.json";

export interface AgentCredentialCipher {
  encrypt(value: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}

interface StoredCredentialDocument {
  readonly version: 1;
  readonly entries: Readonly<Record<string, string>>;
}
interface DecryptedCredentialDocument {
  readonly encrypted: Map<string, string>;
  readonly plaintext: Map<string, string>;
}

const emptyCredentialDocument = `${JSON.stringify({ version: 1, entries: {} }, null, 2)}\n`;
const credentialIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const maximumCredentialFileBytes = 1024 * 1024;

/**
 * 所有 Controller 共用的 AES 凭据文件。
 *
 * models.yml 仍是供应商配置的唯一来源；该 Vault 只回答 credentialId 对应的秘密，
 * 从不向 Contract 返回明文。环境变量作为只读回退，便于 Node/Docker Host 注入凭据。
 */
export class AgentCredentialVault {
  readonly filePath: string;

  private readonly cipher: AgentCredentialCipher;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly listeners = new Set<() => void>();
  private readonly watchDebounceMs: number;
  private readonly reportError: (error: unknown) => void;
  private plaintext = new Map<string, string>();
  private encrypted = new Map<string, string>();
  private operationQueue: Promise<void> = Promise.resolve();
  private watcher?: FSWatcher;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private initialized = false;
  private disposed = false;

  constructor(options: {
    readonly userDataRoot: string;
    readonly cipher: AgentCredentialCipher;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly watchDebounceMs?: number;
    readonly reportError?: (error: unknown) => void;
  }) {
    this.filePath = join(options.userDataRoot, "agent", agentCredentialsFileName);
    this.cipher = options.cipher;
    this.environment = options.environment ?? process.env;
    this.watchDebounceMs = options.watchDebounceMs ?? 100;
    if (!Number.isSafeInteger(this.watchDebounceMs) || this.watchDebounceMs < 0) {
      throw new RangeError("Agent 凭据监听稳定窗口必须是非负安全整数");
    }
    this.reportError =
      options.reportError ?? ((error) => console.error("Agent credential vault failed", error));
  }

  async initialize(): Promise<void> {
    this.assertNotDisposed();
    if (this.initialized) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await withWriterLock(
      this.filePath,
      async () => {
        try {
          await readFile(this.filePath);
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
          await writeFile(this.filePath, emptyCredentialDocument, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
        }
      },
      "Agent 凭据正在被另一个 SeaShard 进程初始化",
    );
    this.accept(await readDecryptedCredentialDocument(this.filePath, this.cipher), false);
    this.startWatcher();
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
    return this.enqueue(async () =>
      withWriterLock(
        this.filePath,
        async () => {
          const current = await readDecryptedCredentialDocument(this.filePath, this.cipher);
          const encrypted = Buffer.from(this.cipher.encrypt(value)).toString("base64");
          if (!encrypted) throw new Error(`Agent 凭据 ${credentialId} 加密失败`);
          current.encrypted.set(credentialId, encrypted);
          current.plaintext.set(credentialId, value);
          await persistCredentialDocument(this.filePath, current.encrypted);
          this.accept(current, true);
        },
        "Agent 凭据正在被另一个 SeaShard 进程写入",
      ),
    );
  }

  remove(credentialIdValue: string): Promise<void> {
    this.assertReady();
    const credentialId = requireCredentialId(credentialIdValue);
    return this.enqueue(async () =>
      withWriterLock(
        this.filePath,
        async () => {
          const current = await readDecryptedCredentialDocument(this.filePath, this.cipher);
          const changed = current.encrypted.delete(credentialId);
          current.plaintext.delete(credentialId);
          if (changed) await persistCredentialDocument(this.filePath, current.encrypted);
          this.accept(current, true);
        },
        "Agent 凭据正在被另一个 SeaShard 进程写入",
      ),
    );
  }

  /**
   * 把旧凭据文件解密后合并到共享 AES Vault。共享目标中已有的 ID 保持不变，
   * 这样多个 Controller 首次启动时不会互相覆盖刚保存的凭据。
   */
  async migrateLegacyCredentials(options: {
    readonly userDataRoot: string;
    readonly cipher: Pick<AgentCredentialCipher, "decrypt">;
    readonly fileName?: string;
  }): Promise<number> {
    this.assertReady();
    const sourcePath = join(
      options.userDataRoot,
      "agent",
      options.fileName ?? legacyAgentCredentialsFileName,
    );
    if (sourcePath === this.filePath) return 0;
    let source: DecryptedCredentialDocument;
    try {
      source = await readDecryptedCredentialDocument(sourcePath, options.cipher);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return 0;
      throw error;
    }

    const imported = await this.enqueue(async () =>
      withWriterLock(
        this.filePath,
        async () => {
          const current = await readDecryptedCredentialDocument(this.filePath, this.cipher);
          let count = 0;
          for (const [credentialId, value] of source.plaintext) {
            if (current.encrypted.has(credentialId)) continue;
            current.encrypted.set(
              credentialId,
              Buffer.from(this.cipher.encrypt(value)).toString("base64"),
            );
            current.plaintext.set(credentialId, value);
            count += 1;
          }
          if (count > 0) await persistCredentialDocument(this.filePath, current.encrypted);
          this.accept(current, true);
          return count;
        },
        "Agent 凭据正在被另一个 SeaShard 进程写入",
      ),
    );
    await unlink(sourcePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return imported;
  }

  onChanged(listener: () => void): () => void {
    this.assertReady();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.initialized = false;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    await this.operationQueue;
    this.plaintext.clear();
    this.encrypted.clear();
    this.listeners.clear();
  }

  private startWatcher(): void {
    const fileName = basename(this.filePath);
    this.watcher = watch(dirname(this.filePath), { persistent: false }, (_event, changed) => {
      if (changed !== null && changed.toString() !== fileName) return;
      this.scheduleReload();
    });
    this.watcher.on("error", this.reportError);
  }

  private scheduleReload(): void {
    if (this.disposed) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.enqueue(async () => {
        const current = await readDecryptedCredentialDocument(this.filePath, this.cipher);
        this.accept(current, true);
      }).catch(this.reportError);
    }, this.watchDebounceMs);
  }

  private accept(current: DecryptedCredentialDocument, notify: boolean): void {
    const changed = !mapsEqual(this.encrypted, current.encrypted);
    this.encrypted = current.encrypted;
    this.plaintext = current.plaintext;
    if (!changed || !notify) return;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
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

async function readDecryptedCredentialDocument(
  path: string,
  cipher: Pick<AgentCredentialCipher, "decrypt">,
): Promise<DecryptedCredentialDocument> {
  const document = await readCredentialDocument(path);
  const encryptedEntries = new Map<string, string>();
  const plaintext = new Map<string, string>();
  for (const [credentialId, encoded] of Object.entries(document.entries)) {
    let encrypted: Buffer;
    try {
      encrypted = Buffer.from(encoded, "base64");
    } catch {
      throw new Error(`Agent 凭据 ${credentialId} 的密文编码无效`);
    }
    if (!encrypted.byteLength) throw new Error(`Agent 凭据 ${credentialId} 的密文为空`);
    const value = cipher.decrypt(encrypted);
    if (!value) throw new Error(`Agent 凭据 ${credentialId} 解密后为空`);
    encryptedEntries.set(credentialId, encoded);
    plaintext.set(credentialId, value);
  }
  return { encrypted: encryptedEntries, plaintext };
}

async function persistCredentialDocument(
  path: string,
  entries: ReadonlyMap<string, string>,
): Promise<void> {
  const document: StoredCredentialDocument = {
    version: 1,
    entries: Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right))),
  };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (bytes.byteLength > maximumCredentialFileBytes) {
    throw new RangeError("Agent 凭据文件不能超过 1 MB");
  }
  await writeFileAtomically(path, bytes);
}

function mapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
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

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
