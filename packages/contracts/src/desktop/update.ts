import type { ServerProcessState } from "../server/runtime.js";
export type DesktopUpdateState =
  | "unsupported"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "restart-required"
  | "installing"
  | "error";

export type DesktopUpdatePlatform = "windows" | "linux" | "macos" | "other";
export type DesktopUpdatePackageType = "nsis" | "dmg" | "appimage" | "deb" | "unsupported";

export interface DesktopUpdateProgress {
  readonly percent: number;
  readonly transferredBytes: number;
  readonly totalBytes: number;
  readonly bytesPerSecond: number;
}
export type DesktopUpdateBlockingServerState = Extract<
  ServerProcessState,
  "starting" | "running" | "stopping"
>;

/** 安装器准备重启时，Renderer 只获得展示与确认所需的服务器摘要。 */
export interface DesktopUpdateRunningServer {
  readonly instanceId: string;
  readonly name: string;
  readonly state: DesktopUpdateBlockingServerState;
}

export interface DesktopUpdateRestartRequirement {
  readonly outcome: "running-servers";
  readonly runningServers: readonly DesktopUpdateRunningServer[];
}

export interface DesktopUpdateStopFailure {
  readonly outcome: "stop-failed";
  readonly failures: readonly {
    readonly instanceId: string;
    readonly name: string;
    readonly reason: string;
  }[];
}

export type DesktopUpdateFinishResult =
  | DesktopUpdateRestartRequirement
  | DesktopUpdateStopFailure
  | undefined;

export interface DesktopUpdateFinishRequest {
  readonly stopRunningServers: boolean;
  readonly afterInstall: "restart" | "close";
}

/** Renderer 只消费稳定的更新状态投影，下载路径与安装器句柄始终留在 Main。 */
export interface DesktopUpdateSnapshot {
  readonly state: DesktopUpdateState;
  readonly currentVersion: string;
  readonly platform: DesktopUpdatePlatform;
  readonly architecture: string;
  readonly packageType: DesktopUpdatePackageType;
  readonly latestVersion?: string;
  readonly releaseDate?: string;
  readonly progress?: DesktopUpdateProgress;
  readonly reason?: string;
  readonly error?: string;
}

export interface DesktopUpdateClientService {
  getSnapshot(): Promise<DesktopUpdateSnapshot>;
  check(): Promise<DesktopUpdateSnapshot>;
  /**
   * 下载更新；无运行中服务器时立即进入安装重启，有服务器时返回待确认清单。
   */
  apply(): Promise<DesktopUpdateFinishResult>;
  /**
   * 重新检查服务器生命周期，并按用户选择在安装后重启或保持关闭。
   */
  finish(request: DesktopUpdateFinishRequest): Promise<DesktopUpdateFinishResult>;
  /** 主窗口因已下载更新拦截关闭时，通知应用根组件显示最终安装选择。 */
  onExitDecisionRequired(listener: () => void): () => void;
  onSnapshotChanged(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void;
}
