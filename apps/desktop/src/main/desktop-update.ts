import type {
  DesktopUpdateComponent,
  DesktopUpdateFinishRequest,
  DesktopUpdateProgress,
  DesktopUpdateSnapshot,
} from "@seashard/contracts";
import { readHostInstallation } from "@seashard/host-installation";
import {
  readHostControlDescriptor,
  type HostControlDescriptor,
  type HostPackageType,
} from "@seashard/host-control";
import { app, net, shell } from "electron";
import electronUpdater, { type ProgressInfo } from "electron-updater";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DesktopUpdateController,
  isNewerDesktopVersion,
  type DesktopUpdateCheckResult,
  type DesktopUpdateEnvironment,
} from "./desktop-update-controller";
import {
  isLocalHostUpdateAvailable,
  parseSeaShardRelease,
  resolveLocalHostReleaseAsset,
  resolveHostUpdatePackageType,
  type LocalHostReleaseAsset,
  type SeaShardRelease,
} from "./local-host-update";

const { autoUpdater } = electronUpdater;
const githubLatestReleaseApi =
  "https://api.github.com/repos/SeaLantern-Studio/SeaShard/releases/latest";
const githubLatestReleasePage = "https://github.com/SeaLantern-Studio/SeaShard/releases/latest";
const localHostReadyTimeoutMs = 60_000;

export type ElectronDesktopUpdatePreparation = "external-download" | "install-ready";

export interface ElectronDesktopUpdateInstallResult {
  readonly controllerInstallerStarted: boolean;
  readonly localHostUpdated: boolean;
  readonly externalHostInstallerOpened: boolean;
}

/** 安装包句柄与本机 Host 安装路径只存在于 Electron Main。 */
export interface ElectronDesktopUpdateService {
  getSnapshot(): DesktopUpdateSnapshot;
  check(): Promise<DesktopUpdateSnapshot>;
  prepare(): Promise<ElectronDesktopUpdatePreparation>;
  isRestartRequired(): boolean;
  install(
    afterInstall: DesktopUpdateFinishRequest["afterInstall"],
  ): Promise<ElectronDesktopUpdateInstallResult>;
  onSnapshotChanged(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void;
  dispose(): void;
}

/**
 * 检查入口统一读取 Release，但 Controller 与本机 Host 分别比较版本、下载制品和执行
 * 自己的安装器。远程 Host 不进入这个 Main 进程级更新服务。
 */
export function createElectronDesktopUpdateService(
  currentVersion: string,
  localHostDataRoot: string,
): ElectronDesktopUpdateService {
  const environment = readDesktopUpdateEnvironment(currentVersion);
  const controller = new DesktopUpdateController(environment);
  const updater = autoUpdater;
  const manualMacDownload = environment.platform === "darwin";
  let selectedHostAsset: LocalHostReleaseAsset | undefined;
  let selectedHostPackageType: HostPackageType | undefined;
  let downloadedHostInstaller: string | undefined;

  if (!manualMacDownload) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = false;
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
    try {
      const releaseTask = fetchLatestSeaShardRelease();
      const controllerTask = manualMacDownload ? undefined : updater.checkForUpdates();
      const [release, controllerResult] = await Promise.all([releaseTask, controllerTask]);
      if (!manualMacDownload && !controllerResult) {
        throw new Error("当前安装环境无法启动 Controller 更新检查");
      }

      const controllerLatestVersion = manualMacDownload
        ? release.version
        : controllerResult!.updateInfo.version;
      const controllerAvailable = manualMacDownload
        ? isNewerDesktopVersion(currentVersion, controllerLatestVersion)
        : controllerResult!.isUpdateAvailable;
      const installation = await readHostInstallation(localHostDataRoot);
      const descriptor = installation
        ? await readHostControlDescriptor(localHostDataRoot)
        : undefined;
      const hostAvailable = isLocalHostUpdateAvailable(
        Boolean(installation),
        descriptor?.seaShardVersion,
        release.version,
      );
      const legacyProcess =
        hostAvailable &&
        controller.getSnapshot().platform === "linux" &&
        !descriptor?.packageType &&
        !installation?.packageType
          ? await readLegacyLinuxHostProcess(descriptor)
          : {};
      const hostPackageType = resolveHostUpdatePackageType({
        platform: controller.getSnapshot().platform,
        ...(descriptor?.packageType ? { descriptorPackageType: descriptor.packageType } : {}),
        ...(installation?.packageType ? { installationPackageType: installation.packageType } : {}),
        ...(installation ? { installationKind: installation.kind } : {}),
        ...legacyProcess,
      });
      if (hostAvailable && !hostPackageType) {
        throw new Error("无法确认旧版 Linux Host 的安装类型，请先重新启动 Host 后再检查更新");
      }
      selectedHostPackageType = hostAvailable ? hostPackageType : undefined;
      selectedHostAsset =
        hostAvailable && hostPackageType
          ? resolveLocalHostReleaseAsset(release, {
              platform: controller.getSnapshot().platform,
              architecture: environment.architecture,
              packageType: hostPackageType,
            })
          : undefined;
      downloadedHostInstaller = undefined;

      const availableComponents: DesktopUpdateComponent[] = [];
      if (controllerAvailable) availableComponents.push("controller");
      if (hostAvailable) availableComponents.push("local-host");
      return {
        latestVersion: controllerLatestVersion,
        availableComponents,
        localHost: {
          installed: Boolean(installation),
          ...(descriptor?.seaShardVersion ? { currentVersion: descriptor.seaShardVersion } : {}),
          latestVersion: release.version,
          updateAvailable: hostAvailable,
        },
        ...(manualMacDownload
          ? release.publishedAt
            ? { releaseDate: release.publishedAt }
            : {}
          : controllerResult!.updateInfo.releaseDate
            ? { releaseDate: controllerResult!.updateInfo.releaseDate }
            : {}),
      };
    } catch (error) {
      throw readableUpdateError(error);
    }
  };

