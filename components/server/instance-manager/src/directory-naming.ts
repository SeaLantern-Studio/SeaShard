import { randomBytes } from "node:crypto";

const shortDirectoryIdAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 生成便于管理员直接识别的六位目录标识。 */
export function createShortRandomId(): string {
  const bytes = randomBytes(6);
  return Array.from(
    bytes,
    (byte) => shortDirectoryIdAlphabet[byte % shortDirectoryIdAlphabet.length],
  ).join("");
}
