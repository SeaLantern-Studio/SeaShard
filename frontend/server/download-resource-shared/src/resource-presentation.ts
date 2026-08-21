import type {
  ServerInstanceSnapshot,
  ServerModFilterOption,
  ServerModFilters,
  ServerModProject,
  ServerModSearchRequest,
  ServerModSearchResult,
  ServerModSource,
  ServerModVersion,
} from "@seashard/contracts";

export interface ServerModDisplayName {
  readonly primary: string;
  readonly original?: string;
}

export interface ServerModDisplayTags {
  readonly categories: readonly string[];
  readonly content: readonly string[];
}
export interface ServerModVersionGroup {
  readonly id: string;
  readonly gameVersion: string;
  readonly loader: string;
  readonly versions: readonly ServerModVersion[];
}

const hanPattern = /\p{Script=Han}/u;
const hourMilliseconds = 60 * 60 * 1_000;
const dayMilliseconds = 24 * hourMilliseconds;
const categoryTagIds = new Set(["library"]);
const compactDownloadUnits = [
  { threshold: 1_000_000_000_000, suffix: "万亿" },
  { threshold: 100_000_000, suffix: "亿" },
  { threshold: 10_000, suffix: "万" },
] as const;
const versionCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

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

/** 按 Modrinth 元数据拆分加载器、类别与内容标签，前置库归入类别。 */
export function serverModDisplayTags(
  categories: readonly string[],
  loaders: readonly ServerModFilterOption[],
  tags: readonly ServerModFilterOption[],
): ServerModDisplayTags {
  const loaderLabels = new Map(loaders.map(({ id, label }) => [id, label]));
  const categoryLabels = new Map(
    tags.filter(({ id }) => categoryTagIds.has(id)).map(({ id, label }) => [id, label]),
  );
  const contentLabels = new Map(
    tags.filter(({ id }) => !categoryTagIds.has(id)).map(({ id, label }) => [id, label]),
  );
  return {
    categories: uniqueLabels(categories, new Map([...loaderLabels, ...categoryLabels])),
    content: uniqueLabels(categories, contentLabels),
  };
}
/**
 * 下载量最多保留四个数字：三位整数可带一位小数，四位整数不带小数。
 * 接近单位边界的值会提升到更大单位，避免出现“10000万”。
 */
export function formatServerModDownloadCount(value: number): string {
  const count = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  for (let index = 0; index < compactDownloadUnits.length; index += 1) {
    const unit = compactDownloadUnits[index]!;
    if (count < unit.threshold) continue;

    const scaled = count / unit.threshold;
    const rounded = scaled < 1_000 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
    if (rounded >= 10_000 && index > 0) {
      const largerUnit = compactDownloadUnits[index - 1]!;
      return `${formatCompactDownloadDigits(count / largerUnit.threshold)}${largerUnit.suffix}`;
    }
    return `${formatCompactDownloadDigits(scaled)}${unit.suffix}`;
  }
  return String(count);
}

function formatCompactDownloadDigits(value: number): string {
  if (value < 1_000) {
    const rounded = Math.round(value * 10) / 10;
    if (rounded < 1_000) return String(rounded);
  }
  return String(Math.round(value));
}

