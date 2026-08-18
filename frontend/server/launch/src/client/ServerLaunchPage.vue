<script setup lang="ts">
import { Check, ImagePlus, Play, Power, Rows3, Settings2 } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";

interface PreviewServerInstance {
  readonly id: string;
  readonly name: string;
  readonly mark: string;
  readonly hue: number;
}

const previewInstances: readonly PreviewServerInstance[] = [
  { id: "paper-main", name: "Paper 生存服务器", mark: "P", hue: 204 },
  { id: "fabric-create", name: "Fabric 创造服务器", mark: "F", hue: 267 },
  { id: "purpur-lobby", name: "Purpur 大厅服务器", mark: "P", hue: 325 },
  { id: "velocity-group", name: "Velocity 群组代理", mark: "V", hue: 24 },
];

const pageRoot = ref<HTMLElement>();
const iconInput = ref<HTMLInputElement>();
const selectedInstanceId = ref(previewInstances[0].id);
const selectorOpen = ref(false);
const runningInstanceIds = reactive(new Set<string>(["fabric-create", "velocity-group"]));
const customIconSources = reactive(new Map<string, string>());
const iconMenu = reactive({ open: false, x: 0, y: 0 });

const selectedInstance = computed(
  () =>
    previewInstances.find((instance) => instance.id === selectedInstanceId.value) ??
    previewInstances[0],
);
const selectedIconSource = computed(() => customIconSources.get(selectedInstance.value.id));
const selectedServerActive = computed(() => runningInstanceIds.has(selectedInstance.value.id));
const primaryLabel = computed(() => (selectedServerActive.value ? "停止服务器" : "启动服务器"));
const primaryIcon = computed(() => (selectedServerActive.value ? Power : Play));
const sortedInstances = computed(() =>
  [...previewInstances].sort(
    (left, right) =>
      Number(runningInstanceIds.has(right.id)) - Number(runningInstanceIds.has(left.id)),
  ),
);

onMounted(() => {
  document.addEventListener("pointerdown", closeIconMenu);
  document.addEventListener("keydown", handleDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeIconMenu);
  document.removeEventListener("keydown", handleDocumentKeydown);
});

function toggleServer(): void {
  const instanceId = selectedInstance.value.id;
  if (runningInstanceIds.has(instanceId)) runningInstanceIds.delete(instanceId);
  else runningInstanceIds.add(instanceId);
}

function toggleSelector(): void {
  selectorOpen.value = !selectorOpen.value;
  iconMenu.open = false;
}

function selectInstance(instanceId: string): void {
  selectedInstanceId.value = instanceId;
  iconMenu.open = false;
}

/** 菜单坐标限制在页面内部，图标移动到左半区后右键菜单仍从指针位置出现。 */
function openIconMenu(event: MouseEvent): void {
  const root = pageRoot.value;
  if (!root) return;
  const bounds = root.getBoundingClientRect();
  const menuWidth = 148;
  const menuHeight = 42;
  iconMenu.x = clamp(event.clientX - bounds.left, 8, bounds.width - menuWidth - 8);
  iconMenu.y = clamp(event.clientY - bounds.top, 8, bounds.height - menuHeight - 8);
  iconMenu.open = true;
}

function openIconMenuFromKeyboard(): void {
  const root = pageRoot.value;
  const icon = root?.querySelector<HTMLElement>(".instance-icon-button");
  if (!root || !icon) return;
  const rootBounds = root.getBoundingClientRect();
  const iconBounds = icon.getBoundingClientRect();
  iconMenu.x = iconBounds.right - rootBounds.left - 24;
  iconMenu.y = iconBounds.bottom - rootBounds.top - 8;
  iconMenu.open = true;
}

function closeIconMenu(): void {
  iconMenu.open = false;
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    iconMenu.open = false;
    selectorOpen.value = false;
  }
}

function chooseCustomIcon(): void {
  iconMenu.open = false;
  iconInput.value?.click();
}

/** 预览阶段使用 CSP 允许的 data URL；后续接入实例组件时再交由 Host 持久化。 */
async function applyCustomIcon(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !file.type.startsWith("image/")) return;

  const instanceId = selectedInstance.value.id;
  input.value = "";
  const source = await readImageFile(file).catch(() => undefined);
  if (source) customIconSources.set(instanceId, source);
}

