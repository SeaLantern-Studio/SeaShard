<script setup lang="ts">
import {
  serverModSearchLimits,
  type ServerModFilterOption,
  type ServerModFilters,
  type ServerModProject,
  type ServerModSearchIndex,
  type ServerModSearchResult,
  type ServerModSourceClientService,
} from "@seashard/contracts";
import { Cmz_Input, Cmz_Select, type SelectOption } from "cmzya-modern-ui";
import { Box, Clock3, Download, Puzzle, Search, UserRound } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  formatServerModDownloadCount,
  formatServerModRelativeTime,
  formatServerModVersionRange,
  serverModDisplayName,
  serverModDisplayTags,
} from "./mod-presentation";

const props = defineProps<{
  mods: ServerModSourceClientService;
}>();

const emptyFilters: ServerModFilters = {
  sources: [{ id: "modrinth", label: "Modrinth" }],
  tags: [],
  versions: [],
  loaders: [],
};
const sortOptions: SelectOption[] = [
  { label: "相关度", value: "relevance" },
  { label: "下载量", value: "downloads" },
  { label: "收藏量", value: "follows" },
  { label: "最新发布", value: "newest" },
  { label: "最近更新", value: "updated" },
];

const filters = ref<ServerModFilters>(emptyFilters);
const filtersLoading = ref(true);
const filtersError = ref("");
const query = ref("");
const source = ref("modrinth");
const tag = ref("");
const sort = ref<ServerModSearchIndex>("downloads");
const gameVersion = ref("");
const loader = ref("");
const projects = ref<readonly ServerModProject[]>([]);
const total = ref(0);
const initialLoading = ref(true);
const loadingMore = ref(false);
const searchError = ref("");
const failedIconIds = ref<ReadonlySet<string>>(new Set());
const loadSentinel = ref<HTMLElement>();
let observer: IntersectionObserver | undefined;
let queryTimer: ReturnType<typeof setTimeout> | undefined;
let searchGeneration = 0;
let relativeTimeTimer: ReturnType<typeof setInterval> | undefined;
const relativeTimeNow = ref(Date.now());

const sourceOptions = computed(() => toSelectOptions(filters.value.sources));
const tagOptions = computed(() => withAllOption("全部标签", filters.value.tags));
const versionOptions = computed(() => withAllOption("全部版本", filters.value.versions));
const loaderOptions = computed(() => withAllOption("全部加载器", filters.value.loaders));
const hasMore = computed(() => projects.value.length < total.value);
const resultSummary = computed(() => {
  if (initialLoading.value) return "正在搜索服务端 Mod";
  if (searchError.value) return "搜索失败";
  return `找到 ${total.value.toLocaleString("zh-CN")} 个服务端 Mod`;
});

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadNextPage();
    },
    { rootMargin: "240px 0px" },
  );
  if (loadSentinel.value) observer.observe(loadSentinel.value);
  relativeTimeTimer = setInterval(() => {
    relativeTimeNow.value = Date.now();
  }, 60_000);
  void loadFilters();
  void resetSearch();
});

watch(loadSentinel, (next, previous) => {
  if (previous) observer?.unobserve(previous);
  if (next) observer?.observe(next);
});

onBeforeUnmount(() => {
  searchGeneration += 1;
  if (queryTimer) clearTimeout(queryTimer);
  if (relativeTimeTimer) clearInterval(relativeTimeTimer);
  observer?.disconnect();
});

async function loadFilters(): Promise<void> {
  filtersLoading.value = true;
  filtersError.value = "";
  try {
    filters.value = await props.mods.getFilters();
  } catch (error) {
    filtersError.value = errorMessage(error);
  } finally {
    filtersLoading.value = false;
  }
}

function updateQuery(value: string | number): void {
  if (typeof value !== "string") return;
  query.value = value;
  if (queryTimer) clearTimeout(queryTimer);
  queryTimer = setTimeout(() => {
    queryTimer = undefined;
    void resetSearch();
  }, 350);
}

function updateSource(value: string | number): void {
  if (value !== "modrinth" || source.value === value) return;
  source.value = value;
  void resetSearch();
}

function updateTag(value: string | number): void {
  if (typeof value !== "string" || tag.value === value) return;
  tag.value = value;
  void resetSearch();
}

function updateSort(value: string | number): void {
  if (
    typeof value !== "string" ||
    !sortOptions.some((option) => option.value === value) ||
    sort.value === value
  ) {
    return;
  }
  sort.value = value as ServerModSearchIndex;
  void resetSearch();
}

function updateGameVersion(value: string | number): void {
  if (typeof value !== "string" || gameVersion.value === value) return;
  gameVersion.value = value;
  void resetSearch();
}

function updateLoader(value: string | number): void {
  if (typeof value !== "string" || loader.value === value) return;
  loader.value = value;
  void resetSearch();
}

