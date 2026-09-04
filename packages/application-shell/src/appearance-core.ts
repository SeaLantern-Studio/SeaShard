import {
  type UiAcrylicBlurLevel,
  type UiAppearanceService,
  type UiAppearanceSettings,
  type UiBackgroundSize,
  type UiColorThemeId,
  type UiThemeMode,
} from "@seashard/ui-sdk";
import { computed, shallowRef } from "vue";

interface ThemeColors {
  bg: string;
  bgSecondary: string;
  bgTertiary: string;
  primary: string;
  secondary: string;
  textPrimary: string;
  textSecondary: string;
  border: string;
}

interface ThemeDefinition {
  light: ThemeColors;
  dark: ThemeColors;
  lightAcrylic: ThemeColors;
  darkAcrylic: ThemeColors;
}

export interface AppearanceService extends UiAppearanceService {
  /** 用权威存储中的完整快照替换本地视图；初始化时不触发回写。 */
  replace(settings: Partial<UiAppearanceSettings>): void;
  /** 供关闭流程和针对性测试等待排队中的持久化操作。 */
  settled(): Promise<void>;
  dispose(): void;
}

export interface CreateAppearanceServiceOptions {
  readonly initialSettings?: Partial<UiAppearanceSettings>;
  readonly supportsAcrylic?: boolean;
  readonly persist?: (
    patch: Readonly<Partial<UiAppearanceSettings>>,
    settings: Readonly<UiAppearanceSettings>,
  ) => void | Promise<void>;
  readonly onPersistenceError?: (error: unknown) => void;
}

