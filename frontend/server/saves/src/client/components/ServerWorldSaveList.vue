<script setup lang="ts">
import type {
  ServerWorldDimensionGroup,
  ServerWorldSave,
  ServerWorldStorageSnapshot,
} from "@seashard/contracts";
import { Cmz_Button, Cmz_Spinner } from "cmzya-modern-ui";
import { Archive, ChevronDown, Info, Plus, Search, Server } from "lucide-vue-next";
import { computed } from "vue";
import minecraftDefaultServerIcon from "../assets/minecraft-default-server-icon.png";
import { formatWorldSaveDate, formatWorldSaveDimension } from "../world-save-format";

const props = defineProps<{
  storage?: ServerWorldStorageSnapshot;
  searchQuery: string;
  switchingId?: string;
  canAdd: boolean;
  expandedGroups: ReadonlySet<string>;
  loading: boolean;
  error?: string;
  hasInstance: boolean;
}>();

const emit = defineEmits<{
  "update:searchQuery": [value: string];
  "add-save": [];
  retry: [];
  "switch-world": [worldId: string, worldName: string];
  "toggle-group": [groupId: string];
  "open-details": [worldId: string, worldName: string];
}>();

const query = computed({
  get: () => props.searchQuery,
  set: (value: string) => emit("update:searchQuery", value),
});
const visibleSaves = computed<readonly ServerWorldSave[]>(() => {
  const normalizedQuery = props.searchQuery.trim().toLocaleLowerCase();
  const saves = props.storage?.saves ?? [];
  if (!normalizedQuery) return saves;
  return saves.filter((save) =>
    `${save.name} ${save.id}`.toLocaleLowerCase().includes(normalizedQuery),
  );
});
const visibleGroups = computed<readonly ServerWorldDimensionGroup[]>(() => {
  const groups = props.storage?.dimensions ?? [];
  const normalizedQuery = props.searchQuery.trim().toLocaleLowerCase();
  if (!normalizedQuery) return groups;
  return groups.filter((group) => {
    const groupText = `${group.name} ${group.id} ${group.saves.map((save) => save.name).join(" ")}`;
    return groupText.toLocaleLowerCase().includes(normalizedQuery);
  });
});

function isExpanded(groupId: string): boolean {
  return props.expandedGroups.has(groupId);
}

function addSave(): void {
  emit("add-save");
}

function retry(): void {
  emit("retry");
}

function switchWorld(worldId: string, worldName: string): void {
  emit("switch-world", worldId, worldName);
}

function toggleGroup(groupId: string): void {
  emit("toggle-group", groupId);
}

function openDetails(worldId: string, worldName: string): void {
  emit("open-details", worldId, worldName);
}
</script>

