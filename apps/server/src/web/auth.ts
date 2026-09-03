import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const schemaVersion = 1;
const scryptKeyLength = 64;
const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const sessionLifetimeMilliseconds = 12 * 60 * 60 * 1_000;
export const serverSessionCookieName = "seashard_server_session";

interface AdministratorRecord {
  readonly schemaVersion: typeof schemaVersion;
  readonly username: string;
  readonly salt: string;
  readonly passwordHash: string;
  readonly scrypt: {
    readonly cost: typeof scryptCost;
    readonly blockSize: typeof scryptBlockSize;
    readonly parallelization: typeof scryptParallelization;
    readonly keyLength: typeof scryptKeyLength;
  };
}

interface SessionRecord {
  readonly username: string;
  readonly expiresAt: number;
}

export interface ServerAdministratorSession {
  readonly username: string;
}

interface ServerAdministratorAuthOptions {
  readonly now?: () => number;
  readonly sessionLifetimeMilliseconds?: number;
}

/** Server 管理员凭据落盘，短期会话只留在进程内；重启后必须重新登录。 */
export class ServerAdministratorAuth {
  private readonly authPath: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly sessionLifetimeMilliseconds: number;

  constructor(dataRoot: string, options: ServerAdministratorAuthOptions = {}) {
    this.authPath = join(dataRoot, "administrator.json");
    this.now = options.now ?? Date.now;
    this.sessionLifetimeMilliseconds =
      options.sessionLifetimeMilliseconds ?? sessionLifetimeMilliseconds;
    if (
      !Number.isSafeInteger(this.sessionLifetimeMilliseconds) ||
      this.sessionLifetimeMilliseconds <= 0
    ) {
      throw new TypeError("管理员会话有效期必须是正整数毫秒");
    }
  }

  async isConfigured(): Promise<boolean> {
    return Boolean(await this.readAdministrator());
  }

  async setup(usernameValue: unknown, passwordValue: unknown): Promise<ServerAdministratorSession> {
    const username = requireUsername(usernameValue);
    const password = requirePassword(passwordValue);
    const salt = randomBytes(32);
    const passwordHash = await derivePassword(password, salt);
    const record: AdministratorRecord = {
      schemaVersion,
      username,
      salt: salt.toString("base64url"),
      passwordHash: passwordHash.toString("base64url"),
      scrypt: {
        cost: scryptCost,
        blockSize: scryptBlockSize,
        parallelization: scryptParallelization,
        keyLength: scryptKeyLength,
      },
    };

    await mkdir(dirname(this.authPath), { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // wx 让并发的两个首次设置请求只有一个成功，避免后到请求覆盖管理员。
      handle = await open(this.authPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if (hasCode(error, "EEXIST")) throw new AuthError("SETUP_COMPLETE", "管理员已经设置");
      throw error;
    } finally {
      await handle?.close();
    }
    return { username };
  }

  async login(usernameValue: unknown, passwordValue: unknown): Promise<string> {
    const username = requireUsername(usernameValue);
    const password = requirePassword(passwordValue);
    const administrator = await this.readAdministrator();
    if (!administrator) throw new AuthError("SETUP_REQUIRED", "请先设置管理员");

    const expected = Buffer.from(administrator.passwordHash, "base64url");
    const actual = await derivePassword(password, Buffer.from(administrator.salt, "base64url"));
    if (username !== administrator.username || !safeEqual(actual, expected)) {
      throw new AuthError("INVALID_CREDENTIALS", "用户名或密码错误");
    }

    this.removeExpiredSessions();
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, {
      username: administrator.username,
      expiresAt: this.now() + this.sessionLifetimeMilliseconds,
    });
    return token;
  }

  authenticate(cookieHeader: string | undefined): ServerAdministratorSession | undefined {
    this.removeExpiredSessions();
    const token = readCookie(cookieHeader, serverSessionCookieName);
    if (!token) return undefined;
    const session = this.sessions.get(token);
    return session ? { username: session.username } : undefined;
  }

  logout(cookieHeader: string | undefined): void {
    const token = readCookie(cookieHeader, serverSessionCookieName);
    if (token) this.sessions.delete(token);
  }

  sessionCookie(token: string, secure: boolean): string {
    return `${serverSessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.sessionLifetimeMilliseconds / 1_000)}${secure ? "; Secure" : ""}`;
  }

  expiredSessionCookie(secure: boolean): string {
    return `${serverSessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  private async readAdministrator(): Promise<AdministratorRecord | undefined> {
    let source: string;
    try {
      source = await readFile(this.authPath, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
    return parseAdministrator(JSON.parse(source) as unknown);
  }

  private removeExpiredSessions(): void {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export class AuthError extends Error {
  readonly name = "AuthError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parseAdministrator(value: unknown): AdministratorRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Server administrator record must be an object");
  }
  const record = value as Record<string, unknown>;
  const parameters = record.scrypt as Record<string, unknown> | undefined;
  if (
    record.schemaVersion !== schemaVersion ||
    typeof record.username !== "string" ||
    typeof record.salt !== "string" ||
    typeof record.passwordHash !== "string" ||
    !parameters ||
    parameters.cost !== scryptCost ||
    parameters.blockSize !== scryptBlockSize ||
    parameters.parallelization !== scryptParallelization ||
    parameters.keyLength !== scryptKeyLength
  ) {
    throw new TypeError("Server administrator record is invalid");
  }
  const salt = Buffer.from(record.salt, "base64url");
  const passwordHash = Buffer.from(record.passwordHash, "base64url");
  if (salt.length !== 32 || passwordHash.length !== scryptKeyLength) {
    throw new TypeError("Server administrator credential bytes are invalid");
  }
  return record as unknown as AdministratorRecord;
}

function requireUsername(value: unknown): string {
  if (typeof value !== "string") throw new AuthError("INVALID_USERNAME", "管理员用户名无效");
  const username = value.trim();
  if (!/^[\p{L}\p{N}_.-]{3,64}$/u.test(username)) {
    throw new AuthError("INVALID_USERNAME", "用户名需要 3～64 个字母、数字、点、短横线或下划线");
  }
  return username;
}

function requirePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) {
    throw new AuthError("INVALID_PASSWORD", "密码长度需要为 12～128 个字符");
  }
  return value;
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      scryptKeyLength,
      {
        N: scryptCost,
        r: scryptBlockSize,
        p: scryptParallelization,
        maxmem: 32 * 1024 * 1024,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value || undefined;
  }
  return undefined;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
