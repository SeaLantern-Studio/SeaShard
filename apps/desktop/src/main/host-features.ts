import { agentRuntimeManifest, createAgentRuntimeModule } from "@seashard/agent-runtime";
import { serverDownloadConnectionLimits, type ServerConsoleLine } from "@seashard/contracts";
import { createDownloadModule, downloadManifest } from "@seashard/download";
import {
  createJavaRuntimeManagerModule,
  javaRuntimeManagerManifest,
} from "@seashard/java-runtime-manager";
import type { PluginKernel } from "@seashard/plugin-system";
import {
  createRuntimeDiagnosticsModule,
  runtimeDiagnosticsManifest,
} from "@seashard/runtime-diagnostics";
import {
  createServerCoreSourceModule,
  serverCoreSourceManifest,
} from "@seashard/server-core-source";
import {
  createServerModSourceModule,
  defaultMcimModrinthApiBaseUrl,
  defaultMcimModrinthFileBaseUrl,
  serverModSourceManifest,
} from "@seashard/server-mod-source";
import {
  createServerConfigurationModule,
  serverConfigurationManifest,
} from "@seashard/server-configuration";
import {
  createServerInstanceManagerModule,
  serverInstanceManagerManifest,
} from "@seashard/server-instance-manager";
import { createServerRuntimeModule, serverRuntimeManifest } from "@seashard/server-runtime";
import { createServerSettingsModule, serverSettingsManifest } from "@seashard/server-settings";
import type { Context } from "cordis";
import { join } from "node:path";

interface HostFeatureOptions {
  readonly kernel: PluginKernel;
  readonly root: Context;
  readonly dataRoot: string;
  readonly userDataRoot: string;
  readonly seaShardVersion: string;
  readonly startedAt: string;
  readonly isStopping: () => boolean;
  readonly publishServerConsoleLine: (line: ServerConsoleLine) => void;
}

const downloadFetchProvider = () => globalThis.fetch;

/** 注册拥有 Host 状态或外部资源生命周期的内置组件。 */
export async function registerHostFeatures(options: HostFeatureOptions): Promise<void> {
  const {
    kernel,
    root,
    dataRoot,
    userDataRoot,
    seaShardVersion,
    startedAt,
    isStopping,
    publishServerConsoleLine,
  } = options;
  // Agent Session 和模型配置属于用户级数据，必须位于 Electron userData 而非 core 数据目录。
  await kernel.registerBuiltIn({
    manifest: agentRuntimeManifest,
    loaders: {
      "agent-runtime.host": {
        load: async () =>
          createAgentRuntimeModule({
            userDataRoot,
            reportError: (error) => console.error("Agent Runtime failed", error),
          }),
      },
    },
    bindings: [
      {
        id: "core.agent-runtime",
        entryId: "agent-runtime.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 公共下载组件集中管理所有文件任务；业务组件通过 Service 注入复用，不各自实现传输层。
  await kernel.registerBuiltIn({
    manifest: downloadManifest,
    loaders: {
      "download.host": {
        load: async () =>
          createDownloadModule({
            fetchProvider: downloadFetchProvider,
            defaultHeaders: { "User-Agent": `SeaShard/${seaShardVersion}` },
            defaultConnections: serverDownloadConnectionLimits.defaultValue,
            maxConnections: serverDownloadConnectionLimits.maximum,
          }),
      },
    },
    bindings: [
      {
        id: "core.download",
        entryId: "download.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 服务器设置使用 Runtime 独占的 SQLite 文档存储，默认资源目录位于应用数据目录。
  await kernel.registerBuiltIn({
    manifest: serverSettingsManifest,
    loaders: {
      "server-settings.host": {
        load: async () =>
          createServerSettingsModule({
            defaultResourceDownloadDirectory: join(dataRoot, "resources"),
            defaultDownloadConnections: serverDownloadConnectionLimits.defaultValue,
          }),
      },
    },
    bindings: [
      {
        id: "core.server-settings",
        entryId: "server-settings.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 服务端核心源作为独立后端能力，当前提供 CNB 目录、持久缓存与受校验的下载任务。
  await kernel.registerBuiltIn({
    manifest: serverCoreSourceManifest,
    loaders: {
      "server-core-source.host": {
        load: async () =>
          createServerCoreSourceModule({
            database: root.database,
            fetchProvider: downloadFetchProvider,
            iconCacheDirectory: join(dataRoot, "cache", "server-core-icons"),
          }),
      },
    },
    bindings: [
      {
        id: "core.server-core-source",
        entryId: "server-core-source.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 实例管理器只登记校验成功的托管下载，并在独立目录写入可移植描述文件。
  await kernel.registerBuiltIn({
    manifest: serverInstanceManagerManifest,
    loaders: {
      "server-instance-manager.host": {
        load: async () =>
          createServerInstanceManagerModule({
            database: root.database,
            managedRoot: join(dataRoot, "servers"),
            reportError: (error) =>
              console.error("Managed server instance finalization failed", error),
          }),
      },
    },
    bindings: [
      {
        id: "core.server-instance-manager",
        entryId: "server-instance-manager.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 官方 Modrinth 失败时切换 MCIM；文件下载失败时由协调器再尝试 MCIM CDN。
  await kernel.registerBuiltIn({
    manifest: serverModSourceManifest,
    loaders: {
      "server-mod-source.host": {
        load: async () =>
          createServerModSourceModule({
            fetchProvider: downloadFetchProvider,
            userAgent: `SeaShard/${seaShardVersion}`,
            fallbackBaseUrl: defaultMcimModrinthApiBaseUrl,
            fallbackFileBaseUrl: defaultMcimModrinthFileBaseUrl,
          }),
      },
    },
    bindings: [
      {
        id: "core.server-mod-source",
        entryId: "server-mod-source.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 配置管理器在实例边界内列出并修改 UTF-8 配置文件，写入时校验 revision 并先备份。
  await kernel.registerBuiltIn({
    manifest: serverConfigurationManifest,
    loaders: {
      "server-configuration.host": {
        load: async () => createServerConfigurationModule(),
      },
    },
    bindings: [
      {
        id: "core.server-configuration",
        entryId: "server-configuration.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // Java 自动发现只读取 release 等安装元数据，不执行文件系统中发现的未知程序。
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
    bindings: [
      {
        id: "core.java-runtime-manager",
        entryId: "java-runtime-manager.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 服务器运行组件只接受实例元数据显式声明的 vanilla 类型；启动阶段不探测核心文件。
  await kernel.registerBuiltIn({
    manifest: serverRuntimeManifest,
    loaders: {
      "server-runtime.host": {
        load: async () =>
          createServerRuntimeModule({
            onConsoleLine: publishServerConsoleLine,
            reportError: (error) => console.error("Server runtime failed", error),
          }),
      },
    },
    bindings: [
      {
        id: "core.server-runtime",
        entryId: "server-runtime.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 运行诊断属于第二阶段可重载组件。Main 只注入原始控制快照和宿主状态，不复制投影策略。
  await kernel.registerBuiltIn({
    manifest: runtimeDiagnosticsManifest,
    loaders: {
      "runtime-diagnostics.host": {
        load: async () =>
          createRuntimeDiagnosticsModule({
            host: "electron",
            startedAt,
            readControlSnapshot: () => kernel.runtimeSnapshot(),
            isStopping: isStopping,
          }),
      },
    },
    bindings: [
      {
        id: "core.runtime-diagnostics",
        entryId: "runtime-diagnostics.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
}
