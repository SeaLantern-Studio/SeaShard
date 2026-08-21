<script setup lang="ts">
import {
  serverModSearchLimits,
  type ServerInstanceClientService,
  type ServerInstanceSnapshot,
  type ServerModFilterOption,
  type ServerModFilters,
  type ServerModProject,
  type ServerModProjectDetails,
  type ServerModSearchIndex,
  type ServerModSearchResult,
  type ServerModSourceClientService,
  type ServerModVersion,
} from "@seashard/contracts";
import {
  Cmz_Button,
  Cmz_Input,
  Cmz_Markdown,
  Cmz_Modal,
  Cmz_Select,
  type SelectOption,
} from "cmzya-modern-ui";
import {
  ArrowLeft,
  Box,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Download,
  Heart,
  Link2,
  Archive,
  Package,
  Search,
  UserRound,
  X,
} from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  formatServerModDownloadCount,
  formatServerModRelativeTime,
  formatServerModVersionRange,
  groupServerModVersions,
  serverModDisplayName,
  serverModDisplayTags,
} from "./resource-presentation";

const props = defineProps<{
  resources: ServerModSourceClientService;
  instances?: ServerInstanceClientService;
  resourceType: "modpack" | "datapack";
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
const resourceLabel = computed(() => (props.resourceType === "modpack" ? "整合包" : "数据包"));
const resourcePathSegment = computed(() =>
  props.resourceType === "modpack" ? "modpack" : "datapack",
);
const resourceIcon = computed(() => (props.resourceType === "modpack" ? Package : Archive));
const showLoaderFilter = computed(() => props.resourceType === "modpack");
const downloadEnabled = computed(() => props.resourceType === "datapack");
const favoriteStorageKey = computed(() => `seashard.server-${props.resourceType}.favorites`);
const detailVersionCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
const detailMarkdownFeatures = {
  alert: false,
  linkCard: false,
  container: false,
} as const;

type DetailCopyAction = "name" | "link";
type DetailCopyState = "idle" | "success" | "error";

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
const nextOffset = ref(0);
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
const selectedProject = ref<ServerModProject>();
const projectDetails = ref<ServerModProjectDetails>();
const detailLoading = ref(false);
const detailError = ref("");
const detailGameVersion = ref("");
const detailLoader = ref("");
const expandedVersionGroupId = ref<string>();
const favoriteProjectIds = ref<ReadonlySet<string>>(new Set());
const copyActionStates = ref<Record<DetailCopyAction, DetailCopyState>>({
  name: "idle",
  link: "idle",
});
const detailDescriptionExpanded = ref(false);
let detailRequestId = 0;
const copyActionTimers = new Map<DetailCopyAction, ReturnType<typeof setTimeout>>();
const installModalOpen = ref(false);
const installVersion = ref<ServerModVersion>();
const compatibleInstances = ref<readonly ServerInstanceSnapshot[]>([]);
const installInstancesLoading = ref(false);
const installInstancesError = ref("");
const installPendingTarget = ref<string>();
const installActionError = ref("");
let installInstancesRequestId = 0;

const sourceOptions = computed(() => toSelectOptions(filters.value.sources));
const tagOptions = computed(() => withAllOption("全部标签", filters.value.tags));
const versionOptions = computed(() => withAllOption("全部版本", filters.value.versions));
const loaderOptions = computed(() => withAllOption("全部加载器", filters.value.loaders));
const hasMore = computed(() => nextOffset.value < total.value);
const resultSummary = computed(() => {
  if (initialLoading.value) return `正在搜索${resourceLabel.value}`;
  if (searchError.value) return "搜索失败";
  return `找到 ${total.value.toLocaleString("zh-CN")} 个${resourceLabel.value}`;
});
const detailVersions = computed<readonly ServerModVersion[]>(
  () => projectDetails.value?.versions ?? [],
);
const detailGameVersionOptions = computed(() =>
  withAllOption(
    "全部版本",
    uniqueDetailOptions(
      detailVersions.value.flatMap(({ gameVersions }) => gameVersions),
      (id) => id,
      (left, right) => detailVersionCollator.compare(right.id, left.id),
    ),
  ),
);
const detailLoaderOptions = computed(() =>
  withAllOption(
    "全部加载器",
    uniqueDetailOptions(
      detailVersions.value.flatMap(({ loaders }) => loaders),
      loaderLabel,
    ),
  ),
);
const detailVersionGroups = computed(() =>
  groupServerModVersions(detailVersions.value, detailGameVersion.value, detailLoader.value),
);
const detailDescription = computed(
  () =>
    projectDetails.value?.body.trim() ||
    selectedProject.value?.description ||
    "该项目暂未提供简介。",
);
const selectedProjectIsFavorite = computed(
  () => !!selectedProject.value && favoriteProjectIds.value.has(selectedProject.value.id),
);

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
  favoriteProjectIds.value = readFavoriteProjectIds();
});

