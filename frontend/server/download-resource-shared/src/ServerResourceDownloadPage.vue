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
  type ServerModSource,
  type ServerModSourceClientService,
  type ServerModVersion,
} from "@seashard/contracts";
import minecraftDefaultServerIcon from "./assets/minecraft-default-server-icon.png";
import type { SelectOption } from "cmzya-modern-ui";
import DatapackWorldModal from "./components/DatapackWorldModal.vue";
import ResourceDetailLayout from "./components/ResourceDetailLayout.vue";
import ResourceFilterBar from "./components/ResourceFilterBar.vue";
import ResourceInstallModal from "./components/ResourceInstallModal.vue";
import ResourceProjectDetailHeader from "./components/ResourceProjectDetailHeader.vue";
import ResourceProjectDetailStatus from "./components/ResourceProjectDetailStatus.vue";
import ResourceProjectResults from "./components/ResourceProjectResults.vue";
import ResourceVersionFilters from "./components/ResourceVersionFilters.vue";
import ResourceVersionGroups from "./components/ResourceVersionGroups.vue";
import { Archive, Box, Package } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  compatibleServerResourceInstances,
  createServerModMixedSearchState,
  datapackPendingTarget,
  datapackWorldTargetsFromStorage,
  formatServerModDownloadCount,
  formatServerModRelativeTime,
  formatServerModVersionRange,
  groupServerModVersions,
  mergeAvailableServerModFilters,
  searchServerModMixedPage,
  serverModDisplayName,
  serverModDisplayTags,
  serverModSourceFilterOptions,
  serverModSourceLabel,
  serverModProjectUrl,
  type DatapackWorldTarget,
  type ServerModMixedSearchState,
  type ServerModSearchSource,
} from "./resource-presentation";
const props = defineProps<{
  resources: ServerModSourceClientService;
  instances?: ServerInstanceClientService;
  resourceType: "modpack" | "datapack" | "world";
}>();
const route = useRoute();
const router = useRouter();
const showLoaderFilter = computed(() => props.resourceType === "modpack");