  return {
    getSnapshot: () => controller.getSnapshot(),
    check: () => controller.check(checkForUpdates),
    prepare: async () => {
      const components = controller.getSnapshot().availableComponents ?? [];
      if (manualMacDownload && components.length === 1 && components[0] === "controller") {
        await controller.openDownloadPage(() => shell.openExternal(githubLatestReleasePage));
        return "external-download";
      }

      await controller.downloadAutomatically(async () => {
        if (components.includes("local-host")) {
          if (!selectedHostAsset) throw new Error("本机 Host 更新缺少独立安装包");
          controller.setDownloadComponent("local-host");
          downloadedHostInstaller = await downloadLocalHostInstaller(
            selectedHostAsset,
            controller.reportProgress.bind(controller),
          );
        }
        if (components.includes("controller")) {
          if (manualMacDownload) {
            await shell.openExternal(githubLatestReleasePage);
          } else {
            controller.setDownloadComponent("controller");
            try {
              await updater.downloadUpdate();
            } catch (error) {
              throw readableUpdateError(error);
            }
          }
        }
      });
      return "install-ready";
    },
    isRestartRequired: () => controller.getSnapshot().state === "restart-required",
    install: async (afterInstall) => {
      const components = controller.getSnapshot().availableComponents ?? [];
      let controllerInstallerStarted = false;
      let localHostUpdated = false;
      let externalHostInstallerOpened = false;

      await controller.installDownloaded(async () => {
        if (components.includes("local-host")) {
          if (!selectedHostAsset || !selectedHostPackageType || !downloadedHostInstaller) {
            throw new Error("本机 Host 独立安装包尚未下载完成");
          }
          const hostInstall = await installLocalHostPackage({
            asset: selectedHostAsset,
            installerPath: downloadedHostInstaller,
            dataRoot: localHostDataRoot,
            targetVersion:
              controller.getSnapshot().localHost?.latestVersion ??
              controller.getSnapshot().latestVersion ??
              currentVersion,
            platform: controller.getSnapshot().platform,
            packageType: selectedHostPackageType,
          });
          if (hostInstall === "external") {
            externalHostInstallerOpened = true;
            return "external";
          }
          localHostUpdated = true;
        }

        if (components.includes("controller")) {
          if (manualMacDownload) return localHostUpdated ? "host-completed" : "external";
          const relaunch = afterInstall === "restart";
          updater.quitAndInstall(true, relaunch);
          controllerInstallerStarted = true;
          return "controller-installing";
        }
        return "host-completed";
      });

      return {
        controllerInstallerStarted,
        localHostUpdated,
        externalHostInstallerOpened,
      };
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

interface LegacyLinuxHostProcess {
  readonly legacyExecutablePath?: string;
  readonly legacyEnvironment?: Readonly<Record<string, string | undefined>>;
}

/** 只用于兼容尚未报告 packageType 的旧版 Linux Host；读取失败时拒绝猜测。 */
async function readLegacyLinuxHostProcess(
  descriptor: HostControlDescriptor | undefined,
): Promise<LegacyLinuxHostProcess> {
  if (!descriptor) return {};
  const [environmentSource, executablePath] = await Promise.all([
    readFile(`/proc/${descriptor.pid}/environ`, "utf8").catch(() => undefined),
    readlink(`/proc/${descriptor.pid}/exe`).catch(() => undefined),
  ]);
  const environment: Record<string, string> = {};
  for (const entry of environmentSource?.split("\0") ?? []) {
    const separator = entry.indexOf("=");
    if (separator > 0) environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return {
    ...(executablePath ? { legacyExecutablePath: executablePath } : {}),
    ...(Object.keys(environment).length > 0 ? { legacyEnvironment: environment } : {}),
  };
}

async function fetchLatestSeaShardRelease(): Promise<SeaShardRelease> {
  const response = await net.fetch(githubLatestReleaseApi, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "SeaShard-Desktop-Updater",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 404) throw new Error("当前还没有可供下载的正式 Release");
  if (!response.ok) throw new Error(`GitHub Release 检查失败（HTTP ${response.status}）`);
  return parseSeaShardRelease(await response.json());
}

async function downloadLocalHostInstaller(
  asset: LocalHostReleaseAsset,
  reportProgress: (progress: DesktopUpdateProgress) => void,
): Promise<string> {
  const directory = join(app.getPath("userData"), "updates", "local-host", asset.sha256);
  const destination = join(directory, asset.name);
  await mkdir(directory, { recursive: true });
  if (
    (await fileSize(destination)) === asset.size &&
    (await sha256File(destination)) === asset.sha256
  ) {
    reportProgress({
      percent: 100,
      transferredBytes: asset.size,
      totalBytes: asset.size,
      bytesPerSecond: 0,
    });
    return destination;
  }

  const temporary = `${destination}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  const response = await net.fetch(asset.downloadUrl, {
    headers: { "User-Agent": "SeaShard-Desktop-Updater" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Host 安装包下载失败（HTTP ${response.status}）`);
  }

  const handle = await open(temporary, "w", 0o600);
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  const startedAt = Date.now();
  let transferred = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await writeComplete(handle, value);
      hash.update(value);
      transferred += value.byteLength;
      const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1_000);
      reportProgress({
        percent: asset.size > 0 ? (transferred / asset.size) * 100 : 0,
        transferredBytes: transferred,
        totalBytes: asset.size,
        bytesPerSecond: transferred / elapsedSeconds,
      });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  if (transferred !== asset.size || hash.digest("hex") !== asset.sha256) {
    await rm(temporary, { force: true });
    throw new Error("Host 安装包完整性校验失败");
  }
  await rm(destination, { force: true });
  await rename(temporary, destination);
  return destination;
}

async function writeComplete(
  handle: Awaited<ReturnType<typeof open>>,
  value: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("Host 安装包写入中断");
    offset += bytesWritten;
  }
}