const colorThemes: Record<UiColorThemeId, ThemeDefinition> = {
  default: {
    light: {
      bg: "#f8fafc",
      bgSecondary: "#f1f5f9",
      bgTertiary: "#e2e8f0",
      primary: "#0ea5e9",
      secondary: "#06b6d4",
      textPrimary: "#0f172a",
      textSecondary: "#475569",
      border: "#e2e8f0",
    },
    dark: {
      bg: "#0c1222",
      bgSecondary: "#151d2e",
      bgTertiary: "#1e293b",
      primary: "#38bdf8",
      secondary: "#22d3ee",
      textPrimary: "#f1f5f9",
      textSecondary: "#94a3b8",
      border: "rgba(255, 255, 255, 0.08)",
    },
    lightAcrylic: {
      bg: "rgba(248, 250, 252, 0.65)",
      bgSecondary: "rgba(241, 245, 249, 0.55)",
      bgTertiary: "rgba(226, 232, 240, 0.45)",
      primary: "#0ea5e9",
      secondary: "#06b6d4",
      textPrimary: "#0f172a",
      textSecondary: "#475569",
      border: "rgba(226, 232, 240, 0.6)",
    },
    darkAcrylic: {
      bg: "rgba(12, 18, 34, 0.65)",
      bgSecondary: "rgba(21, 29, 46, 0.55)",
      bgTertiary: "rgba(30, 41, 59, 0.45)",
      primary: "#38bdf8",
      secondary: "#22d3ee",
      textPrimary: "#f1f5f9",
      textSecondary: "#94a3b8",
      border: "rgba(255, 255, 255, 0.06)",
    },
  },
  ocean: createTheme(
    ["#f0fdfa", "#ccfbf1", "#99f6e4", "#0d9488", "#0891b2", "#134e4a", "#0f766e", "#99f6e4"],
    [
      "#0a1929",
      "#0d2847",
      "#134e6f",
      "#2dd4bf",
      "#22d3ee",
      "#f0fdfa",
      "#99f6e4",
      "rgba(45, 212, 191, 0.15)",
    ],
    [
      "rgba(240, 253, 250, 0.65)",
      "rgba(204, 251, 241, 0.55)",
      "rgba(153, 246, 228, 0.45)",
      "#0d9488",
      "#0891b2",
      "#134e4a",
      "#0f766e",
      "rgba(153, 246, 228, 0.6)",
    ],
    [
      "rgba(10, 25, 41, 0.65)",
      "rgba(13, 40, 71, 0.55)",
      "rgba(19, 78, 111, 0.45)",
      "#2dd4bf",
      "#22d3ee",
      "#f0fdfa",
      "#99f6e4",
      "rgba(45, 212, 191, 0.1)",
    ],
  ),
  rose: createTheme(
    ["#fdf2f8", "#fce7f3", "#fbcfe8", "#db2777", "#ec4899", "#831843", "#9f1239", "#fbcfe8"],
    [
      "#1a0a12",
      "#2d1220",
      "#4a1942",
      "#f472b6",
      "#fb7185",
      "#fdf2f8",
      "#fbcfe8",
      "rgba(244, 114, 182, 0.15)",
    ],
    [
      "rgba(253, 242, 248, 0.65)",
      "rgba(252, 231, 243, 0.55)",
      "rgba(251, 207, 232, 0.45)",
      "#db2777",
      "#ec4899",
      "#831843",
      "#9f1239",
      "rgba(251, 207, 232, 0.6)",
    ],
    [
      "rgba(26, 10, 18, 0.65)",
      "rgba(45, 18, 32, 0.55)",
      "rgba(74, 25, 66, 0.45)",
      "#f472b6",
      "#fb7185",
      "#fdf2f8",
      "#fbcfe8",
      "rgba(244, 114, 182, 0.1)",
    ],
  ),
  sunset: createTheme(
    ["#fffbeb", "#fef3c7", "#fde68a", "#ea580c", "#f97316", "#7c2d12", "#9a3412", "#fde68a"],
    [
      "#1a0f05",
      "#2d1a0a",
      "#4a2c12",
      "#fb923c",
      "#fbbf24",
      "#fffbeb",
      "#fef3c7",
      "rgba(251, 146, 60, 0.15)",
    ],
    [
      "rgba(255, 251, 235, 0.65)",
      "rgba(254, 243, 199, 0.55)",
      "rgba(253, 230, 138, 0.45)",
      "#ea580c",
      "#f97316",
      "#7c2d12",
      "#9a3412",
      "rgba(253, 230, 138, 0.6)",
    ],
    [
      "rgba(26, 15, 5, 0.65)",
      "rgba(45, 26, 10, 0.55)",
      "rgba(74, 44, 18, 0.45)",
      "#fb923c",
      "#fbbf24",
      "#fffbeb",
      "#fef3c7",
      "rgba(251, 146, 60, 0.1)",
    ],
  ),
  midnight: createTheme(
    ["#f8fafc", "#eef2ff", "#e0e7ff", "#6366f1", "#8b5cf6", "#1e1b4b", "#4338ca", "#e0e7ff"],
    [
      "#0f0d1a",
      "#1a1744",
      "#252150",
      "#818cf8",
      "#a78bfa",
      "#f5f3ff",
      "#c4b5fd",
      "rgba(139, 92, 246, 0.15)",
    ],
    [
      "rgba(248, 250, 252, 0.65)",
      "rgba(238, 242, 255, 0.55)",
      "rgba(224, 231, 255, 0.45)",
      "#6366f1",
      "#8b5cf6",
      "#1e1b4b",
      "#4338ca",
      "rgba(224, 231, 255, 0.6)",
    ],
    [
      "rgba(15, 13, 26, 0.65)",
      "rgba(26, 23, 68, 0.55)",
      "rgba(37, 33, 80, 0.45)",
      "#818cf8",
      "#a78bfa",
      "#f5f3ff",
      "#c4b5fd",
      "rgba(139, 92, 246, 0.1)",
    ],
  ),
};

export const defaultAppearanceSettings: Readonly<UiAppearanceSettings> = Object.freeze({
  color: "default",
  theme: "auto",
  fontSize: 16,
  fontFamily: "",
  acrylicEnabled: false,
  acrylicBlurLevel: "medium",
  minimalMode: false,
  backgroundImage: "",
  backgroundOpacity: 0.3,
  backgroundBlur: 0,
  backgroundBrightness: 1,
  backgroundSize: "cover",
});

/**
 * 创建一个只负责浏览器呈现的外观状态机。持久化策略由壳层注入，因此 Desktop 可以继续使用
 * localStorage，Server Web 则把相同的更新写入 Controller 的 SQLite。
 */
