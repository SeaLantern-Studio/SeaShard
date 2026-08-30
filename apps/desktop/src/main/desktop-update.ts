import type { DesktopUpdateClientService, DesktopUpdateSnapshot } from "@seashard/contracts";
import { app, net, shell } from "electron";
import electronUpdater, { type ProgressInfo } from "electron-updater";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DesktopUpdateController,
  isNewerDesktopVersion,
  type DesktopUpdateCheckResult,
  type DesktopUpdateEnvironment,
} from "./desktop-update-controller";

const { autoUpdater } = electronUpdater;

const githubLatestReleaseApi =
  "https://api.github.com/repos/SeaLantern-Studio/SeaShard/releases/latest";
const githubLatestReleasePage = "https://github.com/SeaLantern-Studio/SeaShard/releases/latest";

export interface ElectronDesktopUpdateService extends DesktopUpdateClientService {
  dispose(): void;
}

/**
 * Windows 与 Linux 由 electron-updater 下载并安装；未签名 macOS 构建只读取 GitHub
 * Release 版本，并把安装动作交给浏览器和 Finder，避免调用要求 Developer ID 的 Squirrel.Mac。
 */
export function createElectronDesktopUpdateService(
  currentVersion: string,
): ElectronDesktopUpdateService {
  const environment = readDesktopUpdateEnvironment(currentVersion);
  const controller = new DesktopUpdateController(environment);
  const updater = autoUpdater;
  const manualMacDownload = environment.platform === "darwin";

  if (!manualMacDownload) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.logger = console;
    if (environment.platform === "win32" && environment.architecture === "arm64") {
      updater.channel = "latest-arm64";
      // channel setter 会默认允许降级；稳定更新通道必须继续保持单向升级。
      updater.allowDowngrade = false;
    }
  }

  const handleProgress = (progress: ProgressInfo): void => {
    controller.reportProgress({
      percent: progress.percent,
      transferredBytes: progress.transferred,
      totalBytes: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  };
  const handleError = (error: Error): void => controller.reportError(readableUpdateError(error));
  if (!manualMacDownload) {
    updater.on("download-progress", handleProgress);
    updater.on("error", handleError);
  }

  const checkForUpdates = async (): Promise<DesktopUpdateCheckResult> => {
    if (manualMacDownload) return checkLatestMacRelease(currentVersion);
    try {
      const result = await updater.checkForUpdates();
      if (!result) throw new Error("当前安装环境无法启动更新检查");
      return {
        available: result.isUpdateAvailable,
        latestVersion: result.updateInfo.version,
        ...(result.updateInfo.releaseDate ? { releaseDate: result.updateInfo.releaseDate } : {}),
      };
    } catch (error) {
      throw readableUpdateError(error);
    }
  };

  return {
    getSnapshot: async () => controller.getSnapshot(),
    check: () => controller.check(checkForUpdates),
    apply: () => {
      if (manualMacDownload) {
        return controller.openDownloadPage(() => shell.openExternal(githubLatestReleasePage));
      }
      return controller.installAutomatically(
        async () => {
          try {
            return await updater.downloadUpdate();
          } catch (error) {
            throw readableUpdateError(error);
          }
        },
        // 用户已经明确点击“一键更新”；NSIS/AppImage 静默替换，DEB 保留系统鉴权框。
        () => updater.quitAndInstall(true, true),
      );
    },
    onSnapshotChanged: (listener: (snapshot: DesktopUpdateSnapshot) => void) =>
      controller.onSnapshotChanged(listener),
    dispose: () => {
      if (!manualMacDownload) {
        updater.off("download-progress", handleProgress);
        updater.off("error", handleError);
      }
    },
  };
}

function readDesktopUpdateEnvironment(currentVersion: string): DesktopUpdateEnvironment {
  return {
    currentVersion,
    isPackaged: app.isPackaged,
    platform: process.platform,
    architecture: process.arch,
    ...(process.env.APPIMAGE ? { appImagePath: process.env.APPIMAGE } : {}),
    ...(process.platform === "linux" ? { linuxPackageType: readLinuxPackageType() } : {}),
  };
}

/** DEB 包由 electron-builder 写入 package-type；读取失败代表普通解包目录。 */
function readLinuxPackageType(): string | undefined {
  try {
    return readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** macOS 只读取公开 Release 元数据；下载页 URL 固定在项目仓库，响应内容不能控制跳转。 */
async function checkLatestMacRelease(currentVersion: string): Promise<DesktopUpdateCheckResult> {
  try {
    const response = await net.fetch(githubLatestReleaseApi, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "SeaShard-Desktop-Updater",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.status === 404) throw new Error("当前还没有可供下载的正式 Release");
    if (!response.ok) throw new Error(`GitHub Release 检查失败（HTTP ${response.status}）`);

    const release: unknown = await response.json();
    if (!isJsonObject(release) || typeof release.tag_name !== "string") {
      throw new Error("GitHub Release 返回了无效的版本信息");
    }
    const latestVersion = release.tag_name.startsWith("v")
      ? release.tag_name.slice(1)
      : release.tag_name;
    return {
      available: isNewerDesktopVersion(currentVersion, latestVersion),
      latestVersion,
      ...(typeof release.published_at === "string" ? { releaseDate: release.published_at } : {}),
    };
  } catch (error) {
    throw readableUpdateError(error);
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readableUpdateError(error: unknown): Error {
  const value = error instanceof Error ? error : new Error(String(error));
  const message = value.message;
  if (/404|latest(?:-arm64)?(?:-linux(?:-arm64)?)?\.yml/u.test(message)) {
    return new Error("当前 Release 缺少此平台的更新元数据");
  }
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|network/u.test(message)) {
    return new Error("无法连接 SeaShard 更新服务，请检查网络后重试");
  }
  return value;
}
