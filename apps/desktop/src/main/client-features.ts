import { aboutUiManifest } from "@seashard/about-ui";
import { agentConversationUiManifest } from "@seashard/agent-conversation-ui";
import { agentSettingsProviderUiManifest } from "@seashard/agent-settings-provider-ui";
import { gameSettingsUiManifest } from "@seashard/game-settings-ui";
import { personalizationUiManifest } from "@seashard/personalization-ui";
import type { PluginKernel } from "@seashard/plugin-system";
import { runtimeDiagnosticsUiManifest } from "@seashard/runtime-diagnostics-ui";
import { serverConfigurationUiManifest } from "@seashard/server-configuration-ui";
import { serverConsoleUiManifest } from "@seashard/server-console-ui";
import { serverDownloadDatapackUiManifest } from "@seashard/server-download-datapack-ui";
import { serverDownloadModUiManifest } from "@seashard/server-download-mod-ui";
import { serverModsUiManifest } from "@seashard/server-mods-ui";
import { serverDownloadModpackUiManifest } from "@seashard/server-download-modpack-ui";
import { serverDownloadServerCoreUiManifest } from "@seashard/server-download-servercore-ui";
import { serverDownloadWorldUiManifest } from "@seashard/server-download-world-ui";
import { serverLaunchUiManifest } from "@seashard/server-launch-ui";
import { serverInstanceSettingsUiManifest } from "@seashard/server-instance-settings-ui";
import { serverOverviewUiManifest } from "@seashard/server-overview-ui";
import { serverSavesUiManifest } from "@seashard/server-saves-ui";
import { serverSettingsUiManifest } from "@seashard/server-settings-ui";

/** 注册只发布 Renderer Client Entry 的内置功能。 */
export async function registerClientFeatures(kernel: PluginKernel): Promise<void> {
  // Agent 对话页独立发布，与侧栏通过专用 shared 包共享 Session 选择状态。
  await kernel.registerBuiltIn({
    manifest: agentConversationUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.agent-conversation.ui",
        entryId: "agent-conversation.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 模型供应商设置页拥有独立组件包与 Client Entry，不承载其他 Agent 设置页面。
  await kernel.registerBuiltIn({
    manifest: agentSettingsProviderUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.agent-settings-provider.ui",
        entryId: "agent-settings-provider.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
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
  // 整合包目录独立发布；下载尚未开放，因此只申请资源目录 Contract。
  await kernel.registerBuiltIn({
    manifest: serverDownloadModpackUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-download-modpack.ui",
        entryId: "server-download-modpack.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 数据包页面可按精确游戏版本安装到任意已登记实例。
  await kernel.registerBuiltIn({
    manifest: serverDownloadDatapackUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-download-datapack.ui",
        entryId: "server-download-datapack.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // Modrinth 没有独立世界项目类型；世界页独立说明能力边界，不申请 Host 权限。
  await kernel.registerBuiltIn({
    manifest: serverDownloadWorldUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-download-world.ui",
        entryId: "server-download-world.client",
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
  // 存档页扫描并切换实例世界，只消费实例世界与运行态 Contract。
  await kernel.registerBuiltIn({
    manifest: serverSavesUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-saves.ui",
        entryId: "server-saves.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 已安装 MOD 管理页独立发布；新增、来源跳转仍交给独立的 Mod 下载页。
  await kernel.registerBuiltIn({
    manifest: serverModsUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-mods.ui",
        entryId: "server-mods.client",
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
  // 实例设置页独立发布，只负责单个服务器的启动参数覆盖和命令预览。
  await kernel.registerBuiltIn({
    manifest: serverInstanceSettingsUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-instance-settings.ui",
        entryId: "server-instance-settings.client",
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