function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("custom server icon did not produce an image URL"));
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function instanceStyle(instance: PreviewServerInstance): Record<string, string> {
  return { "--instance-hue": String(instance.hue) };
}

function isInstanceRunning(instanceId: string): boolean {
  return runningInstanceIds.has(instanceId);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
</script>

<template>
  <section
    ref="pageRoot"
    class="server-launch-page"
    :class="{ 'selector-open': selectorOpen }"
    aria-label="服务器启动"
  >
    <div class="launch-focus-area">
      <button
        type="button"
        class="instance-icon-button"
        aria-label="服务器核心图标，右键修改图标"
        aria-haspopup="menu"
        @contextmenu.prevent.stop="openIconMenu"
        @keydown.shift.f10.prevent="openIconMenuFromKeyboard"
      >
        <span
          class="instance-icon-visual instance-icon-large"
          :style="instanceStyle(selectedInstance)"
        >
          <img v-if="selectedIconSource" :src="selectedIconSource" alt="" draggable="false" />
          <span v-else>{{ selectedInstance.mark }}</span>
        </span>
      </button>

      <div class="launch-actions">
        <button
          type="button"
          class="primary-launch-button"
          :class="{ 'is-stop': selectedServerActive }"
          @click="toggleServer"
        >
          <component :is="primaryIcon" :size="18" :stroke-width="2" />
          <span>{{ primaryLabel }}</span>
        </button>

        <div class="secondary-actions">
          <button type="button" class="secondary-launch-button">
            <Settings2 :size="16" :stroke-width="1.8" />
            <span>实例设置</span>
          </button>
          <button
            type="button"
            class="secondary-launch-button"
            :class="{ active: selectorOpen }"
            :aria-pressed="selectorOpen"
            @click="toggleSelector"
          >
            <Rows3 :size="16" :stroke-width="1.8" />
            <span>实例选择</span>
          </button>
        </div>
      </div>
    </div>

    <aside
      class="instance-selector-panel"
      aria-label="选择实例"
      :aria-hidden="!selectorOpen"
      :inert="!selectorOpen"
    >
      <TransitionGroup
        name="instance-order"
        tag="div"
        class="instance-list"
        role="listbox"
        aria-label="服务器实例"
      >
        <button
          v-for="instance in sortedInstances"
          :key="instance.id"
          type="button"
          class="instance-list-row"
          :class="{ selected: selectedInstanceId === instance.id }"
          role="option"
          :aria-selected="selectedInstanceId === instance.id"
          @click="selectInstance(instance.id)"
        >
          <span class="instance-icon-visual instance-icon-small" :style="instanceStyle(instance)">
            <img
              v-if="customIconSources.get(instance.id)"
              :src="customIconSources.get(instance.id)"
              alt=""
              draggable="false"
            />
            <span v-else>{{ instance.mark }}</span>
          </span>
          <span class="instance-row-name">{{ instance.name }}</span>
          <span
            v-if="isInstanceRunning(instance.id) || selectedInstanceId === instance.id"
            class="instance-row-meta"
          >
            <span v-if="isInstanceRunning(instance.id)" class="instance-running-state">
              <span class="instance-running-dot" aria-hidden="true"></span>
              运行中
            </span>
            <Check
              v-if="selectedInstanceId === instance.id"
              class="instance-selected-check"
              :size="17"
              :stroke-width="2.2"
            />
          </span>
        </button>
      </TransitionGroup>
    </aside>

    <div
      v-if="iconMenu.open"
      class="icon-context-menu"
      role="menu"
      :style="{ left: `${iconMenu.x}px`, top: `${iconMenu.y}px` }"
      @pointerdown.stop
    >
      <button type="button" role="menuitem" @click="chooseCustomIcon">
        <ImagePlus :size="16" :stroke-width="1.8" />
        <span>修改图标</span>
      </button>
    </div>

    <input
      ref="iconInput"
      class="visually-hidden-icon-input"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      aria-hidden="true"
      tabindex="-1"
      @change="applyCustomIcon"
    />
  </section>
</template>

<style scoped src="./ServerLaunchPage.css"></style>