const emptyFilters: ServerModFilters = {
  sources: serverModSourceFilterOptions,
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
const resourceLabel = computed(() =>
  props.resourceType === "modpack" ? "整合包" : props.resourceType === "world" ? "世界" : "数据包",
);
const resourceIcon = computed(() =>
  props.resourceType === "modpack" ? Package : props.resourceType === "world" ? Box : Archive,
);
const canInstallToInstance = computed(
  () =>
    (props.resourceType === "datapack" && !!props.instances) ||
    (props.resourceType === "world" && !!props.instances),
);
const downloadEnabled = computed(() => true);
const favoriteStorageKey = computed(() => `seashard.server-${props.resourceType}.favorites`);
const detailVersionCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
type DetailCopyAction = "name" | "link";
type DetailCopyState = "idle" | "success" | "error";

const filters = ref<ServerModFilters>(emptyFilters);
const filtersLoading = ref(true);
const filtersError = ref("");
const filtersWarning = ref("");
const query = ref("");
const source = ref<ServerModSearchSource>("all");
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
const searchWarning = ref("");
const failedIconIds = ref<ReadonlySet<string>>(new Set());
let queryTimer: ReturnType<typeof setTimeout> | undefined;
let searchGeneration = 0;
let mixedSearchState: ServerModMixedSearchState = createServerModMixedSearchState();
let filtersRequestId = 0;
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
const datapackWorldModalOpen = ref(false);
const datapackTargetInstance = ref<ServerInstanceSnapshot>();
const datapackWorldTargets = ref<readonly DatapackWorldTarget[]>([]);
const datapackWorldsByInstance = ref<ReadonlyMap<string, readonly DatapackWorldTarget[]>>(
  new Map(),
);
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
  relativeTimeTimer = setInterval(() => {
    relativeTimeNow.value = Date.now();
  }, 60_000);
  void loadFilters();
  if (routeProjectTarget()) initialLoading.value = false;
  else void resetSearch();
  favoriteProjectIds.value = readFavoriteProjectIds();
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
watch(
  () => [route.query.source, route.query.id],
  () => {
    void syncProjectRoute();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  searchGeneration += 1;
  filtersRequestId += 1;
  if (queryTimer) clearTimeout(queryTimer);
  if (relativeTimeTimer) clearInterval(relativeTimeTimer);
  detailRequestId += 1;
  resetCopyActions();
  installInstancesRequestId += 1;
});

async function loadFilters(): Promise<void> {
  const requestId = ++filtersRequestId;
  const requestedSource = source.value;
  filtersLoading.value = true;
  filtersError.value = "";
  filtersWarning.value = "";
  try {
    const next =
      requestedSource === "all"
        ? mergeAvailableServerModFilters(
            await Promise.allSettled(
              (["modrinth", "curseforge"] as const).map((sourceId) =>
                props.resources.getFilters(props.resourceType, sourceId),
              ),
            ),
          )
        : await props.resources.getFilters(props.resourceType, requestedSource);
    if (requestId !== filtersRequestId || requestedSource !== source.value) return;
    filters.value = { ...next, sources: serverModSourceFilterOptions };
    filtersWarning.value = next.unavailableReason ?? "";
  } catch (error) {
    if (requestId === filtersRequestId && requestedSource === source.value) {
      filtersWarning.value = "";
      filtersError.value = errorMessage(error);
    }
  } finally {
    if (requestId === filtersRequestId && requestedSource === source.value) {
      filtersLoading.value = false;
    }
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
  if (
    (value !== "all" && value !== "modrinth" && value !== "curseforge") ||
    source.value === value
  ) {
    return;
  }
  source.value = value;
  mixedSearchState = createServerModMixedSearchState();
  tag.value = "";
  gameVersion.value = "";
  loader.value = "";
  void loadFilters();
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
  mixedSearchState = createServerModMixedSearchState();
  projects.value = [];
  nextOffset.value = 0;
  total.value = 0;
  failedIconIds.value = new Set();
  searchError.value = "";
  searchWarning.value = "";
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
    const seen = new Set(projects.value.map((project) => `${project.source}:${project.id}`));
    projects.value = [
      ...projects.value,
      ...result.items.filter((project) => !seen.has(`${project.source}:${project.id}`)),
    ];
    total.value = result.total;
    nextOffset.value = result.offset + result.limit;
    if (result.unavailableReason) searchWarning.value = result.unavailableReason;
  } catch (error) {
    if (generation === searchGeneration) searchError.value = errorMessage(error);
  } finally {
    if (generation === searchGeneration) {
      loadingMore.value = false;
      await nextTick();
    }
  }
}

function retryNextPage(): void {
  searchError.value = "";
  void loadNextPage();
}
function searchPage(offset: number): Promise<ServerModSearchResult> {
  const request = {
    resourceType: props.resourceType,
    query: query.value,
    tag: tag.value,
    index: sort.value,
    gameVersion: gameVersion.value,
    loader: showLoaderFilter.value ? loader.value : "",
  };
  if (source.value === "all") {
    return searchServerModMixedPage(
      request,
      mixedSearchState,
      serverModSearchLimits.pageSize,
      (searchRequest) => props.resources.search(searchRequest),
    );
  }
  return props.resources.search({
    ...request,
    source: source.value,
    offset,
    limit: serverModSearchLimits.pageSize,
  });
}
function applyFirstPage(result: ServerModSearchResult): void {
  projects.value = result.items;
  total.value = result.total;
  nextOffset.value = result.offset + result.limit;
  searchWarning.value = result.unavailableReason ?? "";
}

/** 首屏不足一页高时继续补一页；每次完成后才判断，始终保持单个在途请求。 */

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
  const target = routeProjectTarget();
  if (!target || target.source !== project.source || target.id !== project.id) {
    await router.push({ query: { source: project.source, id: project.id } });
    return;
  }
  await selectProject(project);
}