async function sha256File(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1_024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

interface InstallLocalHostPackageOptions {
  readonly asset: LocalHostReleaseAsset;
  readonly installerPath: string;
  readonly dataRoot: string;
  readonly targetVersion: string;
  readonly platform: DesktopUpdateSnapshot["platform"];
  readonly packageType: HostPackageType;
}

async function installLocalHostPackage(
  options: InstallLocalHostPackageOptions,
): Promise<"updated" | "external"> {
  if (options.platform === "macos") {
    const error = await shell.openPath(options.installerPath);
    if (error) throw new Error(`无法打开 Host 安装包：${error}`);
    return "external";
  }

  await stopLocalHost(options.dataRoot);
  if (options.platform === "windows") {
    await runProcess(options.installerPath, ["/S"], {
      ...process.env,
      SEASHARD_HOST_INSTALL_DATA_ROOT: options.dataRoot,
    });
  } else if (options.platform === "linux" && options.packageType === "deb") {
    await installDebPackage(options.installerPath);
  } else if (options.platform === "linux" && options.packageType === "appimage") {
    await chmod(options.installerPath, 0o755);
    await launchDetached(options.installerPath, [`--data-root=${options.dataRoot}`], {
      ...process.env,
      SEASHARD_HOST_DATA_DIR: options.dataRoot,
    });
  } else {
    throw new Error(`当前平台 ${options.platform} 不支持 ${options.packageType} Host 自动安装`);
  }
  await waitForLocalHostVersion(options.dataRoot, options.targetVersion, options.asset);
  return "updated";
}

async function stopLocalHost(dataRoot: string): Promise<void> {
  const descriptor = await readHostControlDescriptor(dataRoot);
  if (!descriptor) return;
  if (!isProcessAlive(descriptor.pid)) {
    // 异常退出可能留下描述文件；确认 PID 消失后清理，避免对死 Host 等满一分钟。
    await rm(descriptor.descriptorPath, { force: true });
    if (process.platform !== "win32") await rm(descriptor.socketPath, { force: true });
    return;
  }
  await writeFile(join(dataRoot, "host-shutdown.request"), "", "utf8");
  const deadline = Date.now() + localHostReadyTimeoutMs;
  while (Date.now() < deadline) {
    if (!(await readHostControlDescriptor(dataRoot))) return;
    await delay(100);
  }
  throw new Error("本机 Host 未能在更新前安全退出");
}

async function waitForLocalHostVersion(
  dataRoot: string,
  targetVersion: string,
  asset: LocalHostReleaseAsset,
): Promise<void> {
  const deadline = Date.now() + localHostReadyTimeoutMs;
  while (Date.now() < deadline) {
    const descriptor = await readHostControlDescriptor(dataRoot);
    if (
      descriptor?.seaShardVersion === targetVersion ||
      (descriptor?.seaShardVersion &&
        isNewerDesktopVersion(targetVersion, descriptor.seaShardVersion))
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Host 安装包 ${asset.name} 已执行，但新 Host 没有进入就绪状态`);
}

async function installDebPackage(installerPath: string): Promise<void> {
  if (process.getuid?.() === 0) {
    await runProcess("/usr/bin/dpkg", ["-i", installerPath], process.env);
    return;
  }
  try {
    await runProcess("pkexec", ["/usr/bin/dpkg", "-i", installerPath], process.env);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      throw new Error("系统缺少 pkexec，无法取得安装 Host DEB 所需的权限");
    }
    throw error;
  }
}

function runProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${executable} 被信号 ${signal} 中止`
            : `${executable} 退出码为 ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

function launchDetached(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
