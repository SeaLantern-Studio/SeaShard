import type {
  ServerModFilterOption,
  ServerModProject,
  ServerModrinthResourceType,
  ServerModSource,
} from "@seashard/contracts";

export interface ServerModDisplayName {
  readonly primary: string;
  readonly original?: string;
}

export interface ServerModDisplayTags {
  readonly categories: readonly string[];
  readonly content: readonly string[];
}

const hanPattern = /\p{Script=Han}/u;

/** Modrinth 没有独立英文标题字段；优先拆分标题内英文，缺失时再用稳定 slug 还原。 */
export function serverModDisplayName(
  project: Pick<ServerModProject, "title" | "slug">,
): ServerModDisplayName {
  if (!hanPattern.test(project.title)) return { primary: project.title };
  const separatedTitle =
    /^(.*\p{Script=Han}.*?)\s*[|｜]\s*([A-Za-z].*)$/u.exec(project.title) ??
    /^(.*\p{Script=Han})\s+([A-Za-z][A-Za-z0-9+.'’&() -]*)$/u.exec(project.title);
  if (separatedTitle) {
    return {
      primary: separatedTitle[1]!.trim(),
      original: separatedTitle[2]!.trim(),
    };
  }
  const original = project.slug
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
  return original ? { primary: project.title, original } : { primary: project.title };
}

/** 按 MC 百科搜索页约定把词组连接为加号，再由 URL 查询参数编码加号。 */
export function serverModMcEncyclopediaSearchUrl(projectTitle: string): string {
  const url = new URL("https://search.mcmod.cn/s");
  url.searchParams.set("key", projectTitle.trim().replace(/\s+/gu, "+"));
  url.searchParams.set("mold", "0");
  return url.href;
}

/** 按 Modrinth 元数据拆分加载器与内容标签；前置库始终排在内容标签首位。 */
export function serverModDisplayTags(
  categories: readonly string[],
  loaders: readonly ServerModFilterOption[],
  tags: readonly ServerModFilterOption[],
): ServerModDisplayTags {
  const loaderLabels = new Map(loaders.map(({ id, label }) => [id, label]));
  const contentLabels = new Map(tags.map(({ id, label }) => [id, label]));
  const contentCategories = [
    ...categories.filter((category) => category === "library"),
    ...categories.filter((category) => category !== "library"),
  ];
  return {
    categories: uniqueLabels(categories, loaderLabels),
    content: uniqueLabels(contentCategories, contentLabels),
  };
}

/** 将项目来源转换为列表项中显示的来源标签，保持真实来源用于后续详情与下载。 */
export function serverModSourceLabel(source: ServerModSource): string {
  return source === "modrinth" ? "Modrinth" : "CurseForge";
}

/** 按真实来源和资源类型生成项目详情链接，避免把 CurseForge 项目误指向 Modrinth。 */
export function serverModProjectUrl(
  project: Pick<ServerModProject, "source" | "slug">,
  resourceType: ServerModrinthResourceType,
): string {
  if (project.source === "curseforge") {
    const pathSegment =
      resourceType === "mod"
        ? "mc-mods"
        : resourceType === "modpack"
          ? "modpacks"
          : resourceType === "datapack"
            ? "data-packs"
            : "worlds";
    return `https://www.curseforge.com/minecraft/${pathSegment}/${encodeURIComponent(project.slug)}`;
  }

  const pathSegment =
    resourceType === "mod"
      ? "mod"
      : resourceType === "modpack"
        ? "modpack"
        : resourceType === "datapack"
          ? "datapack"
          : "world";
  return `https://modrinth.com/${pathSegment}/${encodeURIComponent(project.slug)}`;
}

function uniqueLabels(
  categories: readonly string[],
  labels: ReadonlyMap<string, string>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const category of categories) {
    const label = labels.get(category);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    result.push(label);
  }
  return result;
}
