import {
  defineDataCapsule,
  type DatabaseRow,
  type DatabaseService,
  type RegisteredDataCapsule,
} from "@seashard/database";
import type {
  ServerWebAppearanceColor,
  ServerWebAppearanceSettings,
  ServerWebAppearanceSnapshot,
  ServerWebAppearanceTheme,
  ServerWebBackgroundSize,
} from "@seashard/server-web-api";

const maximumBackgroundImageCharacters = 8 * 1024 * 1024;
const appearanceKeys = new Set<keyof ServerWebAppearanceSettings>([
  "color",
  "theme",
  "fontSize",
  "fontFamily",
  "minimalMode",
  "backgroundImage",
  "backgroundOpacity",
  "backgroundBlur",
  "backgroundBrightness",
  "backgroundSize",
]);

type MutableAppearancePatch = {
  -readonly [TKey in keyof ServerWebAppearanceSettings]?: ServerWebAppearanceSettings[TKey];
};

export const defaultServerWebAppearanceSettings: Readonly<ServerWebAppearanceSettings> =
  Object.freeze({
    color: "default",
    theme: "auto",
    fontSize: 16,
    fontFamily: "",
    minimalMode: false,
    backgroundImage: "",
    backgroundOpacity: 0.3,
    backgroundBlur: 0,
    backgroundBrightness: 1,
    backgroundSize: "cover",
  });

/** Server Web 外观独占一张单行表，避免与 Desktop 的 localStorage 或插件文档混用。 */
export const serverWebAppearanceDataCapsule = defineDataCapsule({
  namespace: "server_ui_appearance",
  schemaVersion: 1,
  compatibilityFloor: 1,
  tables: ["server_ui_appearance"],
  migrations: [
    {
      version: 1,
      statements: [
        `CREATE TABLE server_ui_appearance (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          color TEXT NOT NULL CHECK (color IN ('default', 'ocean', 'rose', 'sunset', 'midnight')),
          theme TEXT NOT NULL CHECK (theme IN ('auto', 'light', 'dark')),
          font_size INTEGER NOT NULL CHECK (font_size BETWEEN 12 AND 24),
          font_family TEXT NOT NULL,
          minimal_mode INTEGER NOT NULL CHECK (minimal_mode IN (0, 1)),
          background_image TEXT NOT NULL,
          background_opacity REAL NOT NULL CHECK (background_opacity BETWEEN 0 AND 1),
          background_blur REAL NOT NULL CHECK (background_blur BETWEEN 0 AND 20),
          background_brightness REAL NOT NULL CHECK (background_brightness BETWEEN 0 AND 2),
          background_size TEXT NOT NULL CHECK (background_size IN ('cover', 'contain', 'fill', 'auto')),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          updated_at TEXT NOT NULL
        ) STRICT`,
      ],
      verify: [
        {
          sql: `SELECT COUNT(*) = 1 AS valid
                  FROM sqlite_schema
                 WHERE type = 'table' AND name = 'server_ui_appearance'`,
          column: "valid",
          equals: 1,
        },
      ],
    },
  ],
  commands: [
    {
      id: "appearance.get",
      access: "read",
      result: "get",
      sql: `SELECT color, theme, font_size, font_family, minimal_mode,
                   background_image, background_opacity, background_blur,
                   background_brightness, background_size, revision, updated_at
              FROM server_ui_appearance
             WHERE id = 1`,
    },
    {
      id: "appearance.save",
      access: "write",
      result: "get",
      sql: `INSERT INTO server_ui_appearance (
              id, color, theme, font_size, font_family, minimal_mode,
              background_image, background_opacity, background_blur,
              background_brightness, background_size, revision, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(id) DO UPDATE SET
              color = excluded.color,
              theme = excluded.theme,
              font_size = excluded.font_size,
              font_family = excluded.font_family,
              minimal_mode = excluded.minimal_mode,
              background_image = excluded.background_image,
              background_opacity = excluded.background_opacity,
              background_blur = excluded.background_blur,
              background_brightness = excluded.background_brightness,
              background_size = excluded.background_size,
              revision = server_ui_appearance.revision + 1,
              updated_at = excluded.updated_at
            RETURNING color, theme, font_size, font_family, minimal_mode,
                      background_image, background_opacity, background_blur,
                      background_brightness, background_size, revision, updated_at`,
    },
  ],
});