export function createAppearanceService(
  options: CreateAppearanceServiceOptions = {},
): AppearanceService {
  const supportsAcrylic = options.supportsAcrylic !== false;
  const state = shallowRef<Readonly<UiAppearanceSettings>>(
    normalizeSettings(options.initialSettings ?? {}, supportsAcrylic),
  );
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  let persistenceQueue: Promise<void> = Promise.resolve();

  const persist = (
    patch: Readonly<Partial<UiAppearanceSettings>>,
    settings: Readonly<UiAppearanceSettings>,
  ): void => {
    if (!options.persist) return;
    persistenceQueue = persistenceQueue
      .then(() => options.persist!(patch, settings))
      .catch((error) => options.onPersistenceError?.(error));
  };
  const accept = (settings: Readonly<UiAppearanceSettings>): void => {
    state.value = settings;
    applySettings(settings, systemTheme.matches);
  };
  const handleSystemThemeChange = (): void => {
    if (state.value.theme === "auto") applySettings(state.value, systemTheme.matches);
  };

  const service: AppearanceService = {
    settings: computed(() => state.value),
    supportsAcrylic,
    update(patch) {
      const acceptedPatch = supportsAcrylic ? patch : withoutAcrylic(patch);
      const next = normalizeSettings({ ...state.value, ...acceptedPatch }, supportsAcrylic);
      accept(next);
      persist(acceptedPatch, next);
    },
    reset() {
      const next = normalizeSettings(defaultAppearanceSettings, supportsAcrylic);
      accept(next);
      persist(next, next);
    },
    replace(settings) {
      accept(normalizeSettings(settings, supportsAcrylic));
    },
    settled: () => persistenceQueue,
    dispose() {
      systemTheme.removeEventListener("change", handleSystemThemeChange);
    },
  };

  systemTheme.addEventListener("change", handleSystemThemeChange);
  applySettings(state.value, systemTheme.matches);
  return service;
}

function withoutAcrylic(
  patch: Readonly<Partial<UiAppearanceSettings>>,
): Partial<UiAppearanceSettings> {
  const { acrylicEnabled: _enabled, acrylicBlurLevel: _blur, ...supported } = patch;
  return supported;
}

