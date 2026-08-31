import { BootstrapLoader } from "@seashard/bootstrap-runtime";
import { createSQLiteBootstrapDescriptor } from "@seashard/database-sqlite";
import { type HostControlServer } from "@seashard/host-control";
import { createPluginFoundationBootstrapDescriptor } from "@seashard/plugin-foundation";
import { PluginKernel, type PluginKernelOptions } from "@seashard/plugin-system";
import { Context } from "cordis";
import { startHostRuntimeControlServer } from "./control";
import { registerHostFeatures } from "./features";
import { registerLegacyHostMigrationService } from "./legacy-migration";
import { registerHostLifecycleService } from "./lifecycle";
import { registerHostWorkerDeploymentService } from "./worker-deployment";

export interface StartSeaShardHostOptions {
  readonly dataRoot: string;
  readonly seaShardVersion: string;
  readonly databaseWorkerEntry: string;
  readonly pluginHostEntry: string;
  readonly startedAt?: string;
  readonly hostProfile?: PluginKernelOptions["hostProfile"];
  readonly platform?: PluginKernelOptions["platform"];
  readonly architecture?: PluginKernelOptions["architecture"];
  readonly requestShutdown?: () => void;
}

/** 一个完整、无界面的 Host 进程生命周期；Desktop 和未来 Server 只连接它。 */
export class SeaShardHostRuntime {
  private disposeTask?: Promise<void>;

  constructor(
    readonly dataRoot: string,
    readonly startedAt: string,
    readonly kernel: PluginKernel,
    readonly controlServer: HostControlServer,
    private readonly bootstrapLoader: BootstrapLoader,
  ) {}

  dispose(): Promise<void> {
    this.disposeTask ??= (async () => {
      try {
        await this.controlServer.dispose();
      } finally {
        try {
          await this.kernel.dispose();
        } finally {
          await this.bootstrapLoader.dispose();
        }
      }
    })();
    return this.disposeTask;
  }
}

/**
 * Host Runtime 完整拥有自己的 Bootstrap、Plugin Kernel 与控制端口。调用方只提供
 * 制品入口和数据目录，不能取得并拼接 Host 内部组件生命周期。
 */
export async function startSeaShardHost(
  options: StartSeaShardHostOptions,
): Promise<SeaShardHostRuntime> {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const host = resolveHostPlatform(options.platform, options.architecture);
  const root = new Context();
  const bootstrapLoader = new BootstrapLoader(root);
  let kernel: PluginKernel | undefined;
  let controlServer: HostControlServer | undefined;

  try {
    await bootstrapLoader.start([
      createSQLiteBootstrapDescriptor({
        dataRoot: options.dataRoot,
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
      hostProfile: options.hostProfile ?? "node",
      platform: host.platform,
      architecture: host.architecture,
      root,
      store: root["plugin-foundation"].store,
      pluginStorage: root["plugin-foundation"].storage,
      executionLocation: "host",
      agentExtensions: false,
    });
    await registerHostFeatures({ kernel, seaShardVersion: options.seaShardVersion });
    registerHostWorkerDeploymentService(kernel);
    registerLegacyHostMigrationService(kernel, root["plugin-foundation"].storage);
    registerHostLifecycleService(kernel, options.requestShutdown);
    await kernel.start();
    controlServer = await startHostRuntimeControlServer(kernel, options.dataRoot, startedAt);
    return new SeaShardHostRuntime(
      options.dataRoot,
      startedAt,
      kernel,
      controlServer,
      bootstrapLoader,
    );
  } catch (error) {
    await controlServer?.dispose().catch(() => undefined);
    await kernel?.dispose().catch(() => undefined);
    await bootstrapLoader.dispose().catch(() => undefined);
    throw error;
  }
}

function resolveHostPlatform(
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
  if (!platforms.includes(platform)) throw new Error(`unsupported host platform: ${platform}`);
  if (!architectures.includes(architecture)) {
    throw new Error(`unsupported host architecture: ${architecture}`);
  }
  return { platform, architecture };
}