watch(loadSentinel, (next, previous) => {
  if (previous) observer?.unobserve(previous);
  if (next) observer?.observe(next);
});
watch(
  detailVersionGroups,
  (groups) => {
    if (!groups.some(({ id }) => id === expandedVersionGroupId.value)) {
      expandedVersionGroupId.value = groups[0]?.id;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  searchGeneration += 1;
  if (queryTimer) clearTimeout(queryTimer);
  if (relativeTimeTimer) clearInterval(relativeTimeTimer);
  detailRequestId += 1;
  resetCopyActions();
  installInstancesRequestId += 1;
  observer?.disconnect();
});

async function loadFilters(): Promise<void> {
  filtersLoading.value = true;
  filtersError.value = "";
  try {
    filters.value = await props.resources.getFilters(props.resourceType, "modrinth");
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
  nextOffset.value = 0;
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
    const result = await searchPage(nextOffset.value);
    if (generation !== searchGeneration) return;
    const seen = new Set(projects.value.map((project) => project.id));
    projects.value = [
      ...projects.value,
      ...result.items.filter((project) => !seen.has(project.id)),
    ];
    total.value = result.total;
    nextOffset.value = result.offset + result.limit;
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
  return props.resources.search({
    resourceType: props.resourceType,
    source: "modrinth",
    query: query.value,
    tag: tag.value,
    index: sort.value,
    gameVersion: gameVersion.value,
    loader: showLoaderFilter.value ? loader.value : "",
    offset,
    limit: serverModSearchLimits.pageSize,
  });
}
function applyFirstPage(result: ServerModSearchResult): void {
  projects.value = result.items;
  total.value = result.total;
  nextOffset.value = result.offset + result.limit;
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
function uniqueDetailOptions(
  values: readonly string[],
  label: (id: string) => string,
  compare: (left: ServerModFilterOption, right: ServerModFilterOption) => number = (left, right) =>
    left.label.localeCompare(right.label, "en"),
): ServerModFilterOption[] {
  const seen = new Set<string>();
  const options: ServerModFilterOption[] = [];
  for (const id of values) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label: label(id) });
  }
  return options.sort(compare);
}

function loaderLabel(id: string): string {
  return (
    filters.value.loaders.find((option) => option.id === id)?.label ??
    id
      .split(/[-_]/u)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" ")
  );
}

async function openProject(project: ServerModProject): Promise<void> {
  selectedProject.value = project;
  projectDetails.value = undefined;
  detailGameVersion.value = "";
  detailLoader.value = "";
  detailError.value = "";
  detailDescriptionExpanded.value = false;
  resetCopyActions();
  await nextTick();
  window.scrollTo({ top: 0 });
  await loadProjectDetails();
}

function returnToProjectList(): void {
  detailRequestId += 1;
  selectedProject.value = undefined;
  projectDetails.value = undefined;
  detailLoading.value = false;
  detailError.value = "";
  detailGameVersion.value = "";
  detailLoader.value = "";
  expandedVersionGroupId.value = undefined;
  detailDescriptionExpanded.value = false;
  void nextTick().then(maybeFillViewport);
}