function normalizeSettings(
  value: Readonly<Partial<UiAppearanceSettings>>,
  supportsAcrylic: boolean,
): UiAppearanceSettings {
  return {
    color: isColorTheme(value.color) ? value.color : defaultAppearanceSettings.color,
    theme: isThemeMode(value.theme) ? value.theme : defaultAppearanceSettings.theme,
    fontSize:
      typeof value.fontSize === "number" && Number.isFinite(value.fontSize)
        ? Math.min(24, Math.max(12, Math.round(value.fontSize)))
        : defaultAppearanceSettings.fontSize,
    fontFamily:
      typeof value.fontFamily === "string"
        ? value.fontFamily
        : defaultAppearanceSettings.fontFamily,
    acrylicEnabled: supportsAcrylic && value.acrylicEnabled === true,
    acrylicBlurLevel:
      supportsAcrylic && isBlurLevel(value.acrylicBlurLevel)
        ? value.acrylicBlurLevel
        : supportsAcrylic
          ? defaultAppearanceSettings.acrylicBlurLevel
          : "off",
    minimalMode:
      typeof value.minimalMode === "boolean"
        ? value.minimalMode
        : defaultAppearanceSettings.minimalMode,
    backgroundImage:
      typeof value.backgroundImage === "string"
        ? value.backgroundImage
        : defaultAppearanceSettings.backgroundImage,
    backgroundOpacity: boundedNumber(value.backgroundOpacity, 0, 1, 0.3),
    backgroundBlur: boundedNumber(value.backgroundBlur, 0, 20, 0),
    backgroundBrightness: boundedNumber(value.backgroundBrightness, 0, 2, 1),
    backgroundSize: isBackgroundSize(value.backgroundSize)
      ? value.backgroundSize
      : defaultAppearanceSettings.backgroundSize,
  };
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function createTheme(
  light: string[],
  dark: string[],
  lightAcrylic: string[],
  darkAcrylic: string[],
): ThemeDefinition {
  return {
    light: toColors(light),
    dark: toColors(dark),
    lightAcrylic: toColors(lightAcrylic),
    darkAcrylic: toColors(darkAcrylic),
  };
}

function toColors(values: string[]): ThemeColors {
  const [bg, bgSecondary, bgTertiary, primary, secondary, textPrimary, textSecondary, border] =
    values;
  if (
    !bg ||
    !bgSecondary ||
    !bgTertiary ||
    !primary ||
    !secondary ||
    !textPrimary ||
    !textSecondary ||
    !border
  ) {
    throw new Error("theme color plan is incomplete");
  }
  return { bg, bgSecondary, bgTertiary, primary, secondary, textPrimary, textSecondary, border };
}

function applySettings(settings: Readonly<UiAppearanceSettings>, systemDark: boolean): void {
  const root = document.documentElement;
  const effectiveTheme =
    settings.theme === "auto" ? (systemDark ? "dark" : "light") : settings.theme;
  const plan = settings.acrylicEnabled
    ? effectiveTheme === "dark"
      ? "darkAcrylic"
      : "lightAcrylic"
    : effectiveTheme;
  const colors = colorThemes[settings.color][plan];
  const isDark = effectiveTheme === "dark";

  root.dataset.theme = effectiveTheme;
  root.dataset.acrylic = settings.acrylicEnabled ? "on" : "off";
  root.dataset.minimal = String(settings.minimalMode);
  root.dataset.animation = settings.minimalMode ? "off" : "on";
  root.style.fontSize = `${settings.fontSize}px`;
  setOptionalProperty(root, "--sl-font-sans", settings.fontFamily);
  setOptionalProperty(root, "--sl-font-display", settings.fontFamily);

  root.style.setProperty("--sl-bg", colors.bg);
  root.style.setProperty("--sl-bg-secondary", colors.bgSecondary);
  root.style.setProperty("--sl-bg-tertiary", colors.bgTertiary);
  root.style.setProperty("--sl-primary", colors.primary);
  root.style.setProperty("--sl-accent", colors.secondary);
  root.style.setProperty("--sl-text-primary", colors.textPrimary);
  root.style.setProperty("--sl-text-secondary", colors.textSecondary);
  root.style.setProperty("--sl-border", colors.border);
  root.style.setProperty("--sl-border-light", colors.border);
  root.style.setProperty(
    "--sl-surface",
    settings.acrylicEnabled
      ? isDark
        ? "rgba(30, 33, 48, 0.65)"
        : "rgba(255, 255, 255, 0.65)"
      : isDark
        ? colors.bgSecondary
        : "#ffffff",
  );
  root.style.setProperty(
    "--sl-surface-hover",
    settings.acrylicEnabled
      ? isDark
        ? "rgba(40, 44, 62, 0.75)"
        : "rgba(248, 250, 252, 0.75)"
      : isDark
        ? colors.bgTertiary
        : colors.bg,
  );
  root.style.setProperty("--sl-primary-light", adjustBrightness(colors.primary, isDark ? 30 : 20));
  root.style.setProperty("--sl-primary-dark", adjustBrightness(colors.primary, isDark ? -20 : -30));
  root.style.setProperty("--sl-primary-bg", rgbaFromHex(colors.primary, isDark ? 0.12 : 0.08));
  root.style.setProperty("--sl-accent-light", adjustBrightness(colors.secondary, 20));
  root.style.setProperty(
    "--sl-text-tertiary",
    adjustBrightness(colors.textSecondary, isDark ? -20 : 20),
  );
  root.style.setProperty("--sl-text-inverse", "#ffffff");
  root.style.setProperty(
    "--sl-acrylic-blur",
    { off: "0px", low: "8px", medium: "16px", high: "28px" }[settings.acrylicBlurLevel],
  );
  root.style.setProperty(
    "--sl-background-image",
    settings.backgroundImage ? `url("${settings.backgroundImage}")` : "none",
  );
  root.style.setProperty("--sl-background-opacity", String(settings.backgroundOpacity));
  root.style.setProperty("--sl-background-blur", `${settings.backgroundBlur}px`);
  root.style.setProperty("--sl-background-brightness", String(settings.backgroundBrightness));
  root.style.setProperty("--sl-background-size", settings.backgroundSize);
}

function setOptionalProperty(root: HTMLElement, name: string, value: string): void {
  if (value) {
    root.style.setProperty(name, value);
  } else {
    root.style.removeProperty(name);
  }
}

function adjustBrightness(hex: string, percent: number): string {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  const amount = Math.round(2.55 * percent);
  const red = Math.min(255, Math.max(0, (value >> 16) + amount));
  const green = Math.min(255, Math.max(0, ((value >> 8) & 0xff) + amount));
  const blue = Math.min(255, Math.max(0, (value & 0xff) + amount));
  return `#${((1 << 24) + (red << 16) + (green << 8) + blue).toString(16).slice(1)}`;
}

function rgbaFromHex(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
}

function isColorTheme(value: unknown): value is UiColorThemeId {
  return (
    value === "default" ||
    value === "ocean" ||
    value === "rose" ||
    value === "sunset" ||
    value === "midnight"
  );
}

function isThemeMode(value: unknown): value is UiThemeMode {
  return value === "auto" || value === "light" || value === "dark";
}

function isBlurLevel(value: unknown): value is UiAcrylicBlurLevel {
  return value === "off" || value === "low" || value === "medium" || value === "high";
}

function isBackgroundSize(value: unknown): value is UiBackgroundSize {
  return value === "cover" || value === "contain" || value === "fill" || value === "auto";
}