/** 对同一 Server 的多浏览器写入排队，并在服务端按字段合并，避免整份快照相互覆盖。 */
export class ServerWebAppearanceStore {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly repository: RegisteredDataCapsule) {}

  static async create(database: DatabaseService): Promise<ServerWebAppearanceStore> {
    return new ServerWebAppearanceStore(
      await database.registerCapsule(serverWebAppearanceDataCapsule),
    );
  }

  async get(): Promise<ServerWebAppearanceSnapshot> {
    await this.writeQueue;
    return this.readCurrent();
  }

  update(value: unknown): Promise<ServerWebAppearanceSnapshot> {
    const patch = parseAppearancePatch(value);
    if (Object.keys(patch).length === 0) return this.get();
    return this.enqueue(async () => {
      const current = await this.readCurrent();
      return this.save({ ...current.settings, ...patch });
    });
  }

  reset(): Promise<ServerWebAppearanceSnapshot> {
    return this.enqueue(() => this.save(defaultServerWebAppearanceSettings));
  }

  private enqueue(
    operation: () => Promise<ServerWebAppearanceSnapshot>,
  ): Promise<ServerWebAppearanceSnapshot> {
    const task = this.writeQueue.then(operation);
    this.writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async readCurrent(): Promise<ServerWebAppearanceSnapshot> {
    const result = await this.repository.execute("appearance.get");
    if (result.kind !== "get") throw new Error("Server appearance read returned invalid result");
    return result.row
      ? projectAppearanceRow(result.row)
      : { settings: { ...defaultServerWebAppearanceSettings }, revision: 0 };
  }

  private async save(
    settings: Readonly<ServerWebAppearanceSettings>,
  ): Promise<ServerWebAppearanceSnapshot> {
    const result = await this.repository.execute("appearance.save", [
      settings.color,
      settings.theme,
      settings.fontSize,
      settings.fontFamily,
      settings.minimalMode ? 1 : 0,
      settings.backgroundImage,
      settings.backgroundOpacity,
      settings.backgroundBlur,
      settings.backgroundBrightness,
      settings.backgroundSize,
      new Date().toISOString(),
    ]);
    if (result.kind !== "get" || !result.row) {
      throw new Error("Server appearance write returned invalid result");
    }
    return projectAppearanceRow(result.row);
  }
}

function parseAppearancePatch(value: unknown): Partial<ServerWebAppearanceSettings> {
  if (!isRecord(value)) throw new TypeError("Server 外观更新必须是对象");
  for (const key of Object.keys(value)) {
    if (!appearanceKeys.has(key as keyof ServerWebAppearanceSettings)) {
      throw new TypeError(`未知的 Server 外观字段：${key}`);
    }
  }

  const patch: MutableAppearancePatch = {};
  if ("color" in value) patch.color = requireColor(value.color);
  if ("theme" in value) patch.theme = requireTheme(value.theme);
  if ("fontSize" in value) patch.fontSize = requireInteger(value.fontSize, 12, 24, "文本大小");
  if ("fontFamily" in value) patch.fontFamily = requireText(value.fontFamily, 512, "字体");
  if ("minimalMode" in value) patch.minimalMode = requireBoolean(value.minimalMode, "极简模式");
  if ("backgroundImage" in value)
    patch.backgroundImage = requireBackgroundImage(value.backgroundImage);
  if ("backgroundOpacity" in value) {
    patch.backgroundOpacity = requireNumber(value.backgroundOpacity, 0, 1, "背景不透明度");
  }
  if ("backgroundBlur" in value) {
    patch.backgroundBlur = requireNumber(value.backgroundBlur, 0, 20, "背景模糊程度");
  }
  if ("backgroundBrightness" in value) {
    patch.backgroundBrightness = requireNumber(value.backgroundBrightness, 0, 2, "背景亮度");
  }
  if ("backgroundSize" in value) patch.backgroundSize = requireBackgroundSize(value.backgroundSize);
  return patch;
}

function projectAppearanceRow(row: DatabaseRow): ServerWebAppearanceSnapshot {
  const updatedAt = requireText(row.updated_at, 64, "更新时间");
  return {
    settings: {
      color: requireColor(row.color),
      theme: requireTheme(row.theme),
      fontSize: requireInteger(row.font_size, 12, 24, "文本大小"),
      fontFamily: requireText(row.font_family, 512, "字体"),
      minimalMode: row.minimal_mode === 1,
      backgroundImage: requireBackgroundImage(row.background_image),
      backgroundOpacity: requireNumber(row.background_opacity, 0, 1, "背景不透明度"),
      backgroundBlur: requireNumber(row.background_blur, 0, 20, "背景模糊程度"),
      backgroundBrightness: requireNumber(row.background_brightness, 0, 2, "背景亮度"),
      backgroundSize: requireBackgroundSize(row.background_size),
    },
    revision: requireInteger(row.revision, 1, Number.MAX_SAFE_INTEGER, "外观版本"),
    updatedAt,
  };
}

function requireColor(value: unknown): ServerWebAppearanceColor {
  if (["default", "ocean", "rose", "sunset", "midnight"].includes(String(value))) {
    return value as ServerWebAppearanceColor;
  }
  throw new TypeError("颜色主题无效");
}

function requireTheme(value: unknown): ServerWebAppearanceTheme {
  if (value === "auto" || value === "light" || value === "dark") return value;
  throw new TypeError("主题模式无效");
}

function requireBackgroundSize(value: unknown): ServerWebBackgroundSize {
  if (value === "cover" || value === "contain" || value === "fill" || value === "auto") {
    return value;
  }
  throw new TypeError("背景填充方式无效");
}

function requireBackgroundImage(value: unknown): string {
  const image = requireText(value, maximumBackgroundImageCharacters, "背景图片");
  if (image && !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/u.test(image)) {
    throw new TypeError("背景图片必须是 PNG、JPEG、WEBP 或 GIF Data URL");
  }
  return image;
}

function requireText(value: unknown, maximumLength: number, label: string): string {
  if (typeof value !== "string" || value.length > maximumLength || value.includes("\0")) {
    throw new TypeError(`${label}无效`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label}无效`);
  return value;
}

function requireNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label}无效`);
  }
  return value;
}

function requireInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label}无效`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
