import type {
  DesktopLocalHostUpdateSnapshot,
  DesktopUpdateComponent,
  DesktopUpdateFinishRequest,
  DesktopUpdateFinishResult,
  DesktopUpdatePackageType,
  DesktopUpdatePlatform,
  DesktopUpdateProgress,
  DesktopUpdateRestartRequirement,
  DesktopUpdateSnapshot,
  ServerInstanceSnapshot,
  ServerRuntimeSnapshot,
} from "@seashard/contracts";

export interface DesktopUpdateEnvironment {
  readonly currentVersion: string;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly appImagePath?: string;
  readonly linuxPackageType?: string;
}

export interface DesktopUpdateCheckResult {
  readonly latestVersion: string;
  readonly availableComponents: readonly DesktopUpdateComponent[];
  readonly localHost: DesktopLocalHostUpdateSnapshot;
  readonly releaseDate?: string;
}

export type DesktopUpdateInstallDisposition =
  | "controller-installing"
  | "host-completed"
  | "external";

interface ResolvedDesktopUpdateTarget {
  readonly platform: DesktopUpdatePlatform;
  readonly packageType: DesktopUpdatePackageType;
  readonly reason?: string;
}

/**
 * 更新目标必须与 Release 工作流真实发布的安装包一一对应。开发目录以及未知
 * Linux 打包形式直接收窄为 unsupported，防止下载完成后找不到可靠安装路径。
 */
export function resolveDesktopUpdateTarget(
  environment: DesktopUpdateEnvironment,
): ResolvedDesktopUpdateTarget {
  if (!environment.isPackaged) {
    return {
      platform: desktopUpdatePlatform(environment.platform),
      packageType: "unsupported",
      reason: "开发模式不执行软件更新，请使用正式安装包测试。",
    };
  }
  if (environment.architecture !== "x64" && environment.architecture !== "arm64") {
    return {
      platform: desktopUpdatePlatform(environment.platform),
      packageType: "unsupported",
      reason: `当前架构 ${environment.architecture} 暂无更新安装包。`,
    };
  }
  if (environment.platform === "win32") {
    return { platform: "windows", packageType: "nsis" };
  }
  if (environment.platform === "linux") {
    if (environment.appImagePath) return { platform: "linux", packageType: "appimage" };
    if (environment.linuxPackageType === "deb") {
      return { platform: "linux", packageType: "deb" };
    }
    return {
      platform: "linux",
      packageType: "unsupported",
      reason: "Linux 一键更新仅支持 AppImage 与 DEB 安装包。",
    };
  }
  if (environment.platform === "darwin") {
    return { platform: "macos", packageType: "dmg" };
  }
  return {
    platform: "other",
    packageType: "unsupported",
    reason: `当前操作系统 ${environment.platform} 暂不支持一键更新。`,
  };
}

function desktopUpdatePlatform(platform: NodeJS.Platform): DesktopUpdatePlatform {
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  return "other";
}

/** Release 工作流只接受三段数字版本；沿用同一约束可避免字符串排序误判 1.10 与 1.9。 */
export function isNewerDesktopVersion(currentVersion: string, latestVersion: string): boolean {
  const parse = (value: string): readonly number[] | undefined => {
    if (!/^\d+\.\d+\.\d+$/u.test(value)) return undefined;
    return value.split(".").map((part) => Number.parseInt(part, 10));
  };
  const current = parse(currentVersion);
  const latest = parse(latestVersion);
  if (!current || !latest) {
    throw new Error(`无法比较软件版本：${currentVersion} → ${latestVersion}`);
  }
  for (let index = 0; index < current.length; index += 1) {
    const difference = latest[index]! - current[index]!;
    if (difference !== 0) return difference > 0;
  }
  return false;
}
export interface DesktopUpdateCompletionContext {
  listServerInstances(): Promise<readonly ServerInstanceSnapshot[]>;
  readServerRuntime(instanceId: string): Promise<ServerRuntimeSnapshot>;
  waitUntilServerStartupSettled(instanceId: string): Promise<ServerRuntimeSnapshot>;
  stopServerRuntime(instanceId: string): Promise<ServerRuntimeSnapshot>;
  waitUntilServerStopped(instanceId: string): Promise<ServerRuntimeSnapshot>;
  install(afterInstall: DesktopUpdateFinishRequest["afterInstall"]): void | Promise<void>;
}

/**
 * 安装更新前按服务器真实生命周期完成停机。starting 必须先等启动事务结算，running
 * 发送安全停止后必须等进程退出；任何一个实例失败都会保留已下载更新，不触发安装器。
 */