/** 按加载器与 Minecraft 版本分类；没有加载器的地图/数据包归入“通用”组。 */
export function groupServerModVersions(
  versions: readonly ServerModVersion[],
  gameVersionFilter = "",
  loaderFilter = "",
): ServerModVersionGroup[] {
  const groups = new Map<string, ServerModVersion[]>();
  for (const version of versions) {
    if (gameVersionFilter && !version.gameVersions.includes(gameVersionFilter)) continue;
    if (loaderFilter && !version.loaders.includes(loaderFilter)) continue;
    const versionLoaders = version.loaders.length > 0 ? version.loaders : [""];
    for (const loader of versionLoaders) {
      if (loaderFilter && loader !== loaderFilter) continue;
      for (const gameVersion of version.gameVersions) {
        if (gameVersionFilter && gameVersion !== gameVersionFilter) continue;
        const id = `${loader}:${gameVersion}`;
        const group = groups.get(id);
        if (group) group.push(version);
        else groups.set(id, [version]);
      }
    }
  }
  return [...groups.entries()]
    .map(([id, groupVersions]) => {
      const separator = id.indexOf(":");
      return {
        id,
        loader: id.slice(0, separator),
        gameVersion: id.slice(separator + 1),
        versions: [...groupVersions].sort(
          (left, right) => Date.parse(right.datePublished) - Date.parse(left.datePublished),
        ),
      };
    })
    .sort(
      (left, right) =>
        versionCollator.compare(right.gameVersion, left.gameVersion) ||
        left.loader.localeCompare(right.loader, "en"),
    );
}

/** 只有加载器与精确 Minecraft 版本都匹配的已登记实例才可成为安装目标。 */
export function compatibleServerModInstances(
  version: ServerModVersion,
  instances: readonly ServerInstanceSnapshot[],
): ServerInstanceSnapshot[] {
  return instances.filter(
    (instance) =>
      instance.modLoader !== null &&
      version.loaders.includes(instance.modLoader) &&
      !!instance.gameVersion &&
      version.gameVersions.includes(instance.gameVersion),
  );
}

/**
 * 将补丁版本折叠到游戏版本线，并按官方版本序列压缩连续范围。
 * 只有连续支持到当前最新版本时才使用“+”，避免把中间缺失版本误报为兼容。
 */
export function formatServerModVersionRange(
  projectVersions: readonly string[],
  knownVersions: readonly ServerModFilterOption[],
): string {
  const projectLines = uniqueVersionLines(projectVersions);
  if (projectLines.length === 0) return "版本未知";

  const knownLines = uniqueVersionLines(knownVersions.map(({ id }) => id)).sort(
    compareVersionLines,
  );
  const knownLineSet = new Set(knownLines);
  if (
    knownLines.length === 0 ||
    projectLines.some((versionLine) => !knownLineSet.has(versionLine))
  ) {
    return formatVersionBounds(projectLines);
  }

  const supportedLines = new Set(projectLines);
  const ranges: string[] = [];
  let rangeStart = -1;
  for (let index = 0; index < knownLines.length; index += 1) {
    const supported = supportedLines.has(knownLines[index]!);
    if (supported && rangeStart < 0) rangeStart = index;
    if (rangeStart < 0 || (supported && index < knownLines.length - 1)) continue;

    const rangeEnd = supported ? index : index - 1;
    const first = knownLines[rangeStart]!;
    const last = knownLines[rangeEnd]!;
    if (rangeStart === rangeEnd) {
      ranges.push(first);
    } else if (rangeEnd === knownLines.length - 1) {
      ranges.push(`${first}+`);
    } else {
      ranges.push(`${first}–${last}`);
    }
    rangeStart = -1;
  }
  return ranges.join("、");
}

/** 更新时间只使用小时、天、周、月四档，避免列表中混入完整日期。 */
export function formatServerModRelativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "刚刚";
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < dayMilliseconds) {
    return `${Math.max(1, Math.floor(elapsed / hourMilliseconds))} 小时前`;
  }
  const days = Math.floor(elapsed / dayMilliseconds);
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  return `${Math.floor(days / 30)} 个月前`;
}

