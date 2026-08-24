import type { ClientEntryDescriptor } from "@seashard/contracts";
import type { Awaitable, Disposable, JsonValue } from "@seashard/plugin-sdk";
import type { Component, Ref } from "vue";

export const uiAppearanceContract = "seashard.ui-appearance";

export type UiThemeMode = "auto" | "light" | "dark";
export type UiColorThemeId = "default" | "ocean" | "rose" | "sunset" | "midnight";
export type UiAcrylicBlurLevel = "off" | "low" | "medium" | "high";
export type UiBackgroundSize = "cover" | "contain" | "fill" | "auto";

export interface UiAppearanceSettings {
  color: UiColorThemeId;
  theme: UiThemeMode;
  fontSize: number;
  fontFamily: string;
  acrylicEnabled: boolean;
  acrylicBlurLevel: UiAcrylicBlurLevel;
  minimalMode: boolean;
  backgroundImage: string;
  backgroundOpacity: number;
  backgroundBlur: number;
  backgroundBrightness: number;
  backgroundSize: UiBackgroundSize;
}

export interface UiAppearanceService {
  readonly settings: Readonly<Ref<Readonly<UiAppearanceSettings>>>;
  update(patch: Partial<UiAppearanceSettings>): void;
  reset(): void;
}

export type SettingsNavigationGroup = "game" | "server" | "launcher" | "software";
/** 一个功能入口贡献给桌面 Shell 的页面及其导航记录。 */
export interface NavigationPageContribution {
  id: string;
  path: `/${string}`;
  label: string;
  description?: string;
  order?: number;
  icon?: Component;
  navigation?: boolean;
  placement?: "main" | "settings" | "agent-settings" | "server-download";
  settingsGroup?: SettingsNavigationGroup;
  component: Component;
}

/** 一个 Client Entry 为指定工作区提供的完整左侧栏内容。 */
export interface WorkspaceSidebarContribution {
  id: string;
  workspaceId: string;
  component: Component;
}

/** 可由 UI SDK 扩展的固定 Contribution 类型表。 */
export interface ClientUiContributionMap {
  "navigation.page": NavigationPageContribution;
  "workspace.sidebar": WorkspaceSidebarContribution;
}

/** Renderer 本地 Entry Context；不暴露 Main Context、Node 或 Electron 对象。 */
export interface ClientUiContext {
  readonly entry: ClientEntryDescriptor;
  service<T extends object>(contract: string): T;
  effect(setup: () => Disposable | void, label?: string): void;
  contribute<K extends keyof ClientUiContributionMap>(
    kind: K,
    value: ClientUiContributionMap[K],
  ): string;
}

/** Client Entry 与 Host Entry 保持相同的 apply/disposer 外形，但使用独立 Context。 */
export interface ClientUiModule {
  apply(ctx: ClientUiContext, config: JsonValue): Awaitable<Disposable | void>;
}

export function defineClientUiModule(module: ClientUiModule): ClientUiModule {
  return module;
}
