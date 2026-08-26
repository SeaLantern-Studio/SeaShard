<script setup lang="ts">
import { ClientUiSlotEntry, useClientUiRuntime } from "@seashard/ui-runtime";
import type { SettingsNavigationGroup } from "@seashard/ui-sdk";
import {
  Archive,
  ArrowLeft,
  Bot,
  Download,
  FileCog,
  Image,
  LayoutDashboard,
  Package,
  Play,
  Puzzle,
  Settings,
  Terminal,
  Upload,
} from "lucide-vue-next";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import logoSvg from "./assets/logo.svg";
import type { SettingsMode, WorkspaceMode } from "./workspace-layout";

const props = defineProps<{
  workspace: WorkspaceMode;
  settingsMode?: SettingsMode;
  downloadMode: boolean;
}>();

const runtime = useClientUiRuntime();
const router = useRouter();
const route = useRoute();
const sidebarNav = ref<HTMLElement>();
const navIndicator = ref<HTMLElement>();
const lastWorkspacePath = ref("/");
const settingsPages = computed(() =>
  runtime.pages.value.filter((page) => page.navigation !== false && page.placement === "settings"),
);
const agentSettingsPages = computed(() =>
  runtime.pages.value.filter(
    (page) => page.navigation !== false && page.placement === "agent-settings",
  ),
);
const serverNavigationPages = computed(() =>
  runtime.pages.value.filter((page) => page.navigation !== false && page.placement === "server"),
);
const workspaceSidebar = computed(() =>
  runtime.workspaceSidebars.value.find((sidebar) => sidebar.workspaceId === props.workspace),
);
const settingsNavigationGroups = [
  { id: "game", label: "游戏设置" },
  { id: "server", label: "服务器设置" },
  { id: "launcher", label: "启动器设置" },
  { id: "software", label: "软件设置" },
] as const satisfies readonly { id: SettingsNavigationGroup; label: string }[];
const groupedSettingsPages = computed(() =>
  settingsNavigationGroups.map((group) => ({
    ...group,
    pages: settingsPages.value.filter((page) => (page.settingsGroup ?? "software") === group.id),
  })),
);
const downloadPages = computed(() =>
  runtime.pages.value.filter(
    (page) => page.navigation !== false && page.placement === "server-download",
  ),
);
const serverCoreDownloadPage = computed(() =>
  downloadPages.value.find((page) => page.path === "/server/download"),
);
const otherDownloadPages = computed(() =>
  downloadPages.value.filter((page) => page.path !== "/server/download"),
);
const sidebarLabel = computed(() => {
  if (props.settingsMode === "general") return "设置导航";
  if (props.settingsMode === "agent") return "Agent 设置导航";
  if (props.downloadMode) return "下载导航";
  return "主导航";
});
const sidebarMenuKey = computed(() => {
  if (props.settingsMode) return `settings:${props.settingsMode}`;
  if (props.downloadMode) return "server-download";
  return `workspace:${props.workspace}`;
});
const settingsEntryPath = computed(() => settingsPages.value[0]?.path);
const agentSettingsPath = computed(() => agentSettingsPages.value[0]?.path);
const instancePrimaryItems = [
  { id: "launch", label: "启动", icon: Play },
  { id: "download", label: "下载", icon: Download },
] as const;
const launcherManagementItems = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "settings", label: "设置", icon: Settings },
  { id: "export", label: "导出", icon: Upload },
  { id: "saves", label: "存档", icon: Archive },
  { id: "screenshots", label: "截图", icon: Image },
  { id: "mods", label: "Mod", icon: Puzzle },
  { id: "resource-packs", label: "资源包", icon: Package },
] as const;
const serverManagementItems = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "console", label: "控制台", icon: Terminal },
  { id: "configuration", label: "配置管理", icon: FileCog },
  { id: "settings", label: "设置", icon: Settings },
  { id: "export", label: "导出", icon: Upload },
  { id: "saves", label: "存档", icon: Archive },
  { id: "mods", label: "Mod", icon: Puzzle },
] as const;
type InstanceItemId =
  | (typeof instancePrimaryItems)[number]["id"]
  | (typeof launcherManagementItems)[number]["id"]
  | (typeof serverManagementItems)[number]["id"];