async function resetSearch(): Promise<void> {
  if (queryTimer) {
    clearTimeout(queryTimer);
    queryTimer = undefined;
  }
  const generation = ++searchGeneration;
  projects.value = [];
  total.value = 0;
  failedIconIds.value = new Set();
  searchError.value = "";
  initialLoading.value = true;
  loadingMore.value = false;
  try {
    const result = await searchPage(0);
    if (generation !== searchGeneration) return;
    applyFirstPage(result);
  } catch (error) {
    if (generation === searchGeneration) searchError.value = errorMessage(error);
  } finally {
    if (generation === searchGeneration) {
      initialLoading.value = false;
      await nextTick();
      maybeFillViewport();
    }
  }
}

async function loadNextPage(): Promise<void> {
  if (initialLoading.value || loadingMore.value || searchError.value || !hasMore.value) return;
  const generation = searchGeneration;
  loadingMore.value = true;
  try {
    const result = await searchPage(projects.value.length);
    if (generation !== searchGeneration) return;
    const seen = new Set(projects.value.map((project) => project.id));
    projects.value = [
      ...projects.value,
      ...result.items.filter((project) => !seen.has(project.id)),
    ];
    total.value = result.total;
  } catch (error) {
    if (generation === searchGeneration) searchError.value = errorMessage(error);
  } finally {
    if (generation === searchGeneration) {
      loadingMore.value = false;
      await nextTick();
      maybeFillViewport();
    }
  }
}

function searchPage(offset: number): Promise<ServerModSearchResult> {
  return props.mods.search({
    source: "modrinth",
    query: query.value,
    tag: tag.value,
    index: sort.value,
    gameVersion: gameVersion.value,
    loader: loader.value,
    offset,
    limit: serverModSearchLimits.pageSize,
  });
}

function applyFirstPage(result: ServerModSearchResult): void {
  projects.value = result.items;
  total.value = result.total;
}

/** 首屏不足一页高时继续补一页；每次完成后才判断，始终保持单个在途请求。 */
function maybeFillViewport(): void {
  const sentinel = loadSentinel.value;
  if (!sentinel || !hasMore.value || initialLoading.value || loadingMore.value) return;
  if (sentinel.getBoundingClientRect().top <= window.innerHeight + 240) void loadNextPage();
}

function toSelectOptions(options: readonly ServerModFilterOption[]): SelectOption[] {
  return options.map(({ id, label }) => ({ label, value: id }));
}

function withAllOption(label: string, options: readonly ServerModFilterOption[]): SelectOption[] {
  return [{ label, value: "" }, ...toSelectOptions(options)];
}
function primaryProjectName(project: ServerModProject): string {
  return serverModDisplayName(project).primary;
}

function originalProjectName(project: ServerModProject): string | undefined {
  return serverModDisplayName(project).original;
}

function projectCategoryTags(project: ServerModProject): readonly string[] {
  return serverModDisplayTags(project.categories, filters.value.loaders, filters.value.tags)
    .categories;
}

function projectContentTags(project: ServerModProject): readonly string[] {
  return serverModDisplayTags(project.categories, filters.value.loaders, filters.value.tags)
    .content;
}

function projectIconFailed(project: ServerModProject): boolean {
  return failedIconIds.value.has(project.id);
}

function markProjectIconFailed(projectId: string): void {
  failedIconIds.value = new Set([...failedIconIds.value, projectId]);
}

function versionRange(project: ServerModProject): string {
  return formatServerModVersionRange(project.versions, filters.value.versions);
}

