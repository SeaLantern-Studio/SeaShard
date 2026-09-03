import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const catalogSchemaVersion = 1;
const releaseVersionPattern = /^\d+\.\d+\.\d+$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const trustedRepositoryPath = "/SeaLantern-Studio/SeaShard/";

export interface SeaShardReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly downloadUrl: string;
}

export interface SeaShardRelease {
  readonly publishedAt?: string;
  readonly version: string;
  readonly assets: readonly SeaShardReleaseAsset[];
}

export interface HostReleaseTarget {
  readonly platform: "windows" | "macos" | "linux" | "other";
  readonly architecture: string;
  readonly packageType: "nsis" | "pkg" | "deb" | "appimage";
}

/** 静态清单只接受同一官方仓库、同一不可变 Tag 下的精确资产地址。 */
export function parseSeaShardReleaseCatalog(input: unknown): SeaShardRelease {
  if (
    !isObject(input) ||
    input.schemaVersion !== catalogSchemaVersion ||
    typeof input.version !== "string" ||
    input.tag !== `v${input.version}` ||
    !Array.isArray(input.assets) ||
    (input.publishedAt !== undefined && typeof input.publishedAt !== "string")
  ) {
    throw new Error("SeaShard Release 清单格式无效");
  }
  const version = input.version;
  if (!releaseVersionPattern.test(version)) {
    throw new Error(`SeaShard Release 清单版本号无效：${version}`);
  }

  const names = new Set<string>();
  const assets = input.assets.map((value, index): SeaShardReleaseAsset => {
    if (
      !isObject(value) ||
      typeof value.name !== "string" ||
      !Number.isSafeInteger(value.size) ||
      (value.size as number) < 0 ||
      typeof value.sha256 !== "string" ||
      typeof value.downloadUrl !== "string"
    ) {
      throw new Error(`SeaShard Release 清单资产 #${index + 1} 无效`);
    }
    if (names.has(value.name)) throw new Error(`SeaShard Release 清单资产名称重复：${value.name}`);
    names.add(value.name);
    if (!digestPattern.test(value.sha256)) {
      throw new Error(`SeaShard Release 清单资产摘要无效：${value.name}`);
    }
    const downloadUrl = trustedReleaseAssetUrl(value.downloadUrl, version, value.name);
    if (!downloadUrl) throw new Error(`SeaShard Release 清单资产地址无效：${value.name}`);
    return {
      name: value.name,
      size: value.size as number,
      sha256: value.sha256,
      downloadUrl,
    };
  });
  return {
    version,
    ...(typeof input.publishedAt === "string" ? { publishedAt: input.publishedAt } : {}),
    assets: Object.freeze(assets),
  };
}

/** Controller 按 Host 自己报告的安装类型选择产物，禁止在更新时切换安装渠道。 */
export function resolveHostReleaseAsset(
  release: SeaShardRelease,
  target: HostReleaseTarget,
): SeaShardReleaseAsset {
  if (target.architecture !== "x64" && target.architecture !== "arm64") {
    throw new Error(`当前架构 ${target.architecture} 暂无 Host 安装包`);
  }
  const extension =
    target.platform === "windows" && target.packageType === "nsis"
      ? "exe"
      : target.platform === "macos" && target.packageType === "pkg"
        ? "pkg"
        : target.platform === "linux" && target.packageType === "deb"
          ? "deb"
          : target.platform === "linux" && target.packageType === "appimage"
            ? "AppImage"
            : undefined;
  if (!extension) {
    throw new Error(`Host 安装类型 ${target.packageType} 与当前平台 ${target.platform} 不匹配`);
  }
  const expectedName = `SeaShard-Host-${target.platform}-${target.architecture}.${extension}`;
  const asset = release.assets.find(({ name }) => name === expectedName);
  if (!asset) throw new Error(`当前 Release 缺少 ${expectedName}`);
  return asset;
}

/** 流式写盘并同时计算 SHA-256；摘要或字节数不符时不会替换已验证缓存。 */
export async function downloadVerifiedReleaseAsset(
  asset: SeaShardReleaseAsset,
  destination: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const existing = await stat(destination).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (
    existing?.isFile() &&
    existing.size === asset.size &&
    (await sha256File(destination)) === asset.sha256
  ) {
    return destination;
  }

  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  const response = await fetcher(asset.downloadUrl, {
    headers: { Accept: "application/octet-stream", "User-Agent": "SeaShard-Release-Client" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Release 资产下载失败（HTTP ${response.status}）：${asset.name}`);
  }

  const handle = await open(temporary, "w", 0o600);
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await writeComplete(handle, value);
      hash.update(value);
      received += value.byteLength;
      if (received > asset.size) throw new Error(`Release 资产超过清单大小：${asset.name}`);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  if (received !== asset.size || hash.digest("hex") !== asset.sha256) {
    await rm(temporary, { force: true });
    throw new Error(`Release 资产完整性校验失败：${asset.name}`);
  }
  await rm(destination, { force: true });
  await rename(temporary, destination);
  return destination;
}

export function releaseCatalogUrl(version: string): string {
  if (!releaseVersionPattern.test(version)) throw new Error(`SeaShard 版本号无效：${version}`);
  return `https://github.com/SeaLantern-Studio/SeaShard/releases/download/v${version}/latest-release.json`;
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

async function writeComplete(
  handle: Awaited<ReturnType<typeof open>>,
  value: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
    if (bytesWritten <= 0) throw new Error(`Release 资产写入中断`);
    offset += bytesWritten;
  }
}

function trustedReleaseAssetUrl(value: string, version: string, name: string): string | undefined {
  try {
    const url = new URL(value);
    const expectedPath = `${trustedRepositoryPath}releases/download/v${version}/${name}`;
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.pathname !== expectedPath ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
