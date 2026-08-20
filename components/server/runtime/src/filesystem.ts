import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

export interface ServerRuntimeFileSystem {
  access(path: string): Promise<void>;
  copyFile(source: string, target: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeBinaryFile(path: string, content: Uint8Array): Promise<void>;
  writeTextFile(path: string, content: string): Promise<void>;
  hashFile(path: string, algorithm: "md5" | "sha256"): Promise<string>;
}

export const defaultServerRuntimeFileSystem: ServerRuntimeFileSystem = {
  access,
  copyFile,
  createDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  readTextFile: (path) => readFile(path, "utf8"),
  hashFile: hashFileStreaming,
  writeBinaryFile: (path, content) => writeFile(path, content),
  writeTextFile: (path, content) => writeFile(path, content, "utf8"),
};

export async function readOptionalText(
  fileSystem: ServerRuntimeFileSystem,
  path: string,
): Promise<string | undefined> {
  try {
    return await fileSystem.readTextFile(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

export async function canAccess(
  fileSystem: ServerRuntimeFileSystem,
  path: string,
): Promise<boolean> {
  try {
    await fileSystem.access(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function hashFileStreaming(path: string, algorithm: "md5" | "sha256"): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash(algorithm);
    const input = createReadStream(path);
    input.once("error", rejectHash);
    input.on("data", (chunk: Buffer) => hash.update(chunk));
    input.once("end", () => resolveHash(hash.digest("hex")));
  });
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    Reflect.get(error, "code") === "ENOENT"
  );
}
