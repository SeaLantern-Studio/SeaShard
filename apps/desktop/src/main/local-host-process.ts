import { spawn, type ChildProcess } from "node:child_process";

export interface LocalHostProcessOptions {
  readonly hostEntry: string;
  readonly executable: string;
  readonly dataRoot: string;
  readonly seaShardVersion: string;
  /** 开发、冒烟与插件操作进程随 Controller 收尾。发行版 Controller 不使用此启动器。 */
  readonly managedLifecycle: true;
}

/**
 * 仅供开发、冒烟和插件操作模式启动源码 Host。发行版 Controller 只连接已经独立安装
 * 并运行的 Host，禁止通过 Controller 自身可执行文件补启动 Host。
 */
export class LocalHostProcessLauncher {
  private child?: ChildProcess;
  private launchTask?: Promise<void>;

  constructor(private readonly options: LocalHostProcessOptions) {}

  ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      return Promise.resolve();
    }
    this.launchTask ??= this.launch();
    return this.launchTask;
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.launchTask = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await stopManagedChild(child);
  }

  private async launch(): Promise<void> {
    const environment = { ...process.env };
    delete environment.SEASHARD_PLUGIN_DEVELOPER_CONTROL;
    delete environment.SEASHARD_SMOKE_PLUGIN_ARCHIVE;
    const child = spawn(this.options.executable, [this.options.hostEntry], {
      detached: false,
      windowsHide: true,
      env: {
        ...environment,
        ELECTRON_RUN_AS_NODE: "1",
        SEASHARD_HOST_DATA_DIR: this.options.dataRoot,
        SEASHARD_VERSION: this.options.seaShardVersion,
        SEASHARD_HOST_INSTALLATION_KIND: "standalone",
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.child = child;
    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.launchTask = undefined;
    });
    try {
      await waitForSpawn(child);
    } catch (error) {
      if (this.child === child) {
        this.child = undefined;
        this.launchTask = undefined;
      }
      throw error;
    }
  }
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function stopManagedChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => child.kill(), 2_000);
    child.once("exit", () => {
      clearTimeout(forceTimer);
      resolve();
    });
    if (!child.connected || !child.send) {
      child.kill();
      return;
    }
    child.send("seashard:quit", (error) => {
      if (error) child.kill();
    });
  });
}
