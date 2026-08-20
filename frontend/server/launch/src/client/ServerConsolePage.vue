<script setup lang="ts">
import { isServerRuntimeSupportedType } from "@seashard/contracts";
import type {
  ServerConsoleLine,
  ServerInstanceClientService,
  ServerInstanceSnapshot,
  ServerRuntimeClientService,
  ServerRuntimeSnapshot,
} from "@seashard/contracts";
import { Cmz_Button, Cmz_Console, type ConsoleLine } from "cmzya-modern-ui";
import { Server } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ServerInstanceSelection } from "./server-selection";
import MissingJavaModal from "./MissingJavaModal.vue";
import { isMissingJavaRuntimeError, runtimeErrorMessage } from "./runtime-error";
import { BoundedSequenceStore } from "./console-buffer";

const maximumConsoleLines = 5_000;

const props = defineProps<{
  instances: ServerInstanceClientService;
  runtime: ServerRuntimeClientService;
  selection: ServerInstanceSelection;
}>();

const registeredInstances = ref<readonly ServerInstanceSnapshot[]>([]);
const selectedInstanceId = computed(() => props.selection.instanceId);
const loading = ref(true);
const instancesError = ref<string>();
const consoleLines = ref<ConsoleLine[]>([]);
const commandHistory = ref<string[]>([]);
const runtimeSnapshot = ref<ServerRuntimeSnapshot>();
const startingServer = ref(false);
const missingJavaModalOpen = ref(false);
const missingJavaMessage = ref("");
const serverLinesBySequence = new BoundedSequenceStore<ServerConsoleLine>(maximumConsoleLines);
let localLines: Array<{ line: ConsoleLine; timestamp: string }> = [];
let consoleRequestId = 0;
let runtimeRefreshTimer: ReturnType<typeof setInterval> | undefined;
let disposeConsoleSubscription: (() => void) | undefined;

const selectedInstance = computed(() =>
  registeredInstances.value.find((instance) => instance.id === selectedInstanceId.value),
);
const hasConsoleOutput = computed(() => consoleLines.value.length > 0);
const startButtonLabel = computed(() => {
  if (!isServerRuntimeSupportedType(selectedInstance.value?.serverType)) return "暂不支持此核心";
  if (startingServer.value || runtimeSnapshot.value?.state === "starting") return "正在启动";
  if (runtimeSnapshot.value?.state === "running") return "服务器已启动";
  if (runtimeSnapshot.value?.state === "stopping") return "正在停止";
  return "启动服务器";
});
const startButtonDisabled = computed(
  () =>
    !selectedInstance.value ||
    !isServerRuntimeSupportedType(selectedInstance.value.serverType) ||
    startingServer.value ||
    runtimeSnapshot.value?.state === "starting" ||
    runtimeSnapshot.value?.state === "running" ||
    runtimeSnapshot.value?.state === "stopping",
);
const quickCommands = [
  { label: "白天", command: "time set day" },
  { label: "夜晚", command: "time set night" },
  { label: "晴天", command: "weather clear" },
  { label: "下雨", command: "weather rain" },
  { label: "保存世界", command: "save-all" },
  { label: "在线玩家", command: "list" },
  { label: "TPS", command: "tps" },
] as const;

onMounted(() => {
  // 先订阅再补拉历史，sequence 去重可覆盖订阅建立与 IPC 请求之间的日志缺口。
  disposeConsoleSubscription = props.runtime.onConsoleLine(handleServerConsoleLine);
  void loadInstances();
  runtimeRefreshTimer = setInterval(() => void refreshRuntime(), 2_000);
});

onBeforeUnmount(() => {
  disposeConsoleSubscription?.();
  clearInterval(runtimeRefreshTimer);
});

watch(
  () => props.selection.instanceId,
  (instanceId, previousInstanceId) => {
    if (instanceId === previousInstanceId || loading.value) return;
    resetConsole();
    runtimeSnapshot.value = undefined;
    if (!registeredInstances.value.some((instance) => instance.id === instanceId)) {
      void loadInstances();
      return;
    }
    void Promise.all([loadConsoleLines(), refreshRuntime()]);
  },
);

/** 控制台只读取实例元数据中已经声明的核心类型，不在启动阶段识别核心。 */
async function loadInstances(): Promise<void> {
  loading.value = true;
  try {
    const instances = await props.instances.list();
    registeredInstances.value = instances;
    const selectedId = instances.some((instance) => instance.id === props.selection.instanceId)
      ? props.selection.instanceId
      : instances[0]?.id;
    props.selection.instanceId = selectedId;
    instancesError.value = undefined;
    resetConsole();
    await Promise.all([loadConsoleLines(), refreshRuntime()]);
  } catch (error) {
    instancesError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

async function refreshRuntime(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) {
    runtimeSnapshot.value = undefined;
    return;
  }
  try {
    runtimeSnapshot.value = await props.runtime.get(instanceId);
  } catch {
    // 实时日志和命令错误会给出可见反馈；轮询失败不覆盖实例读取错误。
  }
}

async function loadConsoleLines(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId) return;
  const requestId = ++consoleRequestId;
  try {
    const lines = await props.runtime.getLogs(instanceId, 0);
    if (requestId !== consoleRequestId || selectedInstanceId.value !== instanceId) return;
    for (const line of lines) collectServerLine(line);
    rebuildConsoleLines();
  } catch (error) {
    if (requestId === consoleRequestId) {
      appendLocalLine("error", `[SeaShard] 无法读取控制台历史：${errorMessage(error)}`);
    }
  }
}

