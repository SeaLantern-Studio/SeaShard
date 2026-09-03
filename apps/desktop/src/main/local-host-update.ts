import type { DesktopUpdatePlatform } from "@seashard/contracts";
import type { HostPackageType } from "@seashard/host-control";
import { isNewerDesktopVersion } from "./desktop-update-controller";

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
