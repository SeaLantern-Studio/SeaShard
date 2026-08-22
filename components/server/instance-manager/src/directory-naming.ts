import { randomBytes } from "node:crypto";

const shortDirectoryIdAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
const shortDirectoryIdPattern = /^[a-z0-9]{6}$/u;
const worldStorageDirectoryPrefix = "worlds-";
const backupDirectoryPrefix = "backups-";

/** 生成便于管理员直接识别的六位目录标识。 */
export function createShortRandomId(): string {
  const bytes = randomBytes(6);
  return Array.from(
    bytes,
    (byte) => shortDirectoryIdAlphabet[byte % shortDirectoryIdAlphabet.length],
  ).join("");
}

/** 生成实例级、可写入 seashard.json 的世界存储外层目录名。 */
export function createWorldStorageDirectoryName(): string {
  return `${worldStorageDirectoryPrefix}${createShortRandomId()}`;
}

/** 生成实例级、可写入 seashard.json 的备份外层目录名。 */
export function createBackupDirectoryName(): string {
  return `${backupDirectoryPrefix}${createShortRandomId()}`;
}

export function expectWorldStorageDirectoryName(value: unknown): string {
  return expectPrefixedShortDirectoryName(value, worldStorageDirectoryPrefix, "世界存储外层目录名");
}

export function expectBackupDirectoryName(value: unknown): string {
  return expectPrefixedShortDirectoryName(value, backupDirectoryPrefix, "备份外层目录名");
}

function expectPrefixedShortDirectoryName(value: unknown, prefix: string, label: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    !shortDirectoryIdPattern.test(value.slice(prefix.length))
  ) {
    throw new TypeError(`${label}必须是${prefix}加六位小写字母数字标识。`);
  }
  return value;
}
