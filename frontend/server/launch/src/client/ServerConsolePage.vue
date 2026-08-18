<script setup lang="ts">
import type { ServerInstanceClientService, ServerInstanceSnapshot } from "@seashard/contracts";
import { Cmz_Button, Cmz_Console, type ConsoleLine } from "cmzya-modern-ui";
import { Server } from "lucide-vue-next";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

const props = defineProps<{
  instances: ServerInstanceClientService;
}>();

const route = useRoute();
const router = useRouter();
const registeredInstances = ref<readonly ServerInstanceSnapshot[]>([]);
const selectedInstanceId = ref<string>();
const loading = ref(true);
const instancesError = ref<string>();
const consoleLines = ref<ConsoleLine[]>([]);
const commandHistory = ref<string[]>([]);

const selectedInstance = computed(() =>
  registeredInstances.value.find((instance) => instance.id === selectedInstanceId.value),
);
const hasConsoleOutput = computed(() => consoleLines.value.length > 0);
const quickCommands = [
  { label: "白天", command: "time set day" },
  { label: "夜晚", command: "time set night" },
  { label: "晴天", command: "weather clear" },
  { label: "下雨", command: "weather rain" },
  { label: "保存世界", command: "save-all" },
  { label: "在线玩家", command: "list" },
  { label: "TPS", command: "tps" },
] as const;

onMounted(() => void loadInstances());

/** 控制台只读取已有实例投影；本轮不创建日志、命令或进程状态的伪数据。 */
async function loadInstances(): Promise<void> {
  loading.value = true;
  try {
    const instances = await props.instances.list();
    registeredInstances.value = instances;
    const requestedId = typeof route.query.instance === "string" ? route.query.instance : undefined;
    selectedInstanceId.value =
      instances.find((instance) => instance.id === requestedId)?.id ?? instances[0]?.id;
    instancesError.value = undefined;
  } catch (error) {
    instancesError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

function openLaunchPage(): void {
  const instanceId = selectedInstance.value?.id;
  void router.push({
    path: "/server/launch",
    ...(instanceId ? { query: { instance: instanceId } } : {}),
  });
}

function clearLogs(): void {
  consoleLines.value = [];
}

/** 后端命令通道尚未接入时明确反馈“未发送”，避免前端把本地回显伪装成执行成功。 */
function handleCommand(value: string): void {
  const command = value.trim();
  if (!command) return;
  commandHistory.value = [...commandHistory.value, command].slice(-500);
  consoleLines.value = [
    ...consoleLines.value,
    { text: `> ${command}`, type: "input" },
    { text: "[SeaShard] 控制台后端尚未接入，命令未发送。", type: "warning" },
  ];
}

function exportLogs(): void {
  if (!hasConsoleOutput.value) return;
  const content = consoleLines.value.map((line) => line.text).join("\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `console-${selectedInstance.value?.id ?? "server"}.log`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <section class="server-console-page animate-stagger-in" aria-label="服务器控制台">
    <div class="console-toolbar">
      <div class="toolbar-left">
        <span class="server-name-display">
          {{ selectedInstance?.name ?? (loading ? "正在读取服务器" : "未选择服务器") }}
        </span>
        <!-- 按产品边界不在控制台展示服务器运行状态，状态后续由独立位置负责。 -->
      </div>

      <div class="toolbar-right">
        <div class="action-group primary-actions">
          <Cmz_Button size="sm" :disabled="!selectedInstance" @click="openLaunchPage">
            启动服务器
          </Cmz_Button>
        </div>
        <div class="action-group secondary-actions">
          <Cmz_Button variant="outline" size="sm" :disabled="!hasConsoleOutput" @click="exportLogs">
            导出日志
          </Cmz_Button>
          <Cmz_Button variant="ghost" size="sm" :disabled="!hasConsoleOutput" @click="clearLogs">
            清空日志
          </Cmz_Button>
          <Cmz_Button variant="ghost" size="sm" disabled title="日志分享将在控制台后端接入后启用">
            分享日志
          </Cmz_Button>
        </div>
      </div>
    </div>

    <div v-if="instancesError" class="console-empty-state" role="alert">
      <span class="empty-icon"><Server :size="30" :stroke-width="1.6" /></span>
      <strong>无法读取服务器实例</strong>
      <span>{{ instancesError }}</span>
      <Cmz_Button variant="outline" size="sm" @click="loadInstances">重新加载</Cmz_Button>
    </div>

    <div v-else-if="!loading && !selectedInstance" class="console-empty-state" role="status">
      <span class="empty-icon"><Server :size="30" :stroke-width="1.6" /></span>
      <strong>还没有服务器实例</strong>
      <span>从下载页面获取服务器核心后，控制台会在这里显示对应实例。</span>
    </div>

    <template v-else>
      <div class="quick-commands" aria-label="快捷命令">
        <span class="quick-label">快捷命令</span>
        <div class="quick-groups">
          <button
            v-for="item in quickCommands"
            :key="item.command"
            type="button"
            class="quick-button"
            :title="item.command"
            @click="handleCommand(item.command)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>

      <div class="console-terminal-shell">
        <Cmz_Console
          class="console-output"
          :lines="consoleLines"
          :show-timestamps="true"
          :auto-scroll="true"
          :max-lines="5_000"
          :history="commandHistory"
          placeholder="输入服务器命令，按 Enter 发送"
          height="100%"
          @command="handleCommand"
        />
      </div>
    </template>
  </section>
</template>

<style scoped src="./ServerConsolePage.css"></style>