export async function coordinateDesktopUpdateCompletion(
  context: DesktopUpdateCompletionContext,
  request: DesktopUpdateFinishRequest,
): Promise<DesktopUpdateFinishResult> {
  const runningServers = await readRunningServers(context);
  if (runningServers.length > 0 && !request.stopRunningServers) {
    return Object.freeze({
      outcome: "running-servers",
      runningServers: Object.freeze(runningServers),
    });
  }

  if (runningServers.length > 0) {
    const results = await Promise.allSettled(
      runningServers.map((server) => stopServerForDesktopUpdate(context, server)),
    );
    const failures = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      const server = runningServers[index]!;
      return [
        Object.freeze({
          instanceId: server.instanceId,
          name: server.name,
          reason: errorMessage(result.reason),
        }),
      ];
    });
    if (failures.length > 0) {
      return Object.freeze({
        outcome: "stop-failed",
        failures: Object.freeze(failures),
      });
    }
  }

  await context.install(request.afterInstall);
  return undefined;
}

/**
 * starting 期间可能仍在下载核心且没有 ChildProcess，先等待启动队列；启动失败视为已
 * 停止，启动成功再发送 stop。stopping 则只等待已有停机流程，避免重复写入停止命令。
 */
async function stopServerForDesktopUpdate(
  context: DesktopUpdateCompletionContext,
  server: DesktopUpdateRestartRequirement["runningServers"][number],
): Promise<void> {
  let snapshot: ServerRuntimeSnapshot = {
    instanceId: server.instanceId,
    state: server.state,
  };
  if (snapshot.state === "starting") {
    snapshot = await context.waitUntilServerStartupSettled(server.instanceId);
  }
  if (snapshot.state === "stopped" || snapshot.state === "failed") return;
  if (snapshot.state === "running") {
    snapshot = await context.stopServerRuntime(server.instanceId);
  }
  if (snapshot.state === "stopped" || snapshot.state === "failed") return;
  if (snapshot.state !== "stopping") {
    throw new Error(`服务器进入了无法停机的 ${snapshot.state} 状态`);
  }
  const stopped = await context.waitUntilServerStopped(server.instanceId);
  if (stopped.state !== "stopped" && stopped.state !== "failed") {
    throw new Error(`服务器停机返回了未完成的 ${stopped.state} 状态`);
  }
}

