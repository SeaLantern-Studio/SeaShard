import type {
  ServerModFilterOption,
  ServerModFilters,
  ServerModProject,
  ServerModSearchRequest,
  ServerModSearchResult,
  ServerModSource,
} from "@seashard/contracts";

export type ServerModSearchSource = ServerModSource | "all";

export const serverModSourceFilterOptions: readonly ServerModFilterOption[] = [
  { id: "all", label: "所有" },
  { id: "modrinth", label: "Modrinth" },
  { id: "curseforge", label: "CurseForge" },
];

/** 合并两个来源的筛选元数据；来源筛选本身始终保留“所有”。 */
export function mergeServerModFilters(filters: readonly ServerModFilters[]): ServerModFilters {
  const unavailableReason = filters.find(
    ({ unavailableReason }) => unavailableReason,
  )?.unavailableReason;
  return {
    sources: serverModSourceFilterOptions,
    tags: mergeFilterOptions(filters.map((item) => item.tags)),
    versions: mergeFilterOptions(filters.map((item) => item.versions)),
    loaders: mergeFilterOptions(filters.map((item) => item.loaders)),
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

/**
 * 合并当前可用来源的筛选元数据。
 * 单个来源暂时不可用时保留其他来源；全部来源失败时继续抛出首个错误。
 */
export function mergeAvailableServerModFilters(
  results: readonly PromiseSettledResult<ServerModFilters>[],
): ServerModFilters {
  const available = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (available.length > 0) return mergeServerModFilters(available);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throwSourceFailure(failure.reason);
  throw new Error("没有可用的服务端资源来源");
}

export interface ServerModMixedSearchState {
  readonly offsets: Record<ServerModSource, number>;
  readonly buffers: Record<ServerModSource, ServerModProject[]>;
  readonly totals: Record<ServerModSource, number>;
  readonly finished: Record<ServerModSource, boolean>;
  consumedItems: number;
}

export function createServerModMixedSearchState(): ServerModMixedSearchState {
  return {
    offsets: { modrinth: 0, curseforge: 0 },
    buffers: { modrinth: [], curseforge: [] },
    totals: { modrinth: 0, curseforge: 0 },
    finished: { modrinth: false, curseforge: false },
    consumedItems: 0,
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
  let unavailableReason: string | undefined;
  while (
    sources.some((source) => !state.finished[source]) &&
    sources.reduce((count, source) => count + state.buffers[source].length, 0) < limit
  ) {
    const activeSources = sources.filter((source) => !state.finished[source]);
    const results = await Promise.allSettled(
      activeSources.map((source) =>
        search({
          ...request,
          source,
          offset: state.offsets[source],
          limit,
        }),
      ),
    );
    let successfulSources = 0;
    for (const [index, result] of results.entries()) {
      const source = activeSources[index];
      if (!source) continue;
      if (result.status === "rejected") {
        // 当前来源失败后停止本次混合搜索对它的继续请求，显式选择该来源时仍会显示原始错误。
        state.finished[source] = true;
        continue;
      }
      successfulSources += 1;
      unavailableReason ??= result.value.unavailableReason;
      state.buffers[source].push(...result.value.items);
      state.offsets[source] += result.value.limit;
      state.totals[source] = result.value.total;
      state.finished[source] =
        result.value.items.length === 0 || state.offsets[source] >= result.value.total;
    }
    if (
      successfulSources === 0 &&
      state.buffers.modrinth.length + state.buffers.curseforge.length === 0
    ) {
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throwSourceFailure(failure.reason);
      break;
    }
  }

  const items: ServerModProject[] = [];
  // 上游 offset 记录的是数据源游标，可能包含未展示的空位；分页偏移只看已经消费的项目数。
  const pageOffset = state.consumedItems;
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
  state.consumedItems += items.length;
  return {
    items,
    offset: pageOffset,
    limit: items.length,
    total: state.totals.modrinth + state.totals.curseforge,
    ...(unavailableReason ? { unavailableReason } : {}),
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

function throwSourceFailure(reason: unknown): never {
  if (reason instanceof Error) throw reason;
  if (typeof reason === "string" && reason.length > 0) throw new Error(reason);
  throw new Error("服务端资源来源暂时不可用");
}