const activeLauncherItem = ref<InstanceItemId>("launch");
const activeServerItem = ref<InstanceItemId | undefined>("launch");
const activeInstanceItem = computed(() =>
  props.workspace === "server" ? activeServerItem.value : activeLauncherItem.value,
);
const instanceManagementItems = computed(() =>
  props.workspace === "server" ? serverManagementItems : launcherManagementItems,
);
const instanceWorkspaceLabel = computed(() => (props.workspace === "server" ? "服务器" : "启动器"));
let indicatorFrame: number | undefined;
let sidebarMenuEntering = false;
const sidebarMenuItemSelector = [
  ".workspace-action",
  ".workspace-section-title",
  ".workspace-row",
  ".nav-item",
  ".instance-section-divider",
  ".settings-section-divider",
].join(",");

function navigate(path: string): void {
  void router.push(path);
}

function matchesRoute(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function isActive(path: string): boolean {
  return matchesRoute(route.path, path);
}
function isDownloadPageActive(path: string): boolean {
  return route.path === path;
}

function openSettings(): void {
  const path = settingsEntryPath.value;
  if (path) navigate(path);
}
function openAgentSettings(): void {
  const path = agentSettingsPath.value;
  if (path) navigate(path);
}

function leaveSettings(): void {
  if (props.settingsMode === "agent") {
    navigate("/agent/chat");
    return;
  }
  navigate(lastWorkspacePath.value);
}
function leaveDownload(): void {
  activeServerItem.value = "launch";
  navigate("/server/launch");
}

function serverItemForPath(path: string): InstanceItemId | undefined {
  if (matchesRoute(path, "/server/download")) return "download";
  if (matchesRoute(path, "/server/overview")) return "overview";
  if (matchesRoute(path, "/server/console")) return "console";
  if (matchesRoute(path, "/server/configuration")) return "configuration";
  if (matchesRoute(path, "/server/settings")) return "settings";
  if (matchesRoute(path, "/server/saves")) return "saves";
  if (matchesRoute(path, "/server/mods")) return "mods";
  return path.startsWith("/server/") ? undefined : "launch";
}

function selectInstanceItem(id: InstanceItemId): void {
  if (props.workspace === "server") {
    activeServerItem.value = id;
    if (id === "download") {
      navigate("/server/download");
    } else if (id === "launch") {
      navigate("/server/launch");
    } else if (id === "overview") {
      navigate("/server/overview");
    } else if (id === "console") {
      navigate("/server/console");
    } else if (id === "configuration") {
      navigate("/server/configuration");
    } else if (id === "settings") {
      navigate("/server/settings");
    } else if (id === "saves") {
      navigate("/server/saves");
    } else if (id === "mods") {
      navigate("/server/mods");
    } else if (route.path.startsWith("/server/")) {
      navigate("/");
    }
  } else if (props.workspace === "launcher") {
    activeLauncherItem.value = id;
  }
}

function hideNavIndicatorForMenuSwap(): void {
  const indicator = navIndicator.value;
  if (!indicator) return;
  indicator.style.transition = "none";
  indicator.style.opacity = "0";
}

/** 为新菜单按真实 DOM 顺序写入波浪延迟，避免各分组重新从零开始。 */
function prepareSidebarMenuEnter(element: Element): void {
  sidebarMenuEntering = true;
  hideNavIndicatorForMenuSwap();
  const items = element.querySelectorAll<HTMLElement>(sidebarMenuItemSelector);
  items.forEach((item, index) => {
    item.classList.add("sidebar-menu-enter-item");
    item.style.setProperty("--sidebar-enter-index", String(index));
  });
}

/** 离场没有补间；先隐藏指示条，旧菜单会由 Transition 同步移除。 */
function prepareSidebarMenuLeave(): void {
  sidebarMenuEntering = true;
  hideNavIndicatorForMenuSwap();
}

function finishSidebarMenuEnter(): void {
  navIndicator.value?.style.removeProperty("transition");
  sidebarMenuEntering = false;
  void nextTick(() => {
    updateNavIndicator();
  });
}

function updateNavIndicator(): void {
  if (indicatorFrame !== undefined) cancelAnimationFrame(indicatorFrame);
  indicatorFrame = requestAnimationFrame(() => {
    indicatorFrame = undefined;
    const nav = sidebarNav.value;
    const indicator = navIndicator.value;
    if (!nav || !indicator) return;
    if (sidebarMenuEntering) {
      indicator.style.opacity = "0";
      return;
    }
    const item = nav.querySelector<HTMLElement>(".nav-item.active");
    if (!item) {
      indicator.style.opacity = "0";
      return;
    }
    const itemRect = item.getBoundingClientRect();
    indicator.style.opacity = "1";
    const navRect = nav.getBoundingClientRect();
    const top = itemRect.top - navRect.top + (itemRect.height - 16) / 2;
    indicator.style.top = `${top}px`;
  });
}

watch(
  () => route.fullPath,
  (path) => {
    if (!path.startsWith("/settings/") && !path.startsWith("/agent/settings")) {
      lastWorkspacePath.value = path;
    }
    activeServerItem.value = serverItemForPath(path);
  },
  { immediate: true },
);

watch(
  [
    () => route.path,
    () => props.workspace,
    settingsPages,
    agentSettingsPages,
    downloadPages,
    serverNavigationPages,
    activeInstanceItem,
  ],
  () => void nextTick(updateNavIndicator),
  {
    flush: "post",
  },
);

onMounted(() => {
  updateNavIndicator();
  window.addEventListener("resize", updateNavIndicator);
});

onUnmounted(() => {
  if (indicatorFrame !== undefined) cancelAnimationFrame(indicatorFrame);
  window.removeEventListener("resize", updateNavIndicator);
});
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-logo" @click="navigate('/')">
      <div class="logo-icon">
        <img :src="logoSvg" width="28" height="28" alt="SeaShard" draggable="false" />
      </div>
      <span class="logo-text">SeaShard</span>
    </div>

    <nav ref="sidebarNav" class="sidebar-nav" :aria-label="sidebarLabel">
      <div ref="navIndicator" class="nav-active-indicator"></div>

      <Transition
        name="sidebar-menu"
        mode="out-in"
        @before-leave="prepareSidebarMenuLeave"
        @before-enter="prepareSidebarMenuEnter"
        @after-enter="finishSidebarMenuEnter"
      >
        <div :key="sidebarMenuKey" class="sidebar-menu-stage">
          <div v-if="props.settingsMode === 'general'" class="settings-mode-nav">
            <button type="button" class="workspace-row mode-back" @click="leaveSettings">
              <ArrowLeft :size="16" :stroke-width="1.8" />
              <span>返回工作区</span>
            </button>

            <template v-for="(group, groupIndex) in groupedSettingsPages" :key="group.id">
              <div v-if="groupIndex > 0" class="settings-section-divider" role="separator"></div>
              <section class="settings-section" :aria-labelledby="`settings-${group.id}-label`">
                <h3 :id="`settings-${group.id}-label`" class="workspace-section-title">
                  <span class="workspace-section-title-text">{{ group.label }}</span>
                </h3>
                <button
                  v-for="page in group.pages"
                  :key="page.id"
                  type="button"
                  class="nav-item settings-nav-item"
                  :class="{ active: isActive(page.path) }"
                  :aria-current="isActive(page.path) ? 'page' : undefined"
                  @click="navigate(page.path)"
                >
                  <component
                    :is="page.icon"
                    v-if="page.icon"
                    class="nav-icon"
                    :size="19"
                    :stroke-width="1.8"
                  />
                  <span class="nav-label">{{ page.label }}</span>
                </button>
              </section>
            </template>
          </div>
          <div v-else-if="props.settingsMode === 'agent'" class="settings-mode-nav">
            <button type="button" class="workspace-row mode-back" @click="leaveSettings">
              <ArrowLeft :size="16" :stroke-width="1.8" />
              <span>返回 Agent</span>
            </button>

            <section class="settings-section" aria-labelledby="agent-settings-label">
              <h3 id="agent-settings-label" class="workspace-section-title">
                <span class="workspace-section-title-text">Agent 设置</span>
              </h3>
              <button
                v-for="page in agentSettingsPages"
                :key="page.id"
                type="button"
                class="nav-item settings-nav-item"
                :class="{ active: isActive(page.path) }"
                :aria-current="isActive(page.path) ? 'page' : undefined"
                @click="navigate(page.path)"
              >
                <component
                  :is="page.icon"
                  v-if="page.icon"
                  class="nav-icon"
                  :size="19"
                  :stroke-width="1.8"
                />
                <span class="nav-label">{{ page.label }}</span>
              </button>
            </section>
          </div>

          <div v-else-if="props.downloadMode" class="download-mode-nav">
            <button type="button" class="workspace-row mode-back" @click="leaveDownload">
              <ArrowLeft :size="16" :stroke-width="1.8" />
              <span>返回服务器</span>
            </button>

            <section class="download-section" aria-labelledby="download-label">
              <h3 id="download-label" class="workspace-section-title">
                <span class="workspace-section-title-text">下载</span>
              </h3>
              <button
                v-if="serverCoreDownloadPage"
                type="button"
                class="nav-item download-nav-item"
                :class="{ active: isDownloadPageActive(serverCoreDownloadPage.path) }"
                :aria-current="
                  isDownloadPageActive(serverCoreDownloadPage.path) ? 'page' : undefined
                "
                @click="navigate(serverCoreDownloadPage.path)"
              >
                <component
                  :is="serverCoreDownloadPage.icon"
                  v-if="serverCoreDownloadPage.icon"
                  class="nav-icon"
                  :size="19"
                  :stroke-width="1.8"
                />
                <span class="nav-label">{{ serverCoreDownloadPage.label }}</span>
              </button>
            </section>

            <section class="download-section" aria-labelledby="other-resources-label">
              <h3 id="other-resources-label" class="workspace-section-title">
                <span class="workspace-section-title-text">其他资源</span>
              </h3>
              <button
                v-for="page in otherDownloadPages"
                :key="page.id"
                type="button"
                class="nav-item download-nav-item"
                :class="{ active: isDownloadPageActive(page.path) }"
                :aria-current="isDownloadPageActive(page.path) ? 'page' : undefined"
                @click="navigate(page.path)"
              >
                <component
                  :is="page.icon"
                  v-if="page.icon"
                  class="nav-icon"
                  :size="19"
                  :stroke-width="1.8"
                />
                <span class="nav-label">{{ page.label }}</span>
              </button>
            </section>
          </div>

          <ClientUiSlotEntry
            v-else-if="workspaceSidebar"
            :entry-token="workspaceSidebar.entryToken"
          />

          <div
            v-else-if="props.workspace === 'server' || props.workspace === 'launcher'"
            class="instance-workspace-nav"
          >
            <div class="instance-nav-group" :aria-label="`${instanceWorkspaceLabel}主要操作`">
              <button
                v-for="item in instancePrimaryItems"
                :key="item.id"
                type="button"
                class="nav-item instance-nav-item instance-primary-item"
                :class="{ active: activeInstanceItem === item.id }"
                :aria-current="activeInstanceItem === item.id ? 'page' : undefined"
                @click="selectInstanceItem(item.id)"
              >
                <component :is="item.icon" class="nav-icon" :size="20" :stroke-width="1.8" />
                <span class="nav-label">{{ item.label }}</span>
              </button>
            </div>

            <div class="instance-section-divider" role="separator"></div>

            <div class="instance-nav-group" :aria-label="`${instanceWorkspaceLabel}管理`">
              <button
                v-for="item in instanceManagementItems"
                :key="item.id"
                type="button"
                class="nav-item instance-nav-item"
                :class="{ active: activeInstanceItem === item.id }"
                :aria-current="activeInstanceItem === item.id ? 'page' : undefined"
                @click="selectInstanceItem(item.id)"
              >
                <component :is="item.icon" class="nav-icon" :size="20" :stroke-width="1.8" />
                <span class="nav-label">{{ item.label }}</span>
              </button>
              <template v-if="props.workspace === 'server'">
                <button
                  v-for="page in serverNavigationPages"
                  :key="page.id"
                  type="button"
                  class="nav-item instance-nav-item"
                  :class="{ active: isActive(page.path) }"
                  :aria-current="isActive(page.path) ? 'page' : undefined"
                  @click="navigate(page.path)"
                >
                  <component
                    :is="page.icon"
                    v-if="page.icon"
                    class="nav-icon"
                    :size="20"
                    :stroke-width="1.8"
                  />
                  <span class="nav-label">{{ page.label }}</span>
                </button>
              </template>
            </div>
          </div>

          <div v-if="!props.settingsMode && !props.downloadMode" class="nav-group lower-side">
            <button
              v-if="props.workspace === 'agent'"
              type="button"
              class="nav-item"
              :class="{ active: agentSettingsPath && isActive(agentSettingsPath) }"
              :disabled="!agentSettingsPath"
              :aria-current="agentSettingsPath && isActive(agentSettingsPath) ? 'page' : undefined"
              @click="openAgentSettings"
            >
              <Bot class="nav-icon" :size="20" :stroke-width="1.8" />
              <span class="nav-label">Agent 设置</span>
            </button>
            <button
              type="button"
              class="nav-item"
              :disabled="!settingsEntryPath"
              @click="openSettings"
            >
              <Settings class="nav-icon" :size="20" :stroke-width="1.8" />
              <span class="nav-label">设置</span>
            </button>
          </div>
        </div>
      </Transition>
    </nav>
  </aside>
</template>
