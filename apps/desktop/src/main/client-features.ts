import { aboutUiManifest } from "@seashard/about-ui";
import { gameSettingsUiManifest } from "@seashard/game-settings-ui";
import { personalizationUiManifest } from "@seashard/personalization-ui";
import type { PluginKernel } from "@seashard/plugin-system";
import { runtimeDiagnosticsUiManifest } from "@seashard/runtime-diagnostics-ui";
import { serverDownloadUiManifest } from "@seashard/server-download-ui";
import { serverLaunchUiManifest } from "@seashard/server-launch-ui";
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
  // 服务器下载页是独立 Client Entry；真实核心目录通过收窄的只读 Client Service 提供。
  await kernel.registerBuiltIn({
    manifest: serverDownloadUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.server-download.ui",
        entryId: "server-download.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 服务器启动页读取实例管理器的持久化投影；进程启停状态仍由后续运行组件接管。
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
