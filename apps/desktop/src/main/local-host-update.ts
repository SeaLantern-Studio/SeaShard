import type { DesktopUpdatePlatform } from "@seashard/contracts";
import type { HostPackageType } from "@seashard/host-control";
import { isNewerDesktopVersion } from "./desktop-update-controller";

export interface LocalHostReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly downloadUrl: string;
}

export interface SeaShardRelease {
  readonly version: string;
  readonly publishedAt?: string;
  readonly assets: readonly LocalHostReleaseAsset[];
}

export interface LocalHostReleaseTarget {
  readonly platform: DesktopUpdatePlatform;
  readonly architecture: string;
  readonly packageType: HostPackageType;
}

/** GitHub Release 是 Host 安装包的唯一可信索引；下载前仍必须校验 API 返回的 SHA-256。 */
export function parseSeaShardRelease(input: unknown): SeaShardRelease {
  if (!isObject(input) || typeof input.tag_name !== "string" || !Array.isArray(input.assets)) {
    throw new Error("GitHub Release 返回了无效的版本信息");
  }
  const version = input.tag_name.startsWith("v") ? input.tag_name.slice(1) : input.tag_name;
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`GitHub Release 版本号无效：${input.tag_name}`);
  }

  const assets = input.assets.flatMap((value): LocalHostReleaseAsset[] => {
    if (
      !isObject(value) ||
      typeof value.name !== "string" ||
      typeof value.size !== "number" ||
      typeof value.digest !== "string" ||
      typeof value.browser_download_url !== "string"
    ) {
      return [];
    }
    const digest = /^sha256:([a-f0-9]{64})$/u.exec(value.digest);
    if (!digest) return [];
    const downloadUrl = trustedReleaseAssetUrl(value.browser_download_url);
    if (!downloadUrl) return [];
    return [
      {
        name: value.name,
        size: value.size,
        sha256: digest[1]!,
        downloadUrl,
      },
    ];
  });
  return {
    version,
    ...(typeof input.published_at === "string" ? { publishedAt: input.published_at } : {}),
    assets: Object.freeze(assets),
  };
}

/** Controller 按 Host 自己报告或兼容推断出的安装类型选择独立安装包。 */
export function resolveLocalHostReleaseAsset(
  release: SeaShardRelease,
  target: LocalHostReleaseTarget,
): LocalHostReleaseAsset {
  if (target.architecture !== "x64" && target.architecture !== "arm64") {
    throw new Error(`当前架构 ${target.architecture} 暂无 Host 安装包`);
  }
  const platform =
    target.platform === "windows"
      ? "windows"
      : target.platform === "macos"
        ? "macos"
        : target.platform === "linux"
          ? "linux"
          : undefined;
  if (!platform) throw new Error(`当前平台 ${target.platform} 暂无 Host 安装包`);
  const extension =
    platform === "windows" && target.packageType === "nsis"
      ? "exe"
      : platform === "macos" && target.packageType === "pkg"
        ? "pkg"
        : platform === "linux" && target.packageType === "deb"
          ? "deb"
          : platform === "linux" && target.packageType === "appimage"
            ? "AppImage"
            : undefined;
  if (!extension) {
    throw new Error(`Host 安装类型 ${target.packageType} 与当前平台 ${platform} 不匹配`);
  }
  const expectedName = `SeaShard-Host-${platform}-${target.architecture}.${extension}`;
  const asset = release.assets.find((value) => value.name === expectedName);
  if (!asset) throw new Error(`当前 Release 缺少 ${expectedName}`);
  return asset;
}

export interface HostUpdatePackageTypeResolution {
  readonly platform: DesktopUpdatePlatform;
  readonly descriptorPackageType?: HostPackageType;
  readonly installationPackageType?: HostPackageType;
  readonly installationKind?: "standalone" | "bundled";
  readonly legacyExecutablePath?: string;
  readonly legacyEnvironment?: Readonly<Record<string, string | undefined>>;
}

/**
 * 新版 Host 直接报告安装类型。旧版 Linux Host 只在字段缺失时读取进程证据；无法确认
 * 就返回 undefined，调用方必须拒绝自动更新，不能猜测或切换安装方式。
 */
export function resolveHostUpdatePackageType(
  input: HostUpdatePackageTypeResolution,
): HostPackageType | undefined {
  const recorded = input.descriptorPackageType ?? input.installationPackageType;
  if (recorded) return recorded;
  if (input.platform === "windows") return "nsis";
  if (input.platform === "macos") return "pkg";
  if (input.platform !== "linux") return undefined;
  if (
    input.legacyEnvironment?.APPIMAGE ||
    input.legacyEnvironment?.SEASHARD_HOST_INSTALLED_EXECUTABLE
  ) {
    return "appimage";
  }
  const executablePath = input.legacyExecutablePath?.replaceAll("\\", "/").toLowerCase();
  if (executablePath?.startsWith("/opt/")) return "deb";
  if (
    executablePath?.includes("/.mount_") ||
    executablePath?.includes("/.local/share/seashard/host/")
  ) {
    return "appimage";
  }
  if (input.installationKind === "bundled") return "appimage";
  return undefined;
}

export function isLocalHostUpdateAvailable(
  installed: boolean,
  currentVersion: string | undefined,
  latestVersion: string,
): boolean {
  if (!installed) return false;
  if (!currentVersion) return true;
  return isNewerDesktopVersion(currentVersion, latestVersion);
}

function trustedReleaseAssetUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      !url.pathname.startsWith("/SeaLantern-Studio/SeaShard/releases/download/")
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
