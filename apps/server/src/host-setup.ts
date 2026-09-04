import { readHostInstallation } from "@seashard/host-installation";
import {
  ensureLocalHostInstallation,
  installBundledLinuxHost,
  installBundledMacHost,
  installBundledWindowsHost,
} from "@seashard/local-host-installer";
import {
  downloadVerifiedReleaseAsset,
  parseSeaShardReleaseCatalog,
  releaseCatalogUrl,
  resolveHostReleaseAsset,
} from "@seashard/release-catalog";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type ServerHostPreparationDisposition = "existing" | "installed" | "development-missing";

export type ServerBundledHostInstaller =
  | { readonly platform: "win32"; readonly installerPath: string }
  | {
      readonly platform: "darwin";
      readonly installerPath: string;
      readonly installerType: "application" | "package";
    }
  | {
      readonly platform: "linux";
      readonly hostImage: string;
      readonly installScript: string;
    };

interface PrepareServerLocalHostOptions {
  readonly dataRoot: string;
  readonly installerRoot: string;
  readonly downloadRoot?: string;
  readonly releaseVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly allowMissingInstaller?: boolean;
  readonly fetcher?: typeof fetch;
}

/**
 * Server 在创建 Controller Runtime 前先准备 Host。已存在的 Host 不启动安装器，也不改写
 * 安装类型；全新安装则执行 Server 随包携带的同一份独立 Host 安装器并等待控制端点。
 */
export async function prepareServerLocalHost(
  options: PrepareServerLocalHostOptions,
): Promise<ServerHostPreparationDisposition> {
  if (await readHostInstallation(options.dataRoot)) return "existing";

  const platform = options.platform ?? process.platform;
  let installer = resolveServerBundledHostInstaller(options.installerRoot, platform);
  if (!installer && options.releaseVersion && options.releaseVersion !== "0.0.0") {
    installer = await downloadReleasedHostInstaller(options, platform);
  }
  if (!installer) {
    if (options.allowMissingInstaller) return "development-missing";
    throw new Error(`Server Controller 缺少 ${platform} Host 安装文件：${options.installerRoot}`);
  }

  const environment = options.environment ?? process.env;
  const result = await ensureLocalHostInstallation({
    dataRoot: options.dataRoot,
    install: () => installServerHost(installer, options.dataRoot, environment),
  });
  return result.disposition;
}

/** 平台安装差异到此为止；上层始终只等待同一份 Host 安装记录和控制端点。 */
function installServerHost(
  installer: ServerBundledHostInstaller,
  dataRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (installer.platform === "win32") {
    return installBundledWindowsHost({
      dataRoot,
      installerPath: installer.installerPath,
      environment,
    });
  }
  if (installer.platform === "darwin") {
    return installBundledMacHost({
      dataRoot,
      installerPath: installer.installerPath,
      installerType: installer.installerType,
      environment,
    });
  }
  return installBundledLinuxHost({
    dataRoot,
    hostImage: installer.hostImage,
    installScript: installer.installScript,
    environment,
  });
}

async function downloadReleasedHostInstaller(
  options: PrepareServerLocalHostOptions,
  platform: NodeJS.Platform,
): Promise<ServerBundledHostInstaller | undefined> {
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") return undefined;
  const version = options.releaseVersion!;
  const response = await (options.fetcher ?? fetch)(releaseCatalogUrl(version), {
    headers: { Accept: "application/json", "User-Agent": "SeaShard-Server-Controller" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Host Release 清单下载失败（HTTP ${response.status}）`);
  }
  const release = parseSeaShardReleaseCatalog(await response.json());
  if (release.version !== version) {
    throw new Error(`Host Release 清单版本不匹配：期望 ${version}，收到 ${release.version}`);
  }
  const releasePlatform =
    platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  const packageType = platform === "win32" ? "nsis" : platform === "darwin" ? "pkg" : "appimage";
  const asset = resolveHostReleaseAsset(release, {
    platform: releasePlatform,
    architecture: options.architecture ?? process.arch,
    packageType,
  });
  const downloadRoot = options.downloadRoot ?? join(options.dataRoot, "downloads", "host");
  const downloaded = await downloadVerifiedReleaseAsset(
    asset,
    join(downloadRoot, asset.sha256, asset.name),
    options.fetcher,
  );
  if (platform === "win32") return { platform, installerPath: downloaded };
  if (platform === "darwin") {
    return { platform, installerPath: downloaded, installerType: "package" };
  }
  const installScript = join(options.installerRoot, "install.sh");
  if (!existsSync(installScript)) {
    throw new Error(`Server Controller 缺少 Linux Host 安装脚本：${installScript}`);
  }
  return { platform, hostImage: downloaded, installScript };
}
export function resolveServerBundledHostInstaller(
  installerRoot: string,
  platform: NodeJS.Platform = process.platform,
): ServerBundledHostInstaller | undefined {
  if (platform === "win32") {
    const installerPath = join(installerRoot, "SeaShardHostSetup.exe");
    return existsSync(installerPath) ? { platform, installerPath } : undefined;
  }
  if (platform === "darwin") {
    const installerPath = join(installerRoot, "SeaShardHost.app");
    return existsSync(installerPath)
      ? { platform, installerPath, installerType: "application" }
      : undefined;
  }
  if (platform === "linux") {
    const hostImage = join(installerRoot, "SeaShardHostSetup.AppImage");
    const installScript = join(installerRoot, "install.sh");
    return existsSync(hostImage) && existsSync(installScript)
      ? { platform, hostImage, installScript }
      : undefined;
  }
  return undefined;
}