function uniqueVersionLines(versions: readonly string[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const version of versions) {
    const trimmed = version.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\.(\d+)/u.exec(trimmed);
    const line = match ? `${match[1]}.${match[2]}` : trimmed;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

function formatVersionBounds(versions: readonly string[]): string {
  const sorted = [...versions].sort(compareVersionLines);
  if (sorted.length === 1) return sorted[0]!;
  return `${sorted[0]}–${sorted.at(-1)}`;
}

function compareVersionLines(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  if (
    leftParts.every(Number.isFinite) &&
    rightParts.every(Number.isFinite) &&
    leftParts.length === rightParts.length
  ) {
    for (let index = 0; index < leftParts.length; index += 1) {
      const difference = leftParts[index]! - rightParts[index]!;
      if (difference !== 0) return difference;
    }
    return 0;
  }
  return left.localeCompare(right, "en", { numeric: true });
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

export type ServerModSearchSource = ServerModSource | "all";

export const serverModSourceFilterOptions: readonly ServerModFilterOption[] = [
  { id: "all", label: "所有" },
  { id: "modrinth", label: "Modrinth" },
  { id: "curseforge", label: "CurseForge" },
];

/** 合并两个来源的筛选元数据；来源筛选本身始终保留“所有”。 */
export function mergeServerModFilters(filters: readonly ServerModFilters[]): ServerModFilters {
  return {
    sources: serverModSourceFilterOptions,
    tags: mergeFilterOptions(filters.map((item) => item.tags)),
    versions: mergeFilterOptions(filters.map((item) => item.versions)),
    loaders: mergeFilterOptions(filters.map((item) => item.loaders)),
  };
}

function mergeFilterOptions(
  optionGroups: readonly (readonly ServerModFilterOption[])[],
): ServerModFilterOption[] {
  const merged = new Map<string, ServerModFilterOption>();
  for (const options of optionGroups) {
    for (const option of options) {
      if (!merged.has(option.id)) merged.set(option.id, option);
    }
  }
  return [...merged.values()];
}

export interface ServerModMixedSearchState {
  readonly offsets: Record<ServerModSource, number>;
  readonly buffers: Record<ServerModSource, ServerModProject[]>;
  readonly totals: Record<ServerModSource, number>;
  readonly finished: Record<ServerModSource, boolean>;
}

export function createServerModMixedSearchState(): ServerModMixedSearchState {
  return {
    offsets: { modrinth: 0, curseforge: 0 },
    buffers: { modrinth: [], curseforge: [] },
    totals: { modrinth: 0, curseforge: 0 },
    finished: { modrinth: false, curseforge: false },
  };
}

/**
 * 按来源轮流取数，保证“所有”筛选不会丢掉某一来源的分页结果。
 * 每个来源独立维护游标和缓冲区，避免把两个来源的排序页简单拼接后丢失后半页。
 */
export async function searchServerModMixedPage(
  request: Omit<ServerModSearchRequest, "source" | "offset" | "limit">,
  state: ServerModMixedSearchState,
  limit: number,
  search: (request: ServerModSearchRequest) => Promise<ServerModSearchResult>,
): Promise<ServerModSearchResult> {
  const sources: readonly ServerModSource[] = ["modrinth", "curseforge"];
  while (
    sources.some((source) => !state.finished[source]) &&
    sources.reduce((count, source) => count + state.buffers[source].length, 0) < limit
  ) {
    const results = await Promise.all(
      sources
        .filter((source) => !state.finished[source])
        .map(async (source) => ({
          source,
          result: await search({
            ...request,
            source,
            offset: state.offsets[source],
            limit,
          }),
        })),
    );
    for (const { source, result } of results) {
      state.buffers[source].push(...result.items);
      state.offsets[source] += result.limit;
      state.totals[source] = result.total;
      state.finished[source] = result.items.length === 0 || state.offsets[source] >= result.total;
    }
  }

  const items: ServerModProject[] = [];
  const pageOffset =
    state.offsets.modrinth +
    state.offsets.curseforge -
    state.buffers.modrinth.length -
    state.buffers.curseforge.length;
  while (items.length < limit) {
    let consumed = false;
    for (const source of sources) {
      const item = state.buffers[source].shift();
      if (!item) continue;
      items.push(item);
      consumed = true;
      if (items.length >= limit) break;
    }
    if (!consumed) break;
  }
  return {
    items,
    offset: pageOffset,
    limit: items.length,
    total: state.totals.modrinth + state.totals.curseforge,
  };
}