async function selectProject(project: ServerModProject): Promise<void> {
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

async function syncProjectRoute(): Promise<void> {
  const target = routeProjectTarget();
  if (!target) {
    if (selectedProject.value) {
      clearProjectDetail();
      void resetSearch();
    }
    return;
  }
  if (
    selectedProject.value?.source === target.source &&
    selectedProject.value.id === target.id &&
    (detailLoading.value ||
      (projectDetails.value?.project.source === target.source &&
        projectDetails.value.project.id === target.id))
  ) {
    return;
  }

  const requestId = ++detailRequestId;
  selectedProject.value = createRouteProject(target);
  projectDetails.value = undefined;
  detailGameVersion.value = "";
  detailLoader.value = "";
  detailError.value = "";
  detailDescriptionExpanded.value = false;
  resetCopyActions();
  detailLoading.value = true;
  await nextTick();
  window.scrollTo({ top: 0 });
  try {
    const details = await props.resources.getProjectDetails(
      props.resourceType,
      target.source,
      target.id,
    );
    if (
      requestId === detailRequestId &&
      routeProjectTarget()?.source === target.source &&
      routeProjectTarget()?.id === target.id
    ) {
      selectedProject.value = details.project;
      projectDetails.value = details;
    }
  } catch (error) {
    if (requestId === detailRequestId) detailError.value = errorMessage(error);
  } finally {
    if (requestId === detailRequestId) detailLoading.value = false;
  }
}

function routeProjectTarget(): { source: ServerModSource; id: string } | undefined {
  const source = routeQueryValue(route.query.source);
  const id = routeQueryValue(route.query.id);
  if (
    (source !== "modrinth" && source !== "curseforge") ||
    !id ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id)
  ) {
    return undefined;
  }
  return { source, id };
}

function routeQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
}

function createRouteProject(target: { source: ServerModSource; id: string }): ServerModProject {
  return {
    resourceType: props.resourceType,
    source: target.source,
    id: target.id,
    slug: target.id,
    title: target.id,
    description: "",
    author: serverModSourceLabel(target.source),
    downloads: 0,
    follows: 0,
    dateModified: "1970-01-01T00:00:00.000Z",
    environment: ["server_only"],
    categories: [],
    versions: [],
  };
}

function clearProjectDetail(): void {
  detailRequestId += 1;
  selectedProject.value = undefined;
  projectDetails.value = undefined;
  detailLoading.value = false;
  detailError.value = "";
  detailGameVersion.value = "";
  detailLoader.value = "";
  expandedVersionGroupId.value = undefined;
  detailDescriptionExpanded.value = false;
}

