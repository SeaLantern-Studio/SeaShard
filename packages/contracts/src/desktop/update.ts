export type DesktopUpdateState =
  | "unsupported"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
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
  apply(): Promise<void>;
  onSnapshotChanged(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void;
}
