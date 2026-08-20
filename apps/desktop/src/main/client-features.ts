import { aboutUiManifest } from "@seashard/about-ui";
import { gameSettingsUiManifest } from "@seashard/game-settings-ui";
import { personalizationUiManifest } from "@seashard/personalization-ui";
import type { PluginKernel } from "@seashard/plugin-system";
import { runtimeDiagnosticsUiManifest } from "@seashard/runtime-diagnostics-ui";
import { serverConfigurationUiManifest } from "@seashard/server-configuration-ui";
import { serverConsoleUiManifest } from "@seashard/server-console-ui";
import { serverDownloadModUiManifest } from "@seashard/server-download-mod-ui";
import { serverDownloadServerCoreUiManifest } from "@seashard/server-download-servercore-ui";
import { serverLaunchUiManifest } from "@seashard/server-launch-ui";
import { serverOverviewUiManifest } from "@seashard/server-overview-ui";
import { serverSettingsUiManifest } from "@seashard/server-settings-ui";

/** 注册只发布 Renderer Client Entry 的内置功能。 */
export async function registerClientFeatures(kernel: PluginKernel): Promise<void> {
  // “关于”作为可独立启停的内置 Client UI 功能，进入统一设置导航。
  await kernel.registerBuiltIn({
    manifest: aboutUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.about.ui",
        entryId: "about.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 个性化作为可独立启停的内置 Client UI 功能，进入统一设置导航。
  await kernel.registerBuiltIn({
    manifest: personalizationUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.personalization.ui",
        entryId: "personalization.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 游戏运行环境设置只消费 Java Host 组件发布的扫描 Contract。
  await kernel.registerBuiltIn({
    manifest: gameSettingsUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.game-settings.ui",
        entryId: "game-settings.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 服务器核心下载页独立消费核心目录与下载 Contract。
  await kernel.registerBuiltIn({
    manifest: serverDownloadServerCoreUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-download-servercore.ui",
        entryId: "server-download-servercore.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // Mod 下载页单独发布，只申请 Mod 来源 Contract。
  await kernel.registerBuiltIn({
    manifest: serverDownloadModUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-download-mod.ui",
        entryId: "server-download-mod.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 概览页只消费实例投影与运行状态，作为可独立启停的 Client UI 组件发布。
  await kernel.registerBuiltIn({
    manifest: serverOverviewUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-overview.ui",
        entryId: "server-overview.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 启动页独立管理实例选择与进程启停，不再代替其他服务器页面申请权限。
  await kernel.registerBuiltIn({
    manifest: serverLaunchUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-launch.ui",
        entryId: "server-launch.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 控制台独立订阅运行日志并发送命令。
  await kernel.registerBuiltIn({
    manifest: serverConsoleUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-console.ui",
        entryId: "server-console.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 配置管理只申请实例读取与配置文件 Contract。
  await kernel.registerBuiltIn({
    manifest: serverConfigurationUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-configuration.ui",
        entryId: "server-configuration.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 服务器下载设置 UI 只消费收窄的 Client Service；目录由独立 Host 设置组件持久化。
  await kernel.registerBuiltIn({
    manifest: serverSettingsUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-settings.ui",
        entryId: "server-settings.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 诊断页面独立于 Host 投影组件发布，前端目录不再混入 Core 能力包。
  await kernel.registerBuiltIn({
    manifest: runtimeDiagnosticsUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.runtime-diagnostics.ui",
        entryId: "runtime-diagnostics.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
}