function returnToProjectList(): void {
  clearProjectDetail();
  if (routeProjectTarget()) {
    void router.replace({ query: {} }).then(() => {
      void resetSearch();
    });
  }
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
      project.source,
      project.id,
    );
    if (
      requestId === detailRequestId &&
      selectedProject.value?.source === project.source &&
      selectedProject.value.id === project.id
    ) {
      selectedProject.value = details.project;
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
  if (!downloadEnabled.value) return;
  const requestId = ++installInstancesRequestId;
  installVersion.value = version;
  compatibleInstances.value = [];
  installInstancesLoading.value = false;
  installInstancesError.value = "";
  installActionError.value = "";
  installPendingTarget.value = undefined;
  datapackWorldModalOpen.value = false;
  datapackTargetInstance.value = undefined;
  datapackWorldTargets.value = [];
  datapackWorldsByInstance.value = new Map();
  installModalOpen.value = true;
  if (!canInstallToInstance.value || !props.instances) return;

  installInstancesLoading.value = true;
  try {
    const instances = await props.instances.list();
    if (requestId !== installInstancesRequestId) return;
    const candidates = compatibleServerResourceInstances(version, instances, props.resourceType);
    if (props.resourceType !== "datapack") {
      compatibleInstances.value = candidates;
      return;
    }

    const candidatesWithWorlds = await Promise.all(
      candidates.map(async (instance) => ({
        instance,
        worlds: datapackWorldTargetsFromStorage(
          await props.instances!.listWorldStorage(instance.id),
        ),
      })),
    );
    if (requestId !== installInstancesRequestId) return;
    datapackWorldsByInstance.value = new Map(
      candidatesWithWorlds.map(({ instance, worlds }) => [instance.id, worlds]),
    );
    compatibleInstances.value = candidatesWithWorlds
      .filter(({ worlds }) => worlds.length > 0)
      .map(({ instance }) => instance);
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
  datapackWorldModalOpen.value = false;
  installVersion.value = undefined;
  compatibleInstances.value = [];
  datapackTargetInstance.value = undefined;
  datapackWorldTargets.value = [];
  datapackWorldsByInstance.value = new Map();
  installInstancesError.value = "";
  installActionError.value = "";
}

function updateInstallModalVisible(visible: boolean): void {
  if (!visible) closeInstallModal();
}

function selectInstallInstance(instance: ServerInstanceSnapshot): void {
  if (props.resourceType !== "datapack") {
    void installResourceToInstance(instance);
    return;
  }
  const worlds = datapackWorldsByInstance.value.get(instance.id) ?? [];
  if (worlds.length === 0) {
    installActionError.value = "当前实例没有可用存档";
    return;
  }
  installActionError.value = "";
  datapackTargetInstance.value = instance;
  datapackWorldTargets.value = worlds;
  installModalOpen.value = false;
  datapackWorldModalOpen.value = true;
}

function backToInstallInstances(): void {
  if (installPendingTarget.value) return;
  datapackWorldModalOpen.value = false;
  datapackTargetInstance.value = undefined;
  datapackWorldTargets.value = [];
  installActionError.value = "";
  installModalOpen.value = true;
}

function closeDatapackWorldModal(): void {
  if (installPendingTarget.value) return;
  closeInstallModal();
}

function updateDatapackWorldModalVisible(visible: boolean): void {
  if (!visible) closeDatapackWorldModal();
}

async function installDatapackToWorld(target: DatapackWorldTarget): Promise<void> {
  const instance = datapackTargetInstance.value;
  if (!instance) return;
  await installResourceToInstance(instance, target.id);
}

async function installResourceToInstance(
  instance: ServerInstanceSnapshot,
  worldId?: string,
): Promise<void> {
  const project = selectedProject.value;
  const version = installVersion.value;
  if (!canInstallToInstance.value || !project || !version || installPendingTarget.value) return;
  if (props.resourceType === "datapack" && worldId === undefined) return;
  const pendingTarget =
    props.resourceType === "datapack" ? datapackPendingTarget(instance.id, worldId!) : instance.id;
  installPendingTarget.value = pendingTarget;
  installActionError.value = "";
  let completed = false;
  try {
    await props.resources.installToInstance({
      source: project.source,
      resourceType: props.resourceType === "world" ? "world" : "datapack",
      projectId: project.id,
      versionId: version.id,
      instanceId: instance.id,
      ...(props.resourceType === "datapack" ? { worldId } : {}),
    });
    completed = true;
  } catch (error) {
    installActionError.value = errorMessage(error);
  } finally {
    installPendingTarget.value = undefined;
    if (completed) {
      if (props.resourceType === "datapack") closeDatapackWorldModal();
      else closeInstallModal();
    }
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
        source: project.source,
        resourceType: props.resourceType,
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
  await copyDetailValue("link", serverModProjectUrl(project, props.resourceType));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section class="server-mod-download-page" :aria-label="`${resourceLabel}下载`">
    <template v-if="selectedProject">
      <ResourceDetailLayout :resource-label="resourceLabel" @back="returnToProjectList">
        <ResourceProjectDetailHeader
          :resource-label="resourceLabel"
          :project="selectedProject"
          :primary-name="primaryProjectName(selectedProject)"
          :original-name="originalProjectName(selectedProject)"
          :category-tags="projectCategoryTags(selectedProject)"
          :content-tags="projectContentTags(selectedProject)"
          :version-range="versionRange(selectedProject)"
          :relative-time="formatRelativeTime(selectedProject.dateModified)"
          :download-count="formatServerModDownloadCount(selectedProject.downloads)"
          :description="detailDescription"
          :description-expanded="detailDescriptionExpanded"
          :selected-is-favorite="selectedProjectIsFavorite"
          :copy-name-state="copyActionStates.name"
          :copy-link-state="copyActionStates.link"
          :copy-name-label="copyActionLabel('name', '复制名称')"
          :copy-link-label="copyActionLabel('link', '复制链接')"
          :resource-icon="resourceIcon"
          :icon-failed="projectIconFailed(selectedProject)"
          @icon-error="markProjectIconFailed"
          @toggle-description="detailDescriptionExpanded = !detailDescriptionExpanded"
          @copy-name="copyProjectName"
          @copy-link="copyProjectLink"
          @toggle-favorite="toggleFavorite"
        />

        <ResourceProjectDetailStatus
          :loading="detailLoading"
          :error="detailError"
          @retry="loadProjectDetails"
        />
        <template v-if="!detailLoading && !detailError">
          <ResourceVersionFilters
            :resource-label="resourceLabel"
            :show-loader-filter="showLoaderFilter"
            :game-version="detailGameVersion"
            :game-version-options="detailGameVersionOptions"
            :loader="detailLoader"
            :loader-options="detailLoaderOptions"
            @update:game-version="updateDetailGameVersion"
            @update:loader="updateDetailLoader"
          />

          <ResourceVersionGroups
            :groups="detailVersionGroups"
            :expanded-group-id="expandedVersionGroupId"
            :show-loader-filter="showLoaderFilter"
            :loader-label="loaderLabel"
            :selected-project-icon-url="selectedProject.iconUrl"
            :icon-failed="projectIconFailed(selectedProject)"
            :resource-icon="resourceIcon"
            :download-enabled="downloadEnabled"
            :format-download-count="formatServerModDownloadCount"
            :format-relative-time="formatRelativeTime"
            @toggle-group="toggleVersionGroup"
            @select-version="openInstallModal"
            @icon-error="markProjectIconFailed(selectedProject.id)"
          />
        </template>

        <ResourceInstallModal
          v-if="downloadEnabled"
          :visible="installModalOpen && !!installVersion"
          :resource-label="resourceLabel"
          :resource-type="props.resourceType"
          :version="installVersion"
          :resource-icon="resourceIcon"
          :project-icon-url="selectedProject.iconUrl"
          :icon-failed="projectIconFailed(selectedProject)"
          :can-install-to-instance="canInstallToInstance"
          :instances="compatibleInstances"
          :loading="installInstancesLoading"
          :error="installInstancesError"
          :pending-target="installPendingTarget"
          :action-error="installActionError"
          @close="closeInstallModal"
          @update:visible="updateInstallModalVisible"
          @reload="installVersion && openInstallModal(installVersion)"
          @select-instance="selectInstallInstance"
          @save-as="saveModAs"
        />
        <DatapackWorldModal
          v-if="downloadEnabled"
          :visible="datapackWorldModalOpen && !!installVersion && !!datapackTargetInstance"
          :version="installVersion"
          :target-instance="datapackTargetInstance"
          :world-targets="datapackWorldTargets"
          :resource-icon="resourceIcon"
          :project-icon-url="selectedProject.iconUrl"
          :icon-failed="projectIconFailed(selectedProject)"
          :default-world-icon="minecraftDefaultServerIcon"
          :pending-target="installPendingTarget"
          :action-error="installActionError"
          @close="closeDatapackWorldModal"
          @update:visible="updateDatapackWorldModalVisible"
          @back="backToInstallInstances"
          @select-world="installDatapackToWorld"
        />
      </ResourceDetailLayout>
    </template>
    <template v-else>
      <ResourceFilterBar
        :resource-label="resourceLabel"
        :query="query"
        :maximum-query-length="serverModSearchLimits.maximumQueryLength"
        :source="source"
        :source-options="sourceOptions"
        :tag="tag"
        :tag-options="tagOptions"
        :sort="sort"
        :sort-options="sortOptions"
        :game-version="gameVersion"
        :version-options="versionOptions"
        :loader="loader"
        :loader-options="loaderOptions"
        :show-loader-filter="showLoaderFilter"
        :filters-loading="filtersLoading"
        :filters-warning="filtersWarning"
        :filters-error="filtersError"
        @update:query="updateQuery"
        @update:source="updateSource"
        @update:tag="updateTag"
        @update:sort="updateSort"
        @update:game-version="updateGameVersion"
        @update:loader="updateLoader"
        @retry-filters="loadFilters"
      />

      <ResourceProjectResults
        :resource-label="resourceLabel"
        :result-summary="resultSummary"
        :projects="projects"
        :initial-loading="initialLoading"
        :loading-more="loadingMore"
        :search-error="searchError"
        :source-warning="searchWarning"
        :has-more="hasMore"
        :resource-icon="resourceIcon"
        :primary-name="primaryProjectName"
        :original-name="originalProjectName"
        :content-tags="projectContentTags"
        :category-tags="projectCategoryTags"
        :source-label="serverModSourceLabel"
        :version-range="versionRange"
        :relative-time="formatRelativeTime"
        :download-count="formatServerModDownloadCount"
        :icon-failed="projectIconFailed"
        @open-project="openProject"
        @icon-error="markProjectIconFailed"
        @retry-search="resetSearch"
        @retry-next-page="retryNextPage"
        @load-more="loadNextPage"
      />
    </template>
  </section>
</template>

<style src="./ServerResourceDownloadPage.css"></style>
