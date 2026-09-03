import type { AgentCredentialCipher } from "@seashard/agent-runtime";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const keyBytes = 32;
const nonceBytes = 12;
const authenticationTagBytes = 16;
const payloadVersion = 1;

/**
 * 为所有 Controller 创建同一种 AES-256-GCM 凭据加密器。
 *
 * 主密钥与密文同属 SeaShard 用户目录，并以当前系统用户权限保护；Desktop、Server 和
 * 后续无界面 Controller 因而不需要依赖 Electron 或系统凭据 API。
 */
export async function createAesAgentCredentialCipher(
  dataRoot: string,
): Promise<AgentCredentialCipher> {
  const keyPath = join(dataRoot, "agent", "credentials.key");
  const key = await readOrCreateKey(keyPath);
  return {
    encrypt(value) {
      const nonce = randomBytes(nonceBytes);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from([payloadVersion]), nonce, cipher.getAuthTag(), ciphertext]);
    },
    decrypt(value) {
      const payload = Buffer.from(value);
      const ciphertextOffset = 1 + nonceBytes + authenticationTagBytes;
      if (payload[0] !== payloadVersion || payload.byteLength <= ciphertextOffset) {
        throw new Error("Agent AES 凭据密文格式无效");
      }
      const nonce = payload.subarray(1, 1 + nonceBytes);
      const authenticationTag = payload.subarray(1 + nonceBytes, ciphertextOffset);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(authenticationTag);
      return Buffer.concat([
        decipher.update(payload.subarray(ciphertextOffset)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

async function readOrCreateKey(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true });
  const candidate = randomBytes(keyBytes);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(candidate);
    await handle.sync();
    return candidate;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  } finally {
    await handle?.close();
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const existing = await readFile(path);
    if (existing.byteLength === keyBytes) return existing;
    if (attempt === 39) {
      throw new Error(`Agent AES 凭据主密钥长度无效：${path}`);
    }
    await delay(25);
  }
  throw new Error(`Agent AES 凭据主密钥不可用：${path}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
