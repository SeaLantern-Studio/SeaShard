import type { UiAppearanceSettings } from "@seashard/ui-sdk";
import { createAppearanceService } from "./appearance-core";

const storageKey = "seashard.ui.appearance";

/**
 * Desktop 保持原有浏览器本地存储语义；Server Web 从独立子路径导入工厂，不会实例化这份
 * localStorage 服务。
 */
export const appearanceService = createAppearanceService({
  initialSettings: loadSettings(),
  persist: (_patch, settings) => {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  },
});

function loadSettings(): Partial<UiAppearanceSettings> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<UiAppearanceSettings>)
      : {};
  } catch {
    return {};
  }
}