async function readRunningServers(
  context: DesktopUpdateCompletionContext,
): Promise<DesktopUpdateRestartRequirement["runningServers"][number][]> {
  const instances = await context.listServerInstances();
  const runtimeSnapshots = await Promise.all(
    instances.map(async (instance) => ({
      instance,
      runtime: await context.readServerRuntime(instance.id),
    })),
  );
  return runtimeSnapshots.flatMap(({ instance, runtime }) =>
    runtime.state === "starting" || runtime.state === "running" || runtime.state === "stopping"
      ? [{ instanceId: instance.id, name: instance.name, state: runtime.state }]
      : [],
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 单一状态机串联检查与平台更新动作，避免快速连点生成多份安装任务。Main 只通过
 * publish 投影不可变快照，Renderer 无法越过状态边界直接触发安装器或外部页面。
 */
export class DesktopUpdateController {
  readonly #listeners = new Set<(snapshot: DesktopUpdateSnapshot) => void>();
  #snapshot: DesktopUpdateSnapshot;
  #checkTask?: Promise<DesktopUpdateSnapshot>;
  #actionTask?: Promise<void>;

  constructor(environment: DesktopUpdateEnvironment) {
    const target = resolveDesktopUpdateTarget(environment);
    this.#snapshot = Object.freeze({
      state: target.packageType === "unsupported" ? "unsupported" : "idle",
      currentVersion: environment.currentVersion,
      platform: target.platform,
      architecture: environment.architecture,
      packageType: target.packageType,
      ...(target.reason ? { reason: target.reason } : {}),
    });
  }

  getSnapshot(): DesktopUpdateSnapshot {
    return this.#snapshot;
  }

  onSnapshotChanged(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async check(
    checkForUpdates: () => Promise<DesktopUpdateCheckResult>,
  ): Promise<DesktopUpdateSnapshot> {
    if (this.#snapshot.state === "unsupported") return this.#snapshot;
    if (this.#checkTask) return this.#checkTask;
    if (this.#actionTask) throw new Error("软件更新操作正在进行中");

    const task = (async () => {
      this.#publish({
        ...this.#baseSnapshot(),
        state: "checking",
      });
      try {
        const result = await checkForUpdates();
        const availableComponents = Object.freeze([...result.availableComponents]);
        this.#publish({
          ...this.#baseSnapshot(),
          state: availableComponents.length > 0 ? "available" : "current",
          latestVersion: result.latestVersion,
          availableComponents,
          localHost: Object.freeze({ ...result.localHost }),
          ...(result.releaseDate ? { releaseDate: result.releaseDate } : {}),
        });
        return this.#snapshot;
      } catch (error) {
        this.reportError(error);
        throw error;
      }
    })();
    this.#checkTask = task;
    try {
      return await task;
    } finally {
      if (this.#checkTask === task) this.#checkTask = undefined;
    }
  }

  async downloadAutomatically(download: () => Promise<unknown>): Promise<void> {
    if (this.#actionTask) return this.#actionTask;
    this.#expectAvailableUpdate();

    const task = (async () => {
      this.#publish({
        ...this.#baseSnapshot(),
        state: "downloading",
        progress: zeroProgress,
      });
      try {
        await download();
        const components = this.#snapshot.availableComponents ?? [];
        const controllerInstallsInApp =
          components.includes("controller") && this.#snapshot.packageType !== "dmg";
        this.#publish({
          ...this.#baseSnapshot(),
          state: controllerInstallsInApp ? "restart-required" : "host-install-ready",
          progress: { ...(this.#snapshot.progress ?? zeroProgress), percent: 100 },
        });
      } catch (error) {
        this.reportError(error);
        throw error;
      }
    })();
    this.#actionTask = task;
    try {
      await task;
    } finally {
      if (this.#actionTask === task) this.#actionTask = undefined;
    }
  }

  setDownloadComponent(component: DesktopUpdateComponent): void {
    if (this.#snapshot.state !== "downloading") return;
    this.#publish({
      ...this.#snapshot,
      downloadComponent: component,
      progress: zeroProgress,
    });
  }

  /**
   * Host 与 Controller 安装包已经分别下载。Host 安装完成后可留在当前进程；Controller
   * 安装器启动后 Electron 将退出。外部安装器保持 available，等待用户完成系统安装。
   */
  async installDownloaded(install: () => Promise<DesktopUpdateInstallDisposition>): Promise<void> {
    if (
      this.#snapshot.state !== "restart-required" &&
      this.#snapshot.state !== "host-install-ready"
    ) {
      throw new Error("软件更新尚未准备好安装");
    }
    try {
      this.#publish({
        ...this.#baseSnapshot(),
        state: "installing",
        progress: { ...(this.#snapshot.progress ?? zeroProgress), percent: 100 },
      });
      const disposition = await install();
      if (disposition === "controller-installing") return;
      if (disposition === "external") {
        this.#publish({
          ...this.#baseSnapshot(),
          state: "available",
        });
        return;
      }

      const remainingComponents = (this.#snapshot.availableComponents ?? []).filter(
        (component) => component !== "local-host",
      );
      const localHost = this.#snapshot.localHost;
      this.#publish({
        ...this.#baseSnapshot(),
        state: remainingComponents.length > 0 ? "available" : "current",
        availableComponents: Object.freeze(remainingComponents),
        ...(localHost
          ? {
              localHost: Object.freeze({
                ...localHost,
                currentVersion: localHost.latestVersion,
                updateAvailable: false,
              }),
            }
          : {}),
      });
    } catch (error) {
      this.reportError(error);
      throw error;
    }
  }

  /**
   * 未签名 macOS Controller 构建把安装交还给浏览器和 Finder。这里仍复用 actionTask，
   * 避免连点按钮一次打开多个 Release 页面。
   */
  async openDownloadPage(open: () => Promise<void>): Promise<void> {
    if (this.#actionTask) return this.#actionTask;
    this.#expectAvailableUpdate();
    if (this.#snapshot.packageType !== "dmg") {
      throw new Error("当前安装包支持应用内自动更新");
    }

    const task = (async () => {
      try {
        await open();
      } catch (error) {
        this.reportError(error);
        throw error;
      }
    })();
    this.#actionTask = task;
    try {
      await task;
    } finally {
      if (this.#actionTask === task) this.#actionTask = undefined;
    }
  }

  reportProgress(progress: DesktopUpdateProgress): void {
    if (this.#snapshot.state !== "downloading") return;
    this.#publish({
      ...this.#snapshot,
      progress: Object.freeze({
        percent: Math.min(100, Math.max(0, progress.percent)),
        transferredBytes: Math.max(0, progress.transferredBytes),
        totalBytes: Math.max(0, progress.totalBytes),
        bytesPerSecond: Math.max(0, progress.bytesPerSecond),
      }),
    });
  }

  reportError(error: unknown): void {
    if (this.#snapshot.state === "unsupported") return;
    this.#publish({
      ...this.#baseSnapshot(),
      state: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  #expectAvailableUpdate(): void {
    if (this.#snapshot.state !== "available") {
      throw new Error("请先检查并确认存在可用更新");
    }
  }

  #baseSnapshot(): Omit<DesktopUpdateSnapshot, "state"> {
    return {
      currentVersion: this.#snapshot.currentVersion,
      platform: this.#snapshot.platform,
      architecture: this.#snapshot.architecture,
      packageType: this.#snapshot.packageType,
      ...(this.#snapshot.latestVersion ? { latestVersion: this.#snapshot.latestVersion } : {}),
      ...(this.#snapshot.releaseDate ? { releaseDate: this.#snapshot.releaseDate } : {}),
      ...(this.#snapshot.availableComponents
        ? { availableComponents: this.#snapshot.availableComponents }
        : {}),
      ...(this.#snapshot.localHost ? { localHost: this.#snapshot.localHost } : {}),
    };
  }

  #publish(snapshot: DesktopUpdateSnapshot): void {
    this.#snapshot = Object.freeze(snapshot);
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}

const zeroProgress: DesktopUpdateProgress = Object.freeze({
  percent: 0,
  transferredBytes: 0,
  totalBytes: 0,
  bytesPerSecond: 0,
});