async function loadProjectDetails(): Promise<void> {
  const project = selectedProject.value;
  if (!project) return;
  const requestId = ++detailRequestId;
  detailLoading.value = true;
  detailError.value = "";
  try {
    const details = await props.resources.getProjectDetails(
      props.resourceType,
      "modrinth",
      project.id,
    );
    if (requestId === detailRequestId && selectedProject.value?.id === project.id) {
      projectDetails.value = details;
    }
  } catch (error) {
    if (requestId === detailRequestId) detailError.value = errorMessage(error);
  } finally {
    if (requestId === detailRequestId) detailLoading.value = false;
  }
}

function updateDetailGameVersion(value: string | number): void {
  if (typeof value === "string") detailGameVersion.value = value;
}

function updateDetailLoader(value: string | number): void {
  if (typeof value === "string") detailLoader.value = value;
}

function toggleVersionGroup(groupId: string): void {
  expandedVersionGroupId.value = expandedVersionGroupId.value === groupId ? undefined : groupId;
}

async function openInstallModal(version: ServerModVersion): Promise<void> {
  if (!downloadEnabled.value || !props.instances) return;
  const requestId = ++installInstancesRequestId;
  installVersion.value = version;
  compatibleInstances.value = [];
  installInstancesError.value = "";
  installActionError.value = "";
  installPendingTarget.value = undefined;
  installModalOpen.value = true;
  installInstancesLoading.value = true;
  try {
    const instances = await props.instances.list();
    if (requestId !== installInstancesRequestId) return;
    compatibleInstances.value = compatibleServerResourceInstances(version, instances);
  } catch (error) {
    if (requestId === installInstancesRequestId) {
      installInstancesError.value = errorMessage(error);
    }
  } finally {
    if (requestId === installInstancesRequestId) installInstancesLoading.value = false;
  }
}

function closeInstallModal(): void {
  if (installPendingTarget.value) return;
  installInstancesRequestId += 1;
  installModalOpen.value = false;
  installVersion.value = undefined;
  compatibleInstances.value = [];
  installInstancesError.value = "";
  installActionError.value = "";
}

function updateInstallModalVisible(visible: boolean): void {
  if (!visible) closeInstallModal();
}

async function installModToInstance(instance: ServerInstanceSnapshot): Promise<void> {
  const project = selectedProject.value;
  const version = installVersion.value;
  if (!project || !version || installPendingTarget.value) return;
  installPendingTarget.value = instance.id;
  installActionError.value = "";
  let completed = false;
  try {
    await props.resources.installToInstance({
      source: "modrinth",
      resourceType: "datapack",
      projectId: project.id,
      versionId: version.id,
      instanceId: instance.id,
    });
    completed = true;
  } catch (error) {
    installActionError.value = errorMessage(error);
  } finally {
    installPendingTarget.value = undefined;
    if (completed) closeInstallModal();
  }
}

async function saveModAs(): Promise<void> {
  const project = selectedProject.value;
  const version = installVersion.value;
  if (!project || !version || installPendingTarget.value) return;
  installPendingTarget.value = "save-as";
  installActionError.value = "";
  let completed = false;
  try {
    completed =
      (await props.resources.saveAs({
        source: "modrinth",
        resourceType: "datapack",
        projectId: project.id,
        versionId: version.id,
      })) !== undefined;
  } catch (error) {
    installActionError.value = errorMessage(error);
  } finally {
    installPendingTarget.value = undefined;
    if (completed) closeInstallModal();
  }
}

async function copyProjectName(): Promise<void> {
  if (!selectedProject.value) return;
  await copyDetailValue("name", selectedProject.value.title);
}

async function copyProjectLink(): Promise<void> {
  const project = selectedProject.value;
  if (!project) return;
  await copyDetailValue(
    "link",
    `https://modrinth.com/${resourcePathSegment.value}/${encodeURIComponent(project.slug)}`,
  );
}

async function copyDetailValue(action: DetailCopyAction, value: string): Promise<void> {
  try {
    await writeClipboard(value);
    setCopyActionState(action, "success");
  } catch {
    setCopyActionState(action, "error");
  }
}

async function writeClipboard(value: string): Promise<void> {
  let clipboardError: unknown;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) {
      throw clipboardError ?? new Error("系统剪贴板不可用");
    }
  } finally {
    input.remove();
  }
}

