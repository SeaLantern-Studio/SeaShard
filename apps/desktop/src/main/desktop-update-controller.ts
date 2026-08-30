import type {
  DesktopUpdatePackageType,
  DesktopUpdatePlatform,
  DesktopUpdateProgress,
  DesktopUpdateSnapshot,
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
  readonly available: boolean;
  readonly latestVersion: string;
  readonly releaseDate?: string;
}

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
        this.#publish({
          ...this.#baseSnapshot(),
          state: result.available ? "available" : "current",
          latestVersion: result.latestVersion,
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

  async installAutomatically(download: () => Promise<unknown>, install: () => void): Promise<void> {
    if (this.#actionTask) return this.#actionTask;
    this.#expectAvailableUpdate();

    const task = (async () => {
      const latestVersion = this.#snapshot.latestVersion;
      const releaseDate = this.#snapshot.releaseDate;
      this.#publish({
        ...this.#baseSnapshot(),
        state: "downloading",
        ...(latestVersion ? { latestVersion } : {}),
        ...(releaseDate ? { releaseDate } : {}),
        progress: zeroProgress,
      });
      try {
        await download();
        this.#publish({
          ...this.#baseSnapshot(),
          state: "installing",
          ...(latestVersion ? { latestVersion } : {}),
          ...(releaseDate ? { releaseDate } : {}),
          progress: { ...(this.#snapshot.progress ?? zeroProgress), percent: 100 },
        });
        install();
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

  /**
   * 未签名 macOS 构建保留版本检查，但把安装交还给浏览器和 Finder。这里仍复用
   * actionTask，避免连点按钮一次打开多个 Release 页面。
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
    const latestVersion = this.#snapshot.latestVersion;
    this.#publish({
      ...this.#baseSnapshot(),
      state: "error",
      ...(latestVersion ? { latestVersion } : {}),
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
