import { serverDownloadConnectionLimits, type ServerConsoleLine } from "@seashard/contracts";
import { createDownloadModule, downloadManifest } from "@seashard/download";
import {
  createJavaRuntimeManagerModule,
  javaRuntimeManagerManifest,
} from "@seashard/java-runtime-manager";
import type { DatabaseService } from "@seashard/database";
import type { PluginKernel } from "@seashard/plugin-system";
import { registerServerFeatures } from "@seashard/server-features";

export interface HostFeatureOptions {
  readonly kernel: PluginKernel;
  readonly database: DatabaseService;
  readonly dataRoot: string;
  readonly seaShardVersion: string;
  readonly publishConsoleLine: (line: ServerConsoleLine) => void;
}

/**
 * Host 只发布设备侧通用能力。服务器实例、配置、资源和启动策略均由 Controller
 * 解释，因此 Host Runtime 不注册服务器领域 Provider。
 */
export async function registerHostFeatures(options: HostFeatureOptions): Promise<void> {
  const { kernel, seaShardVersion } = options;

  await kernel.registerBuiltIn({
    manifest: downloadManifest,
    loaders: {
      "download.host": {
        load: async () =>
          createDownloadModule({
            fetchProvider: () => globalThis.fetch,
            defaultHeaders: { "User-Agent": `SeaShard/${seaShardVersion}` },
            defaultConnections: serverDownloadConnectionLimits.defaultValue,
            maxConnections: serverDownloadConnectionLimits.maximum,
          }),
      },
    },
    bindings: [hostBinding("core.download", "download.host")],
  });

  // Java 扫描属于设备事实采集；Host 不选择服务器版本、核心或启动参数。
  await kernel.registerBuiltIn({
    manifest: javaRuntimeManagerManifest,
    loaders: {
      "java-runtime-manager.host": {
        load: async () =>
          createJavaRuntimeManagerModule({
            reportError: (error) => console.warn("Java runtime candidate ignored", error),
          }),
      },
    },
    bindings: [hostBinding("core.java-runtime-manager", "java-runtime-manager.host")],
  });

  // 独立 Server 的实例、文件和进程能力实际驻留于 Host。Host 断开某个 Controller
  // 连接时不会释放这些组件，因此正在运行的服务器不会随 Controller 退出。
  await registerServerFeatures({
    kernel,
    database: options.database,
    dataRoot: options.dataRoot,
    seaShardVersion,
    executionLocation: "host",
    publishConsoleLine: options.publishConsoleLine,
  });
}

function hostBinding(id: string, entryId: string) {
  return {
    id,
    entryId,
    scopeType: "global" as const,
    scopeId: "global",
    enabled: true,
    config: null,
  };
}
