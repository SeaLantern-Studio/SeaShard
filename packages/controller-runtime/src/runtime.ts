import { BootstrapLoader } from "@seashard/bootstrap-runtime";
import type { DatabaseService } from "@seashard/database";
import { createSQLiteBootstrapDescriptor } from "@seashard/database-sqlite";
import { createPluginFoundationBootstrapDescriptor } from "@seashard/plugin-foundation";
import { PluginKernel, type PluginKernelOptions } from "@seashard/plugin-system";
import { Context } from "cordis";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface StartSeaShardControllerOptions {
  /** 所有 Controller 共同读写的权威数据目录。 */
  readonly dataRoot: string;
  /** 当前 Controller 独占的运行目录，只承载进程租约等短期状态。 */
  readonly runtimeDataRoot: string;
  readonly seaShardVersion: string;
  readonly databaseWorkerEntry: string;
  readonly pluginHostEntry: string;
  readonly hostProfile: PluginKernelOptions["hostProfile"];
  readonly clientTarget: NonNullable<PluginKernelOptions["clientTarget"]>;
  readonly platform?: PluginKernelOptions["platform"];
  readonly architecture?: PluginKernelOptions["architecture"];
}

/**
 * Controller 共用的无界面运行环境。
 *
 * Desktop 继续在外层组合 Electron Shell；Server 则在外层组合 HTTP 与网页。这里仅负责
 * 数据库、插件存储和 Plugin Kernel，避免任何 Electron 或页面代码进入共用层。
 */
export class SeaShardControllerRuntime {
  private kernelDisposeTask?: Promise<void>;
  private disposeTask?: Promise<void>;

  constructor(
    readonly database: DatabaseService,
    readonly dataRoot: string,
    readonly root: Context,
    readonly kernel: PluginKernel,
    private readonly bootstrapLoader: BootstrapLoader,
  ) {}

  /** Desktop 需要先关闭自己的桥接和 Host 连接，因此可以单独结束 Plugin Kernel。 */
  disposeKernel(): Promise<void> {
    this.kernelDisposeTask ??= this.kernel.dispose();
    return this.kernelDisposeTask;
  }

  /** 完整释放 Controller；Server 直接使用，Desktop 在原有关闭流程的 finally 中使用。 */
  dispose(): Promise<void> {
    this.disposeTask ??= (async () => {
      try {
        await this.disposeKernel();
      } finally {
        await this.bootstrapLoader.dispose();
      }
    })();
    return this.disposeTask;
  }
}

/**
 * 创建 Desktop 与 Server 共用的 Controller 底座。
 *
 * 调用方在返回后注册自身功能，最后显式调用 kernel.start()。这样 Desktop 原有的功能注册
 * 顺序和窗口启动时机保持不变，Server 也能在完全没有 Electron 的进程中使用同一套底座。
 */
export async function startSeaShardController(
  options: StartSeaShardControllerOptions,
): Promise<SeaShardControllerRuntime> {
  const host = resolveControllerPlatform(options.platform, options.architecture);
  await mkdir(options.runtimeDataRoot, { recursive: true });
  await mkdir(options.dataRoot, { recursive: true });
  const root = new Context();
  const bootstrapLoader = new BootstrapLoader(root);
  let kernel: PluginKernel | undefined;

  try {
    await bootstrapLoader.start([
      createSQLiteBootstrapDescriptor({
        dataRoot: options.runtimeDataRoot,
        databasePath: join(options.dataRoot, "seashard.sqlite3"),
        workerEntry: options.databaseWorkerEntry,
      }),
      createPluginFoundationBootstrapDescriptor({
        dataRoot: options.dataRoot,
        workerEntry: options.databaseWorkerEntry,
        seaShardVersion: options.seaShardVersion,
      }),
    ]);
    kernel = await PluginKernel.create({
      dataRoot: options.dataRoot,
      seaShardVersion: options.seaShardVersion,
      pluginHostEntry: options.pluginHostEntry,
      hostProfile: options.hostProfile,
      clientTarget: options.clientTarget,
      platform: host.platform,
      architecture: host.architecture,
      root,
      store: root["plugin-foundation"].store,
      pluginStorage: root["plugin-foundation"].storage,
      executionLocation: "controller",
    });
    return new SeaShardControllerRuntime(
      root.database,
      options.dataRoot,
      root,
      kernel,
      bootstrapLoader,
    );
  } catch (error) {
    await kernel?.dispose().catch(() => undefined);
    await bootstrapLoader.dispose().catch(() => undefined);
    throw error;
  }
}

function resolveControllerPlatform(
  platform = process.platform as PluginKernelOptions["platform"],
  architecture = process.arch as PluginKernelOptions["architecture"],
): Pick<PluginKernelOptions, "platform" | "architecture"> {
  const platforms: PluginKernelOptions["platform"][] = [
    "win32",
    "darwin",
    "linux",
    "aix",
    "freebsd",
    "openbsd",
    "sunos",
  ];
  const architectures: PluginKernelOptions["architecture"][] = [
    "x64",
    "arm64",
    "ia32",
    "arm",
    "riscv64",
    "ppc64",
    "s390x",
  ];
  if (!platforms.includes(platform))
    throw new Error(`unsupported controller platform: ${platform}`);
  if (!architectures.includes(architecture)) {
    throw new Error(`unsupported controller architecture: ${architecture}`);
  }
  return { platform, architecture };
}