async function startSelectedServer(): Promise<void> {
  const instance = selectedInstance.value;
  if (
    !instance ||
    !isServerRuntimeSupportedType(instance.serverType) ||
    startButtonDisabled.value
  ) {
    return;
  }
  startingServer.value = true;
  try {
    runtimeSnapshot.value = await props.runtime.start(instance.id);
  } catch (error) {
    const message = runtimeErrorMessage(error);
    if (isMissingJavaRuntimeError(message)) {
      missingJavaMessage.value = message;
      missingJavaModalOpen.value = true;
    } else {
      appendLocalLine("error", `[SeaShard] 启动请求失败：${message}`);
    }
    await refreshRuntime();
  } finally {
    startingServer.value = false;
  }
}

function clearLogs(): void {
  consoleRequestId += 1;
  serverLinesBySequence.clear();
  localLines = [];
  consoleLines.value = [];
}

/** 命令成功后的输入回显由 Host 统一产生，避免 Renderer 把未发送的命令显示成成功。 */
async function handleCommand(value: string): Promise<void> {
  const command = value.trim();
  const instanceId = selectedInstanceId.value;
  if (!command || !instanceId) return;
  commandHistory.value = [...commandHistory.value, command].slice(-500);
  try {
    await props.runtime.sendCommand(instanceId, command);
  } catch {
    const snapshot = await props.runtime.get(instanceId).catch(() => undefined);
    if (snapshot) runtimeSnapshot.value = snapshot;
    appendLocalLine("error", `[SeaShard] 命令未发送：${commandFailureMessage(snapshot)}`);
  }
}

/** IPC 的底层英文异常不直接暴露给用户，按真实进程状态给出下一步操作。 */
function commandFailureMessage(snapshot: ServerRuntimeSnapshot | undefined): string {
  if (snapshot?.state === "stopped") return "服务器已停止，请先启动服务器。";
  if (snapshot?.state === "starting") return "服务器正在启动，暂时无法接收命令，请稍后再试。";
  if (snapshot?.state === "stopping") return "服务器正在停止，无法再接收命令。";
  if (snapshot?.state === "failed") return "服务器进程已异常退出，请先重新启动服务器。";
  return "服务器控制台暂时无法接收命令，请稍后重试。";
}

function handleServerConsoleLine(line: ServerConsoleLine): void {
  if (!collectServerLine(line)) return;
  consoleLines.value.push(toConsoleLine(line));
  if (consoleLines.value.length > maximumConsoleLines) {
    consoleLines.value.splice(0, consoleLines.value.length - maximumConsoleLines);
  }
}

function collectServerLine(line: ServerConsoleLine): boolean {
  return line.instanceId === selectedInstanceId.value && serverLinesBySequence.add(line);
}

function rebuildConsoleLines(): void {
  const merged = [
    ...serverLinesBySequence.values().map((line) => ({
      line: toConsoleLine(line),
      timestamp: line.timestamp,
      order: line.sequence,
    })),
    ...localLines.map((entry, index) => ({ ...entry, order: Number.MAX_SAFE_INTEGER - index })),
  ].sort(
    (left, right) =>
      left.timestamp.localeCompare(right.timestamp) || Number(left.order) - Number(right.order),
  );
  consoleLines.value = merged.slice(-maximumConsoleLines).map((entry) => entry.line);
}

function appendLocalLine(type: NonNullable<ConsoleLine["type"]>, text: string): void {
  const timestamp = new Date().toISOString();
  const line: ConsoleLine = { text, type, timestamp: displayTimestamp(timestamp) };
  localLines.push({ line, timestamp });
  if (localLines.length > maximumConsoleLines) {
    localLines.splice(0, localLines.length - maximumConsoleLines);
  }
  consoleLines.value.push(line);
  if (consoleLines.value.length > maximumConsoleLines) {
    consoleLines.value.splice(0, consoleLines.value.length - maximumConsoleLines);
  }
}

function toConsoleLine(line: ServerConsoleLine): ConsoleLine {
  return {
    text: line.text,
    type: consoleLineType(line),
    timestamp: displayTimestamp(line.timestamp),
  };
}

function consoleLineType(line: ServerConsoleLine): NonNullable<ConsoleLine["type"]> {
  if (line.stream === "stderr") return "error";
  if (line.stream === "input") return "input";
  if (line.stream === "system") return "system";
  if (/\b(?:ERROR|FATAL|SEVERE)\b/iu.test(line.text)) return "error";
  if (/\bWARN(?:ING)?\b/iu.test(line.text)) return "warning";
  if (/\bINFO\b/iu.test(line.text)) return "info";
  return "output";
}

function displayTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function resetConsole(): void {
  consoleRequestId += 1;
  serverLinesBySequence.clear();
  localLines = [];
  consoleLines.value = [];
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
          <Cmz_Button
            size="sm"
            :disabled="startButtonDisabled"
            :title="
              selectedInstance && !isServerRuntimeSupportedType(selectedInstance.serverType)
                ? '当前核心尚未接入启动策略'
                : undefined
            "
            @click="startSelectedServer"
          >
            {{ startButtonLabel }}
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
    <MissingJavaModal v-model:visible="missingJavaModalOpen" :message="missingJavaMessage" />
  </section>
</template>

<style scoped src="./ServerConsolePage.css"></style>