function formatRelativeTime(value: string): string {
  return formatServerModRelativeTime(value, relativeTimeNow.value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section class="server-mod-download-page" aria-label="Mod 下载">
    <div class="mod-search-field">
      <Search class="mod-search-icon" :size="19" :stroke-width="1.9" aria-hidden="true" />
      <Cmz_Input
        class="mod-search-control"
        :model-value="query"
        :maxlength="serverModSearchLimits.maximumQueryLength"
        placeholder="搜索 Mod 名称或关键词"
        aria-label="搜索服务端 Mod"
        @update:model-value="updateQuery"
      />
    </div>

    <div class="mod-filter-grid" aria-label="Mod 搜索筛选">
      <label class="mod-filter-field">
        <span>来源</span>
        <Cmz_Select
          :model-value="source"
          :options="sourceOptions"
          :disabled="filtersLoading"
          @update:model-value="updateSource"
        />
      </label>
      <label class="mod-filter-field">
        <span>标签</span>
        <Cmz_Select
          :model-value="tag"
          :options="tagOptions"
          :disabled="filtersLoading"
          :searchable="true"
          placeholder="全部标签"
          @update:model-value="updateTag"
        />
      </label>
      <label class="mod-filter-field">
        <span>排序</span>
        <Cmz_Select :model-value="sort" :options="sortOptions" @update:model-value="updateSort" />
      </label>
      <label class="mod-filter-field">
        <span>版本</span>
        <Cmz_Select
          :model-value="gameVersion"
          :options="versionOptions"
          :disabled="filtersLoading"
          :searchable="true"
          placeholder="全部版本"
          @update:model-value="updateGameVersion"
        />
      </label>
      <label class="mod-filter-field">
        <span>加载器</span>
        <Cmz_Select
          :model-value="loader"
          :options="loaderOptions"
          :disabled="filtersLoading"
          :searchable="true"
          placeholder="全部加载器"
          @update:model-value="updateLoader"
        />
      </label>
    </div>

    <div v-if="filtersError" class="mod-inline-error" role="alert">
      <span>筛选项加载失败：{{ filtersError }}</span>
      <button type="button" @click="loadFilters">重试</button>
    </div>

    <div class="mod-results-heading">
      <strong>{{ resultSummary }}</strong>
      <span v-if="projects.length > 0"
        >已加载 {{ projects.length.toLocaleString("zh-CN") }} 个</span
      >
    </div>

    <div v-if="initialLoading" class="mod-project-list" aria-label="正在加载 Mod">
      <div v-for="index in 6" :key="index" class="mod-project-row mod-project-row-loading">
        <span class="mod-project-icon-placeholder" />
        <span class="mod-project-copy-placeholder">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>

    <div v-else-if="searchError && projects.length === 0" class="mod-result-state" role="alert">
      <strong>无法加载 Mod</strong>
      <span>{{ searchError }}</span>
      <button type="button" @click="resetSearch">重新搜索</button>
    </div>

    <div v-else-if="projects.length === 0" class="mod-result-state">
      <strong>没有找到符合条件的 Mod</strong>
      <span>尝试减少筛选条件或更换搜索关键词。</span>
    </div>

    <div v-else class="mod-project-list" aria-live="polite">
      <article v-for="project in projects" :key="project.id" class="mod-project-row">
        <span class="mod-project-icon">
          <img
            v-if="project.iconUrl && !projectIconFailed(project)"
            :src="project.iconUrl"
            alt=""
            draggable="false"
            referrerpolicy="no-referrer"
            @error="markProjectIconFailed(project.id)"
          />
          <Puzzle v-else :size="24" :stroke-width="1.7" aria-hidden="true" />
        </span>
        <div class="mod-project-copy">
          <div class="mod-project-title-line">
            <strong>{{ primaryProjectName(project) }}</strong>
            <template v-if="originalProjectName(project)">
              <span class="mod-project-name-separator" aria-hidden="true">|</span>
              <span class="mod-project-original-name">{{ originalProjectName(project) }}</span>
            </template>
          </div>
          <div class="mod-project-description-line">
            <div v-if="projectContentTags(project).length > 0" class="mod-content-tags">
              <span
                v-for="contentTag in projectContentTags(project)"
                :key="`content:${contentTag}`"
                class="mod-content-tag"
              >
                {{ contentTag }}
              </span>
            </div>
            <p>{{ project.description || "该项目暂未提供简介。" }}</p>
          </div>
          <div class="mod-project-footer">
            <div class="mod-category-tags">
              <span
                v-for="category in projectCategoryTags(project)"
                :key="`category:${category}`"
                class="mod-category-tag"
              >
                {{ category }}
              </span>
            </div>
            <div class="mod-project-meta">
              <span>
                <UserRound :size="14" :stroke-width="1.8" aria-hidden="true" />
                <span>{{ project.author }}</span>
              </span>
              <span>
                <Box :size="14" :stroke-width="1.8" aria-hidden="true" />
                <span>{{ versionRange(project) }}</span>
              </span>
              <span>
                <Clock3 :size="14" :stroke-width="1.8" aria-hidden="true" />
                <span>{{ formatRelativeTime(project.dateModified) }}</span>
              </span>
            </div>
          </div>
        </div>
        <div class="mod-project-downloads" :aria-label="`${project.downloads} 次下载`">
          <Download :size="17" :stroke-width="1.9" aria-hidden="true" />
          <strong>{{ formatServerModDownloadCount(project.downloads) }}</strong>
        </div>
      </article>

      <div ref="loadSentinel" class="mod-load-sentinel" aria-hidden="true" />
      <div v-if="loadingMore" class="mod-loading-more" role="status">
        <span class="mod-loading-spinner" />
        正在加载更多
      </div>
      <div v-else-if="searchError" class="mod-inline-error mod-load-error" role="alert">
        <span>加载下一页失败：{{ searchError }}</span>
        <button type="button" @click="loadNextPage">重试</button>
      </div>
      <p v-else-if="!hasMore" class="mod-list-end">已加载全部结果</p>
    </div>
  </section>
</template>

<style scoped src="./ServerModDownloadPage.css"></style>
