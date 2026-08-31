import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { hostControlProtocolVersion, type HostControlDescriptor } from "./protocol";

export interface HostControlLocation {
  readonly dataRoot: string;
  readonly socketPath: string;
  readonly descriptorPath: string;
}

/**
 * 地址只由规范化 dataRoot 决定。同一份数据目录因此天然汇聚到同一个 Host，
 * 同时避免把包含空格或非 ASCII 字符的完整路径塞进 Windows 命名管道。
 */
export async function resolveHostControlLocation(dataRoot: string): Promise<HostControlLocation> {
  await mkdir(dataRoot, { recursive: true });
  const canonicalRoot = await realpath(dataRoot);
  const normalized = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return {
    dataRoot: canonicalRoot,
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\seashard-host-${digest}`
        : join(canonicalRoot, `.seashard-host-${digest}.sock`),
    descriptorPath: join(canonicalRoot, "host-control.json"),
  };
}

export async function readHostControlDescriptor(
  dataRoot: string,
): Promise<HostControlDescriptor | undefined> {
  const location = await resolveHostControlLocation(dataRoot);
  let source: string;
  try {
    source = await readFile(location.descriptorPath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const value = JSON.parse(source) as Partial<HostControlDescriptor>;
  if (
    value.protocolVersion !== hostControlProtocolVersion ||
    value.socketPath !== location.socketPath ||
    value.descriptorPath !== location.descriptorPath ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.token) ||
    typeof value.pid !== "number" ||
    typeof value.startedAt !== "string"
  ) {
    throw new TypeError(`invalid SeaShard Host descriptor: ${location.descriptorPath}`);
  }
  return value as HostControlDescriptor;
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