function toggleFavorite(): void {
  const project = selectedProject.value;
  if (!project) return;
  const next = new Set(favoriteProjectIds.value);
  if (next.has(project.id)) next.delete(project.id);
  else next.add(project.id);
  try {
    localStorage.setItem(favoriteStorageKey.value, JSON.stringify([...next]));
    favoriteProjectIds.value = next;
  } catch (error) {
    console.error("收藏状态保存失败", error);
  }
}

function readFavoriteProjectIds(): ReadonlySet<string> {
  try {
    const value = JSON.parse(localStorage.getItem(favoriteStorageKey.value) ?? "[]") as unknown;
    if (!Array.isArray(value)) return new Set();
    return new Set(
      value.filter(
        (item): item is string =>
          typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(item),
      ),
    );
  } catch {
    return new Set();
  }
}

function setCopyActionState(action: DetailCopyAction, state: DetailCopyState): void {
  const previousTimer = copyActionTimers.get(action);
  if (previousTimer) clearTimeout(previousTimer);
  copyActionStates.value = { ...copyActionStates.value, [action]: state };
  copyActionTimers.set(
    action,
    setTimeout(() => {
      copyActionTimers.delete(action);
      copyActionStates.value = { ...copyActionStates.value, [action]: "idle" };
    }, 2_500),
  );
}

function resetCopyActions(): void {
  for (const timer of copyActionTimers.values()) clearTimeout(timer);
  copyActionTimers.clear();
  copyActionStates.value = { name: "idle", link: "idle" };
}