<template>
  <div class="world-save-list-toolbar">
    <div class="world-save-search">
      <Search :size="17" :stroke-width="1.8" />
      <input v-model="query" type="search" placeholder="搜索存档" aria-label="搜索存档" />
    </div>
    <Cmz_Button
      variant="outline"
      size="sm"
      class="world-save-add-button"
      :disabled="!canAdd"
      @click="addSave"
    >
      <Plus :size="16" :stroke-width="1.8" />
      添加
    </Cmz_Button>
  </div>

  <div v-if="loading" class="world-save-state" role="status">
    <Cmz_Spinner size="lg" />
    <span>正在读取存档</span>
  </div>
  <div v-else-if="error" class="world-save-state world-save-state--error" role="alert">
    <Archive :size="34" :stroke-width="1.5" />
    <strong>无法读取存档</strong>
    <span>{{ error }}</span>
    <Cmz_Button variant="outline" size="sm" @click="retry">重新加载</Cmz_Button>
  </div>
  <div v-else-if="!hasInstance" class="world-save-state">
    <Server :size="36" :stroke-width="1.5" />
    <strong>还没有服务器实例</strong>
  </div>

  <template v-else>
    <div v-if="storage?.mode === 'unified'" class="world-save-content">
      <div class="world-save-section-heading">
        <h2>普通存档</h2>
        <span>{{ visibleSaves.length }} 个存档</span>
      </div>
      <div v-if="visibleSaves.length === 0" class="world-save-empty">
        <Archive :size="30" :stroke-width="1.5" />
        <strong>{{ searchQuery ? "没有匹配的存档" : "暂未发现存档" }}</strong>
      </div>
      <div v-else class="world-save-grid" aria-label="普通存档列表">
        <article
          v-for="save in visibleSaves"
          :key="save.id"
          class="world-save-card"
          :class="{ current: save.current, switching: switchingId === save.id }"
        >
          <button
            type="button"
            class="world-save-card-main"
            :disabled="Boolean(switchingId)"
            @click="switchWorld(save.id, save.name)"
          >
            <span class="world-save-icon">
              <img v-if="save.iconDataUrl" :src="save.iconDataUrl" alt="" draggable="false" />
              <img v-else :src="minecraftDefaultServerIcon" alt="" draggable="false" />
            </span>
            <span class="world-save-card-copy">
              <strong>{{ save.name }}</strong>
              <span class="world-save-meta">
                <span>{{ save.id }}</span>
                <small
                  >创建 {{ formatWorldSaveDate(save.createdAt) }}　更新
                  {{ formatWorldSaveDate(save.updatedAt) }}</small
                >
              </span>
            </span>
          </button>
          <span v-if="save.current" class="world-save-current-label">当前</span>
          <span class="world-save-info-anchor">
            <button
              type="button"
              class="world-save-info-button"
              aria-label="查看存档详情"
              @click="openDetails(save.id, save.name)"
            >
              <Info :size="17" :stroke-width="1.8" />
            </button>
          </span>
        </article>
      </div>
    </div>
    <div v-else class="world-save-content">
      <div class="world-save-section-heading">
        <h2>分维度存档</h2>
        <span>{{ visibleGroups.length }} 组存档</span>
      </div>
      <div v-if="visibleGroups.length === 0" class="world-save-empty">
        <Archive :size="30" :stroke-width="1.5" />
        <strong>{{ searchQuery ? "没有匹配的存档" : "暂未发现存档" }}</strong>
      </div>
      <div v-else class="world-save-groups" aria-label="分维度存档列表">
        <article
          v-for="group in visibleGroups"
          :key="group.id"
          class="world-save-group"
          :class="{ current: group.current }"
        >
          <button
            type="button"
            class="world-save-group-trigger"
            :aria-expanded="isExpanded(group.id)"
            @click="toggleGroup(group.id)"
          >
            <span class="world-save-group-icon"><Archive :size="19" :stroke-width="1.7" /></span>
            <span class="world-save-group-copy"
              ><strong>{{ group.name }}</strong
              ><span>{{ group.saves.length }} 个维度</span></span
            >
            <ChevronDown
              class="world-save-chevron"
              :class="{ expanded: isExpanded(group.id) }"
              :size="18"
              :stroke-width="1.8"
            />
          </button>
          <div v-if="isExpanded(group.id)" class="world-save-dimension-list">
            <div v-for="save in group.saves" :key="save.id" class="world-save-dimension-row">
              <button
                type="button"
                class="world-save-card-main"
                :disabled="Boolean(switchingId)"
                @click="switchWorld(group.id, group.name)"
              >
                <span class="world-save-icon world-save-icon--small">
                  <img v-if="save.iconDataUrl" :src="save.iconDataUrl" alt="" draggable="false" />
                  <img v-else :src="minecraftDefaultServerIcon" alt="" draggable="false" />
                </span>
                <span class="world-save-card-copy">
                  <strong>{{ formatWorldSaveDimension(save.dimension) }}</strong>
                  <span class="world-save-meta">
                    <span>{{ save.id }}</span>
                    <small
                      >创建 {{ formatWorldSaveDate(save.createdAt) }}　更新
                      {{ formatWorldSaveDate(save.updatedAt) }}</small
                    >
                  </span>
                </span>
              </button>
              <span v-if="group.current" class="world-save-current-label">当前</span>
              <span class="world-save-info-anchor">
                <button
                  type="button"
                  class="world-save-info-button"
                  aria-label="查看存档详情"
                  @click.stop="openDetails(group.id, group.name)"
                >
                  <Info :size="17" :stroke-width="1.8" />
                </button>
              </span>
            </div>
          </div>
        </article>
      </div>
    </div>
  </template>
</template>

<style scoped src="./world-save-shared.css"></style>
<style scoped src="./ServerWorldSaveList.css"></style>
