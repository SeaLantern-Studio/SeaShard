import type { ClientEntryDescriptor } from "@seashard/contracts";
import type { Awaitable, Disposable, JsonValue } from "@seashard/plugin-sdk";
import type { Component, Ref, VNodeChild } from "vue";

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

export type ClientUiSlotKind = "single" | "list" | "keyed" | "chain";
export type ClientUiSlotScope = "root" | "page";

/** Slot 声明随拥有它的 UI Entry 一起建立和坍缩。 */
export interface ClientUiSlotSpec {
  readonly kind: ClientUiSlotKind;
  readonly scope: ClientUiSlotScope;
}

export type ClientUiSlotChildren = Readonly<Record<string, ClientUiSlotSpec>>;

interface ClientUiSlotRegistrationBase {
  readonly name: string;
  readonly priority?: number;
  readonly children?: ClientUiSlotChildren;
}

export interface ClientUiSingleSlotRegistration extends ClientUiSlotRegistrationBase {
  readonly id?: never;
  readonly key?: never;
  readonly order?: never;
  readonly select?: never;
}

export interface ClientUiListSlotRegistration extends ClientUiSlotRegistrationBase {
  readonly id: string;
  readonly order?: number;
  readonly key?: never;
  readonly select?: never;
}

export interface ClientUiKeyedSlotRegistration extends ClientUiSlotRegistrationBase {
  readonly key: string;
  readonly id?: never;
  readonly order?: never;
  readonly select?: never;
}

export interface ClientUiChainSlotRegistration extends ClientUiSlotRegistrationBase {
  readonly select: (owner: Readonly<Record<string, unknown>>) => unknown;
  readonly priority?: number;
  readonly id?: never;
  readonly key?: never;
  readonly order?: never;
}

/** 一个功能入口注册到导航页面 Slot 时携带的 Shell 元数据。 */
export interface NavigationPageSlotRegistration extends ClientUiListSlotRegistration {
  readonly name: "navigation.page";
  readonly path: `/${string}`;
  readonly label: string;
  readonly description?: string;
  readonly icon?: Component;
  readonly navigation?: boolean;
  readonly placement?: "main" | "settings" | "agent-settings" | "server-download";
  readonly settingsGroup?: SettingsNavigationGroup;
}

/** 一个 Client Entry 占用指定工作区侧栏键。低 priority 的注册优先显示。 */
export interface WorkspaceSidebarSlotRegistration extends ClientUiKeyedSlotRegistration {
  readonly name: "workspace.sidebar";
}

export type PageRootSlotName = `page.${string}.root`;
export type PageRootExtensionMode = "prepend" | "append" | "overlay" | "replace" | "dom";

/** 每个活动页面自动声明的根 Slot；组件可获得稳定根元素并选择托管挂载方式。 */
export interface PageRootExtensionSlotRegistration extends ClientUiListSlotRegistration {
  readonly name: PageRootSlotName;
  readonly mode?: PageRootExtensionMode;
}

export interface PageRootExtensionProps {
  readonly [key: string]: unknown;
  readonly pageId: string;
  readonly root: HTMLElement;
}

export type ClientUiSlotRegistration =
  | ClientUiSingleSlotRegistration
  | ClientUiListSlotRegistration
  | ClientUiKeyedSlotRegistration
  | ClientUiChainSlotRegistration;

export interface ClientUiRenderSlotOptions {
  readonly entryKey?: string;
  readonly only?: string;
  readonly fallback?: VNodeChild;
}

export type ClientUiRenderSlot = (
  name: string,
  owner?: Readonly<Record<string, unknown>>,
  options?: ClientUiRenderSlotOptions,
) => VNodeChild;

/** Slot 注册统一进入当前 Client Entry 的 Effect 生命周期。 */
export interface ClientUiSlots {
  register(options: NavigationPageSlotRegistration, component: Component): Disposable;
  register(options: WorkspaceSidebarSlotRegistration, component: Component): Disposable;
  register(options: PageRootExtensionSlotRegistration, component: Component): Disposable;
  register(options: ClientUiSlotRegistration, component: Component): Disposable;
  inject(name: string, setup: () => Disposable | void): Disposable;
}

/** Renderer 本地 Entry Context；不暴露 Main Context、Node 或 Electron 对象。 */
export interface ClientUiContext {
  readonly entry: ClientEntryDescriptor;
  readonly slots: ClientUiSlots;
  service<T extends object>(contract: string): T;
  effect(setup: () => Disposable | void, label?: string): Disposable;
}

/** 返回页面根 Slot 的稳定名称，并在插件激活阶段尽早拒绝非法页面 ID。 */
export function pageRootSlot(pageId: string): PageRootSlotName {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u.test(pageId)) {
    throw new TypeError(`invalid page id: ${pageId}`);
  }
  return `page.${pageId}.root`;
}

/** Client Entry 与 Host Entry 保持相同的 apply/disposer 外形，但使用独立 Context。 */
export interface ClientUiModule {
  apply(ctx: ClientUiContext, config: JsonValue): Awaitable<Disposable | void>;
}

export function defineClientUiModule(module: ClientUiModule): ClientUiModule {
  return module;
}
