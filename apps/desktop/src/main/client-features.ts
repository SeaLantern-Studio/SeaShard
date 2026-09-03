import { aboutUiManifest } from "@seashard/about-ui";
import { agentConversationUiManifest } from "@seashard/agent-conversation-ui";
import { agentSettingsUiManifest } from "@seashard/agent-settings-ui";
import { agentSettingsProviderUiManifest } from "@seashard/agent-settings-provider-ui";
import { pluginManagementUiRuntimeId, pluginMarketUiRuntimeId } from "@seashard/contracts";
import {
  hostConnectionsUiManifest,
  hostConnectionsUiRuntimeId,
} from "@seashard/host-connections-ui";
import type { PluginKernel } from "@seashard/plugin-system";
import { pluginMarketUiManifest } from "@seashard/plugin-market-ui";
import { personalizationUiManifest } from "@seashard/personalization-ui";
import { pluginSettingsUiManifest } from "@seashard/plugin-settings-ui";
import { runtimeDiagnosticsUiManifest } from "@seashard/runtime-diagnostics-ui";
import { registerServerClientFeatures } from "@seashard/server-client-features";

/** 注册只发布 Renderer Client Entry 的内置功能。 */
export async function registerClientFeatures(kernel: PluginKernel): Promise<void> {
  // Host 连接管理属于 Controller 应用页面；Host 断开时仍保持发布。
  await kernel.registerBuiltIn({
    manifest: hostConnectionsUiManifest,
    loaders: {},
    bindings: [
      {
        id: hostConnectionsUiRuntimeId,
        entryId: "host-connections.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
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
  // Agent 常规设置独立发布，只消费 Runtime 提供的设置 Contract。
  await kernel.registerBuiltIn({
    manifest: agentSettingsUiManifest,
    loaders: {},
    bindings: [
      {
        id: "core.agent-settings.ui",
        entryId: "agent-settings.client",
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
  // 第三方插件管理页独立发布，固定 Binding 同时作为特权管理 Contract 的调用身份。
  await kernel.registerBuiltIn({
    manifest: pluginSettingsUiManifest,
    loaders: {},
    bindings: [
      {
        id: pluginManagementUiRuntimeId,
        entryId: "plugin-settings.client",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
  // 插件市场独立发布；固定 Binding 同时作为受限安装 Contract 的调用身份。
  await kernel.registerBuiltIn({
    manifest: pluginMarketUiManifest,
    loaders: {},
    bindings: [
      {
        id: pluginMarketUiRuntimeId,
        entryId: "plugin-market.client",
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
  // 服务器页面由 Desktop 与 Server Web 共用同一组 Manifest 和 Binding 身份。
  await registerServerClientFeatures(kernel);
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
