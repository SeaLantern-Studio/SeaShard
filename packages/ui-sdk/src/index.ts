import type { ClientEntryDescriptor } from "@seashard/contracts";
import type { Awaitable, Disposable, JsonValue } from "@seashard/plugin-sdk";
import type { Component } from "vue";

/** 一个功能入口贡献给桌面 Shell 的页面及其导航记录。 */
export interface NavigationPageContribution {
  id: string;
  path: `/${string}`;
  label: string;
  description?: string;
  order?: number;
  component: Component;
}

/** 可由 UI SDK 扩展的固定 Contribution 类型表。 */
export interface ClientUiContributionMap {
  "navigation.page": NavigationPageContribution;
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