function copyActionLabel(action: DetailCopyAction, idleLabel: string): string {
  if (copyActionStates.value[action] === "success") return "复制成功";
  if (copyActionStates.value[action] === "error") return "复制失败";
  return idleLabel;
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

/** 数据包只要求 Minecraft 版本精确匹配，不限制服务器核心或 Mod 加载器。 */
function compatibleServerResourceInstances(
  version: ServerModVersion,
  instances: readonly ServerInstanceSnapshot[],
): ServerInstanceSnapshot[] {
  return instances.filter(
    (instance) => !!instance.gameVersion && version.gameVersions.includes(instance.gameVersion),
  );
}

/** Markdown 链接只通过 Electron 的新窗口拦截器交给系统浏览器，避免替换当前 Renderer。 */
function openDetailMarkdownLink(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest("a[href]");
  if (!(link instanceof HTMLAnchorElement)) return;

  event.preventDefault();
  window.open(link.href, "_blank", "noopener,noreferrer");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section class="server-mod-download-page" :aria-label="`${resourceLabel}下载`">
    <template v-if="selectedProject">
      <div class="mod-detail-page">
        <button class="mod-detail-back" type="button" @click="returnToProjectList">
          <ArrowLeft :size="18" :stroke-width="1.9" aria-hidden="true" />
          返回{{ resourceLabel }}列表
        </button>

        <section class="mod-detail-summary" :aria-label="`${resourceLabel}项目信息`">
          <div class="mod-detail-summary-main">
            <span class="mod-project-icon mod-detail-icon">
              <img
                v-if="selectedProject.iconUrl && !projectIconFailed(selectedProject)"
                :src="selectedProject.iconUrl"
                alt=""
                draggable="false"
                referrerpolicy="no-referrer"
                @error="markProjectIconFailed(selectedProject.id)"
              />
              <component
                :is="resourceIcon"
                v-else
                :size="28"
                :stroke-width="1.7"
                aria-hidden="true"
              />
            </span>
            <div class="mod-detail-project-copy">
              <div class="mod-project-title-line mod-detail-title-line">
                <strong>{{ primaryProjectName(selectedProject) }}</strong>
                <template v-if="originalProjectName(selectedProject)">
                  <span class="mod-project-name-separator" aria-hidden="true">|</span>
                  <span class="mod-project-original-name">{{
                    originalProjectName(selectedProject)
                  }}</span>
                </template>
              </div>
              <div class="mod-detail-tags">
                <span
                  v-for="category in projectCategoryTags(selectedProject)"
                  :key="`detail-category:${category}`"
                  class="mod-category-tag"
                >
                  {{ category }}
                </span>
                <span
                  v-for="contentTag in projectContentTags(selectedProject)"
                  :key="`detail-content:${contentTag}`"
                  class="mod-content-tag"
                >
                  {{ contentTag }}
                </span>
              </div>
              <div class="mod-detail-meta">
                <span>
                  <UserRound :size="14" :stroke-width="1.8" aria-hidden="true" />
                  {{ selectedProject.author }}
                </span>
                <span>
                  <Box :size="14" :stroke-width="1.8" aria-hidden="true" />
                  {{ versionRange(selectedProject) }}
                </span>
                <span>
                  <Clock3 :size="14" :stroke-width="1.8" aria-hidden="true" />
                  {{ formatRelativeTime(selectedProject.dateModified) }}
                </span>
              </div>
            </div>
            <div
              class="mod-project-downloads mod-detail-downloads"
              :aria-label="`${selectedProject.downloads} 次下载`"
            >
              <Download :size="18" :stroke-width="1.9" aria-hidden="true" />
              <strong>{{ formatServerModDownloadCount(selectedProject.downloads) }}</strong>
            </div>
          </div>

          <div
            class="mod-detail-description-block"
            :class="{ expanded: detailDescriptionExpanded }"
          >
            <div class="mod-detail-description" @click="openDetailMarkdownLink">
              <Cmz_Markdown
                :content="detailDescription"
                variant="plain"
                :code-highlight="false"
                :features="detailMarkdownFeatures"
              />
            </div>
            <button
              class="mod-detail-description-toggle"
              type="button"
              :aria-expanded="detailDescriptionExpanded"
              @click="detailDescriptionExpanded = !detailDescriptionExpanded"
            >
              {{ detailDescriptionExpanded ? "收起简介" : "展开简介" }}
              <ChevronDown :size="15" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </div>

          <div class="mod-detail-actions" :aria-label="`${resourceLabel}项目操作`">
            <button
              class="mod-detail-action"
              :class="`copy-${copyActionStates.name}`"
              type="button"
              aria-live="polite"
              @click="copyProjectName"
            >
              <Check
                v-if="copyActionStates.name === 'success'"
                :size="15"
                :stroke-width="2"
                aria-hidden="true"
              />
              <X
                v-else-if="copyActionStates.name === 'error'"
                :size="15"
                :stroke-width="2"
                aria-hidden="true"
              />
              <Copy v-else :size="15" :stroke-width="1.8" aria-hidden="true" />
              {{ copyActionLabel("name", "复制名称") }}
            </button>
            <button
              class="mod-detail-action"
              :class="`copy-${copyActionStates.link}`"
              type="button"
              aria-live="polite"
              @click="copyProjectLink"
            >
              <Check
                v-if="copyActionStates.link === 'success'"
                :size="15"
                :stroke-width="2"
                aria-hidden="true"
              />
              <X
                v-else-if="copyActionStates.link === 'error'"
                :size="15"
                :stroke-width="2"
                aria-hidden="true"
              />
              <Link2 v-else :size="15" :stroke-width="1.8" aria-hidden="true" />
              {{ copyActionLabel("link", "复制链接") }}
            </button>
            <button
              class="mod-detail-action"
              :class="{ active: selectedProjectIsFavorite }"
              type="button"
              :aria-pressed="selectedProjectIsFavorite"
              @click="toggleFavorite"
            >
              <Heart
                :size="15"
                :stroke-width="1.8"
                :fill="selectedProjectIsFavorite ? 'currentColor' : 'none'"
                aria-hidden="true"
              />
              {{ selectedProjectIsFavorite ? "已收藏" : "收藏" }}
            </button>
          </div>
        </section>

        <div v-if="detailLoading" class="mod-detail-loading" role="status">
          <span class="mod-loading-spinner" />
          正在加载可下载版本
        </div>
        <div v-else-if="detailError" class="mod-result-state mod-detail-state" role="alert">
          <strong>无法加载可下载版本</strong>
          <span>{{ detailError }}</span>
          <button type="button" @click="loadProjectDetails">重新加载</button>
        </div>
        <template v-else>
          <div
            class="mod-filter-grid mod-detail-filter-grid"
            :class="{ 'single-filter': !showLoaderFilter }"
            :aria-label="`${resourceLabel}版本筛选`"
          >
            <label class="mod-filter-field">
              <span>版本</span>
              <Cmz_Select
                :model-value="detailGameVersion"
                :options="detailGameVersionOptions"
                :searchable="true"
                placeholder="全部版本"
                @update:model-value="updateDetailGameVersion"
              />
            </label>
            <label v-if="showLoaderFilter" class="mod-filter-field">
              <span>加载器</span>
              <Cmz_Select
                :model-value="detailLoader"
                :options="detailLoaderOptions"
                :searchable="true"
                placeholder="全部加载器"
                @update:model-value="updateDetailLoader"
              />
            </label>
          </div>

          <div v-if="detailVersionGroups.length === 0" class="mod-result-state mod-detail-state">
            <strong>没有符合筛选条件的版本</strong>
            <span>{{
              showLoaderFilter
                ? "尝试选择其他 Minecraft 版本或加载器。"
                : "尝试选择其他 Minecraft 版本。"
            }}</span>
          </div>
          <div v-else class="mod-version-groups">
            <article
              v-for="group in detailVersionGroups"
              :key="group.id"
              class="mod-version-group"
              :class="{ expanded: expandedVersionGroupId === group.id }"
            >
              <button
                class="mod-version-group-trigger"
                type="button"
                :aria-expanded="expandedVersionGroupId === group.id"
                @click="toggleVersionGroup(group.id)"
              >
                <strong>
                  <template v-if="showLoaderFilter">{{ loaderLabel(group.loader) }} </template
                  >{{ group.gameVersion }}
                </strong>
                <span>{{ group.versions.length }} 个文件</span>
                <ChevronDown :size="18" :stroke-width="1.8" aria-hidden="true" />
              </button>
              <div v-show="expandedVersionGroupId === group.id" class="mod-version-items">
                <button
                  v-for="version in group.versions"
                  :key="version.id"
                  class="mod-version-item"
                  type="button"
                  :disabled="!downloadEnabled"
                  :aria-label="
                    downloadEnabled
                      ? `下载 ${version.fileName}`
                      : `${version.fileName}，下载暂未开放`
                  "
                  @click="openInstallModal(version)"
                >
                  <span class="mod-project-icon mod-version-icon">
                    <img
                      v-if="selectedProject.iconUrl && !projectIconFailed(selectedProject)"
                      :src="selectedProject.iconUrl"
                      alt=""
                      draggable="false"
                      referrerpolicy="no-referrer"
                      @error="markProjectIconFailed(selectedProject.id)"
                    />
                    <component
                      :is="resourceIcon"
                      v-else
                      :size="16"
                      :stroke-width="1.7"
                      aria-hidden="true"
                    />
                  </span>
                  <strong>{{ version.fileName }}</strong>
                  <span class="mod-version-meta">
                    <Download :size="14" :stroke-width="1.8" aria-hidden="true" />
                    {{ formatServerModDownloadCount(version.downloads) }}
                  </span>
                  <span class="mod-version-meta">
                    <Clock3 :size="14" :stroke-width="1.8" aria-hidden="true" />
                    {{ formatRelativeTime(version.datePublished) }}
                  </span>
                </button>
              </div>
            </article>
          </div>
        </template>

        <Cmz_Modal
          v-if="downloadEnabled"
          :visible="installModalOpen && !!installVersion"
          title="安装数据包"
          width="520px"
          :close-on-overlay="!installPendingTarget"
          @close="closeInstallModal"
          @update:visible="updateInstallModalVisible"
        >
          <div v-if="installVersion" class="mod-install-modal">
            <div class="mod-install-file">
              <span class="mod-project-icon mod-version-icon">
                <img
                  v-if="selectedProject.iconUrl && !projectIconFailed(selectedProject)"
                  :src="selectedProject.iconUrl"
                  alt=""
                  draggable="false"
                  referrerpolicy="no-referrer"
                />
                <component
                  :is="resourceIcon"
                  v-else
                  :size="16"
                  :stroke-width="1.7"
                  aria-hidden="true"
                />
              </span>
              <div>
                <span>准备下载</span>
                <strong>{{ installVersion.fileName }}</strong>
              </div>
            </div>

            <template
              v-if="
                installInstancesLoading || !!installInstancesError || compatibleInstances.length > 0
              "
            >
              <h3>下载到</h3>
              <div class="mod-install-instance-list" aria-label="兼容的服务器实例">
                <div v-if="installInstancesLoading" class="mod-install-state" role="status">
                  <span class="mod-loading-spinner" />
                  正在读取服务器实例
                </div>
                <div v-else-if="installInstancesError" class="mod-install-state error" role="alert">
                  <span>{{ installInstancesError }}</span>
                  <button type="button" @click="openInstallModal(installVersion)">重新加载</button>
                </div>
                <template v-else>
                  <button
                    v-for="instance in compatibleInstances"
                    :key="instance.id"
                    class="mod-install-instance"
                    type="button"
                    :disabled="!!installPendingTarget"
                    @click="installModToInstance(instance)"
                  >
                    <span class="mod-install-instance-icon">
                      <img
                        v-if="instance.iconUrl"
                        :src="instance.iconUrl"
                        alt=""
                        draggable="false"
                      />
                      <span v-else>{{ instance.name.charAt(0).toUpperCase() }}</span>
                    </span>
                    <span class="mod-install-instance-copy">
                      <strong>{{ instance.name }}</strong>
                      <span>{{ instance.gameVersion }}</span>
                    </span>
                    <span
                      v-if="installPendingTarget === instance.id"
                      class="mod-loading-spinner"
                      aria-label="正在安装"
                    />
                  </button>
                </template>
              </div>

              <div class="mod-install-separator"><span>或</span></div>
            </template>
            <div v-if="installActionError" class="mod-install-feedback error" role="alert">
              {{ installActionError }}
            </div>
            <Cmz_Button
              class="mod-install-save-as"
              variant="outline"
              :loading="installPendingTarget === 'save-as'"
              :disabled="!!installPendingTarget"
              @click="saveModAs"
            >
              <Download :size="16" :stroke-width="1.8" aria-hidden="true" />
              另存为
            </Cmz_Button>
          </div>
        </Cmz_Modal>
      </div>
    </template>
    <template v-else>
      <div class="mod-search-field">
        <Search class="mod-search-icon" :size="19" :stroke-width="1.9" aria-hidden="true" />
        <Cmz_Input
          class="mod-search-control"
          :model-value="query"
          :maxlength="serverModSearchLimits.maximumQueryLength"
          :placeholder="`搜索${resourceLabel}名称或关键词`"
          :aria-label="`搜索${resourceLabel}`"
          @update:model-value="updateQuery"
        />
      </div>

      <div
        class="mod-filter-grid"
        :class="{ 'without-loader': !showLoaderFilter }"
        :aria-label="`${resourceLabel}搜索筛选`"
      >
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
        <label v-if="showLoaderFilter" class="mod-filter-field">
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

      <div v-if="initialLoading" class="mod-project-list" :aria-label="`正在加载${resourceLabel}`">
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
        <strong>无法加载{{ resourceLabel }}</strong>
        <span>{{ searchError }}</span>
        <button type="button" @click="resetSearch">重新搜索</button>
      </div>

      <div v-else-if="projects.length === 0" class="mod-result-state">
        <strong>没有找到符合条件的{{ resourceLabel }}</strong>
        <span>尝试减少筛选条件或更换搜索关键词。</span>
      </div>

      <div v-else class="mod-project-list" aria-live="polite">
        <button
          v-for="project in projects"
          :key="project.id"
          type="button"
          class="mod-project-row"
          @click="openProject(project)"
        >
          <span class="mod-project-icon">
            <img
              v-if="project.iconUrl && !projectIconFailed(project)"
              :src="project.iconUrl"
              alt=""
              draggable="false"
              referrerpolicy="no-referrer"
              @error="markProjectIconFailed(project.id)"
            />
            <component
              :is="resourceIcon"
              v-else
              :size="24"
              :stroke-width="1.7"
              aria-hidden="true"
            />
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
        </button>

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
    </template>
  </section>
</template>

<style scoped src="./ServerResourceDownloadPage.css"></style>
