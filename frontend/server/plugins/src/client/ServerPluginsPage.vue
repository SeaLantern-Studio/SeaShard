<script setup lang="ts">
import type {
  ServerInstalledPluginSnapshot,
  ServerInstanceClientService,
  ServerInstanceSnapshot,
} from "@seashard/contracts";
import type { ServerInstanceSelection } from "@seashard/server-ui-shared/server-selection";
import { Cmz_Button, Cmz_Modal, Cmz_Spinner, useToast } from "cmzya-modern-ui";
import { Ban, Check, Plug, RefreshCw, Trash2 } from "lucide-vue-next";
import { computed, onMounted, ref, watch } from "vue";

const props = defineProps<{
  instances: ServerInstanceClientService;
  selection: ServerInstanceSelection;
}>();
const toast = useToast();
const registeredInstances = ref<readonly ServerInstanceSnapshot[]>([]);
const plugins = ref<readonly ServerInstalledPluginSnapshot[]>([]);
const loading = ref(false);
const pendingPath = ref<string>();
const deleteTarget = ref<ServerInstalledPluginSnapshot>();
const selectedInstanceId = computed(() => props.selection.instanceId);

onMounted(() => void loadInstances());
watch(selectedInstanceId, () => void loadPlugins());

async function loadInstances(): Promise<void> {
  loading.value = true;
  try {
    registeredInstances.value = await props.instances.list();
    if (!registeredInstances.value.some(({ id }) => id === props.selection.instanceId)) {
      props.selection.instanceId = registeredInstances.value[0]?.id;
    }
    await loadPlugins();
  } catch (error) {
    toast.error({ title: "读取插件失败", description: errorMessage(error) });
  } finally {
    loading.value = false;
  }
}

async function loadPlugins(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) {
    plugins.value = [];
    return;
  }
  loading.value = true;
  try {
    plugins.value = await props.instances.listPlugins(instanceId);
  } catch (error) {
    toast.error({ title: "读取插件失败", description: errorMessage(error) });
  } finally {
    loading.value = false;
  }
}

async function togglePlugin(plugin: ServerInstalledPluginSnapshot): Promise<void> {
  if (pendingPath.value) return;
  pendingPath.value = plugin.relativePath;
  try {
    const updated = await props.instances.setPluginDisabled(
      plugin.instanceId,
      plugin.relativePath,
      !plugin.disabled,
    );
    plugins.value = plugins.value.map((candidate) =>
      candidate.relativePath === plugin.relativePath ? updated : candidate,
    );
    toast.success({ title: plugin.disabled ? "插件已启用" : "插件已禁用" });
  } catch (error) {
    toast.error({ title: "修改插件失败", description: errorMessage(error) });
  } finally {
    pendingPath.value = undefined;
  }
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (!target || pendingPath.value) return;
  pendingPath.value = target.relativePath;
  try {
    await props.instances.deletePlugin(target.instanceId, target.relativePath);
    plugins.value = plugins.value.filter(
      ({ relativePath }) => relativePath !== target.relativePath,
    );
    deleteTarget.value = undefined;
    toast.success({ title: "插件已删除" });
  } catch (error) {
    toast.error({ title: "删除插件失败", description: errorMessage(error) });
  } finally {
    pendingPath.value = undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section class="server-plugins-page">
    <header class="page-heading"><h1>插件</h1></header>
    <div class="plugins-toolbar">
      <select v-model="selection.instanceId" aria-label="服务器实例">
        <option v-for="instance in registeredInstances" :key="instance.id" :value="instance.id">
          {{ instance.name }}
        </option>
      </select>
      <Cmz_Button variant="outline" size="sm" :disabled="loading" @click="loadPlugins">
        <RefreshCw :size="15" /> 刷新
      </Cmz_Button>
    </div>

    <Cmz_Spinner v-if="loading" />
    <div v-else-if="plugins.length" class="plugin-list">
      <article v-for="plugin in plugins" :key="plugin.relativePath" class="plugin-row">
        <span class="plugin-icon"><Plug :size="18" /></span>
        <div class="plugin-identity">
          <strong>{{ plugin.name }}</strong>
          <code>{{ plugin.fileName }}</code>
        </div>
        <span class="plugin-state" :class="{ disabled: plugin.disabled }">
          <Ban v-if="plugin.disabled" :size="13" />
          <Check v-else :size="13" />
          {{ plugin.disabled ? "已禁用" : "已启用" }}
        </span>
        <Cmz_Button
          variant="outline"
          size="sm"
          :loading="pendingPath === plugin.relativePath"
          @click="togglePlugin(plugin)"
        >
          {{ plugin.disabled ? "启用" : "禁用" }}
        </Cmz_Button>
        <button
          type="button"
          class="delete-button"
          aria-label="删除插件"
          @click="deleteTarget = plugin"
        >
          <Trash2 :size="16" />
        </button>
      </article>
    </div>
    <div v-else class="empty-state"><Plug :size="30" /><span>当前实例没有服务端插件</span></div>

    <Cmz_Modal
      :visible="Boolean(deleteTarget)"
      title="删除插件"
      width="440px"
      @close="deleteTarget = undefined"
    >
      <p>确认删除“{{ deleteTarget?.fileName }}”？此操作只删除插件 JAR。</p>
      <template #footer>
        <div class="modal-actions">
          <Cmz_Button variant="outline" @click="deleteTarget = undefined">取消</Cmz_Button>
          <Cmz_Button color="#ef4444" @click="confirmDelete">删除</Cmz_Button>
        </div>
      </template>
    </Cmz_Modal>
  </section>
</template>

<style scoped src="./ServerPluginsPage.css"></style>
