<script setup lang="ts">
import type {
  ServerWebApiError,
  ServerWebBootstrapSnapshot,
  ServerWebEvent,
  ServerWebInstanceSnapshot,
  ServerWebStateSnapshot,
  ServerWebTaskAccepted,
  ServerWebTaskKind,
} from "@seashard/server-web-api";
import type { ServerConsoleLine } from "@seashard/contracts";
import { Cmz_Button, useToast } from "cmzya-modern-ui";
import {
  Activity,
  LogOut,
  Play,
  RefreshCw,
  RotateCw,
  Server,
  ShieldCheck,
  Square,
  Terminal,
} from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import "./ServerWebDashboardPage.css";

const toast = useToast();
const emit = defineEmits<{
  authenticated: [value: boolean];
}>();
const bootstrap = ref<ServerWebBootstrapSnapshot>();
const state = ref<ServerWebStateSnapshot>();
const username = ref("admin");
const password = ref("");
const authBusy = ref(false);
const selectedInstanceId = ref<string>();
const consoleLines = ref<ServerConsoleLine[]>([]);
const command = ref("");
const eventConnected = ref(false);
const loading = ref(true);
const consoleElement = ref<HTMLElement>();
let events: EventSource | undefined;
let lastConsoleSequence = 0;

const selectedInstance = computed(() =>
  state.value?.instances.find(({ id }) => id === selectedInstanceId.value),
);
const latestTasks = computed(() => state.value?.tasks.slice(0, 8) ?? []);
const selectedTask = computed(() =>
  state.value?.tasks.find(
    ({ instanceId, state: taskState }) =>
      instanceId === selectedInstanceId.value && taskState === "running",
  ),
);
const canWriteHost = computed(() =>
  Boolean(state.value?.host.connected && state.value.host.hasControl),
);
const runtimeAction = computed(() => {
  const runtimeState = selectedInstance.value?.runtime.state;
  return runtimeState === "running" || runtimeState === "starting" ? "stop" : "start";
});

onMounted(() => void loadBootstrap());
onBeforeUnmount(closeEvents);

watch(selectedInstanceId, () => void loadConsoleHistory());

async function loadBootstrap(): Promise<void> {
  loading.value = true;
  try {
    bootstrap.value = await request<ServerWebBootstrapSnapshot>("/api/bootstrap");
    if (bootstrap.value.authenticated) {
      emit("authenticated", true);
      await refreshState();
      connectEvents();
    }
  } catch (error) {
    notifyError("读取 Server 状态失败", error);
  } finally {
    loading.value = false;
  }
}

async function authenticate(): Promise<void> {
  if (authBusy.value) return;
  authBusy.value = true;
  try {
    const setupRequired = bootstrap.value?.setupRequired ?? true;
    bootstrap.value = await request<ServerWebBootstrapSnapshot>(
      setupRequired ? "/api/setup" : "/api/login",
      {
        method: "POST",
        body: JSON.stringify({ username: username.value, password: password.value }),
      },
    );
    password.value = "";
    emit("authenticated", true);
    await refreshState();
    connectEvents();
  } catch (error) {
    notifyError(bootstrap.value?.setupRequired ? "管理员设置失败" : "登录失败", error);
  } finally {
    authBusy.value = false;
  }
}

async function logout(): Promise<void> {
  try {
    await request("/api/logout", { method: "POST", body: "{}" });
  } catch (error) {
    notifyError("退出登录失败", error);
    return;
  }
  closeEvents();
  state.value = undefined;
  consoleLines.value = [];
  bootstrap.value = {
    apiVersion: 1,
    setupRequired: false,
    authenticated: false,
  };
  emit("authenticated", false);
}

async function refreshState(): Promise<void> {
  try {
    acceptState(await request<ServerWebStateSnapshot>("/api/state"));
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      closeEvents();
      bootstrap.value = { apiVersion: 1, setupRequired: false, authenticated: false };
      emit("authenticated", false);
      return;
    }
    notifyError("刷新服务器状态失败", error);
  }
}

function connectEvents(): void {
  closeEvents();
  const source = new EventSource("/api/events");
  events = source;
  source.onopen = () => {
    eventConnected.value = true;
    // EventSource 自动重连后重新读取快照和日志，以 sequence 去重填补断线窗口。
    void refreshState().then(() => loadConsoleHistory());
  };
  source.onerror = () => {
    eventConnected.value = false;
  };
  source.addEventListener("state", (event) => acceptEvent(event));
  source.addEventListener("task", (event) => acceptEvent(event));
  source.addEventListener("console-line", (event) => acceptEvent(event));
}

function closeEvents(): void {
  events?.close();
  events = undefined;
  eventConnected.value = false;
}

function acceptEvent(message: MessageEvent<string>): void {
  let event: ServerWebEvent;
  try {
    event = JSON.parse(message.data) as ServerWebEvent;
  } catch {
    return;
  }
  if (event.type === "state") {
    acceptState(event.state);
    return;
  }
  if (event.type === "task") {
    const current = state.value;
    if (!current) return;
    state.value = {
      ...current,
      tasks: [event.task, ...current.tasks.filter(({ id }) => id !== event.task.id)].slice(0, 100),
    };
    if (event.task.state === "failed") {
      toast.error({ title: "服务器操作失败", description: event.task.error ?? "Host 未完成操作" });
    }
    return;
  }
  collectConsoleLine(event.line);
}

function acceptState(snapshot: ServerWebStateSnapshot): void {
  state.value = snapshot;
  if (!snapshot.instances.some(({ id }) => id === selectedInstanceId.value)) {
    selectedInstanceId.value = snapshot.instances[0]?.id;
  }
}

async function loadConsoleHistory(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId || !bootstrap.value?.authenticated) {
    consoleLines.value = [];
    lastConsoleSequence = 0;
    return;
  }
  try {
    const result = await request<{ readonly lines: readonly ServerConsoleLine[] }>(
      `/api/instances/${encodeURIComponent(instanceId)}/logs?after=0`,
    );
    if (selectedInstanceId.value !== instanceId) return;
    consoleLines.value = [...result.lines].sort((left, right) => left.sequence - right.sequence);
    lastConsoleSequence = consoleLines.value.at(-1)?.sequence ?? 0;
    await scrollConsoleToBottom();
  } catch (error) {
    notifyError("读取控制台日志失败", error);
  }
}

function collectConsoleLine(line: ServerConsoleLine): void {
  if (line.instanceId !== selectedInstanceId.value || line.sequence <= lastConsoleSequence) return;
  lastConsoleSequence = line.sequence;
  consoleLines.value = [...consoleLines.value, line].slice(-5_000);
  void scrollConsoleToBottom();
}

async function runOperation(kind: ServerWebTaskKind): Promise<void> {
  const instanceId = selectedInstanceId.value;
  if (!instanceId || selectedTask.value || !canWriteHost.value) return;
  try {
    const result = await request<ServerWebTaskAccepted>(
      `/api/instances/${encodeURIComponent(instanceId)}/${kind}`,
      { method: "POST", body: "{}" },
    );
    const current = state.value;
    if (current) {
      state.value = {
        ...current,
        tasks: [result.task, ...current.tasks.filter(({ id }) => id !== result.task.id)],
      };
    }
  } catch (error) {
    notifyError("服务器操作失败", error);
  }
}

async function sendCommand(): Promise<void> {
  const instanceId = selectedInstanceId.value;
  const value = command.value.trim();
  if (!instanceId || !value || !canWriteHost.value) return;
  try {
    await request(`/api/instances/${encodeURIComponent(instanceId)}/command`, {
      method: "POST",
      body: JSON.stringify({ command: value }),
    });
    command.value = "";
  } catch (error) {
    notifyError("发送命令失败", error);
  }
}

function stateLabel(instance: ServerWebInstanceSnapshot): string {
  switch (instance.runtime.state) {
    case "starting":
      return "启动中";
    case "running":
      return "运行中";
    case "stopping":
      return "停止中";
    case "failed":
      return "异常";
    default:
      return "已停止";
  }
}

function operationLabel(kind: ServerWebTaskKind): string {
  if (kind === "start") return "启动";
  if (kind === "stop") return "停止";
  return "重启";
}

function streamLabel(stream: ServerConsoleLine["stream"]): string {
  if (stream === "stderr") return "ERR";
  if (stream === "input") return "IN";
  if (stream === "system") return "SYS";
  return "OUT";
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(timestamp)
    : "--:--:--";
}

async function scrollConsoleToBottom(): Promise<void> {
  await nextTick();
  const element = consoleElement.value;
  if (element) element.scrollTop = element.scrollHeight;
}

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  const value = (await response.json()) as T | ServerWebApiError;
  if (!response.ok) {
    const error = (value as ServerWebApiError).error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? "请求失败",
    );
  }
  return value as T;
}

class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function notifyError(title: string, error: unknown): void {
  toast.error({ title, description: error instanceof Error ? error.message : String(error) });
}
</script>

<template>
  <main v-if="loading" class="web-auth-shell" aria-busy="true">
    <div class="web-loading-mark" aria-label="正在加载"></div>
  </main>

  <main v-else-if="!bootstrap?.authenticated" class="web-auth-shell">
    <section class="web-auth-panel" aria-labelledby="auth-title">
      <div class="web-brand-mark"><Server :size="28" /></div>
      <h1 id="auth-title">{{ bootstrap?.setupRequired ? "设置管理员" : "登录" }}</h1>
      <form class="web-auth-form" @submit.prevent="authenticate">
        <label>
          <span>用户名</span>
          <input v-model="username" name="username" autocomplete="username" required />
        </label>
        <label>
          <span>密码</span>
          <input
            v-model="password"
            name="password"
            type="password"
            :autocomplete="bootstrap?.setupRequired ? 'new-password' : 'current-password'"
            minlength="12"
            maxlength="128"
            required
          />
        </label>
        <Cmz_Button type="submit" :disabled="authBusy">
          {{ authBusy ? "处理中" : bootstrap?.setupRequired ? "创建管理员" : "登录" }}
        </Cmz_Button>
      </form>
    </section>
  </main>

  <main v-else class="server-web-shell">
    <header class="server-web-header">
      <div class="server-web-title">
        <span class="web-brand-mark web-brand-mark--small"><Server :size="20" /></span>
        <h1>SeaShard Server</h1>
      </div>
      <div class="server-web-header-actions">
        <span class="connection-status" :class="{ 'connection-status--online': eventConnected }">
          <Activity :size="14" />{{ eventConnected ? "实时连接" : "正在重连" }}
        </span>
        <span
          class="connection-status"
          :class="{ 'connection-status--online': state?.host.connected }"
        >
          <ShieldCheck :size="14" />{{ state?.host.connected ? "Host 已连接" : "Host 不可用" }}
        </span>
        <button class="icon-button" type="button" aria-label="刷新" @click="refreshState">
          <RefreshCw :size="17" />
        </button>
        <button class="icon-button" type="button" aria-label="退出登录" @click="logout">
          <LogOut :size="17" />
        </button>
      </div>
    </header>

    <div class="server-web-workspace">
      <aside class="server-web-sidebar">
        <section class="sidebar-section">
          <h2>本机 Host</h2>
          <dl class="host-facts">
            <div>
              <dt>控制权</dt>
              <dd>{{ state?.host.hasControl ? "可操作" : "只读" }}</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>{{ state?.host.hostVersion ?? "未知" }}</dd>
            </div>
            <div>
              <dt>连接数</dt>
              <dd>{{ state?.host.connectedControllers ?? 0 }}</dd>
            </div>
          </dl>
        </section>

        <section class="sidebar-section sidebar-section--instances">
          <h2>服务器实例</h2>
          <div v-if="state?.instances.length" class="instance-list">
            <button
              v-for="instance in state.instances"
              :key="instance.id"
              type="button"
              class="instance-row"
              :class="{ 'instance-row--active': instance.id === selectedInstanceId }"
              @click="selectedInstanceId = instance.id"
            >
              <span class="instance-mark">{{ instance.name.slice(0, 1).toUpperCase() }}</span>
              <span class="instance-copy"
                ><strong>{{ instance.name }}</strong
                ><small>{{ stateLabel(instance) }}</small></span
              >
              <span class="runtime-dot" :data-state="instance.runtime.state"></span>
            </button>
          </div>
          <div v-else class="sidebar-empty">暂无服务器实例</div>
        </section>
      </aside>

      <section class="server-web-content">
        <template v-if="selectedInstance">
          <div class="instance-header">
            <div>
              <h2>{{ selectedInstance.name }}</h2>
            </div>
            <div class="instance-actions">
              <Cmz_Button
                :disabled="Boolean(selectedTask) || !canWriteHost"
                @click="runOperation(runtimeAction)"
              >
                <component :is="runtimeAction === 'start' ? Play : Square" :size="15" />
                {{ runtimeAction === "start" ? "启动" : "停止" }}
              </Cmz_Button>
              <Cmz_Button
                variant="outline"
                :disabled="Boolean(selectedTask) || !canWriteHost"
                @click="runOperation('restart')"
              >
                <RotateCw :size="15" />重启
              </Cmz_Button>
            </div>
          </div>

          <div class="runtime-facts">
            <div>
              <span>运行状态</span><strong>{{ stateLabel(selectedInstance) }}</strong>
            </div>
            <div>
              <span>核心</span><strong>{{ selectedInstance.serverType ?? "未知" }}</strong>
            </div>
            <div>
              <span>游戏版本</span><strong>{{ selectedInstance.gameVersion ?? "未知" }}</strong>
            </div>
            <div>
              <span>进程</span><strong>{{ selectedInstance.runtime.pid ?? "—" }}</strong>
            </div>
          </div>

          <section class="console-panel">
            <div class="panel-heading">
              <h2>控制台</h2>
              <Terminal :size="17" />
            </div>
            <div ref="consoleElement" class="console-output" role="log" aria-live="polite">
              <div
                v-for="line in consoleLines"
                :key="line.sequence"
                class="console-line"
                :data-stream="line.stream"
              >
                <time>{{ formatTime(line.timestamp) }}</time
                ><span>{{ streamLabel(line.stream) }}</span
                ><code>{{ line.text }}</code>
              </div>
              <div v-if="consoleLines.length === 0" class="console-empty">暂无控制台输出</div>
            </div>
            <form class="command-bar" @submit.prevent="sendCommand">
              <input
                v-model="command"
                aria-label="服务器命令"
                placeholder="输入服务器命令"
                autocomplete="off"
              />
              <Cmz_Button type="submit" :disabled="!command.trim() || !canWriteHost"
                >发送</Cmz_Button
              >
            </form>
          </section>
        </template>
        <div v-else class="content-empty">
          <Server :size="34" /><span>暂无可管理的服务器实例</span>
        </div>
      </section>

      <aside class="task-panel">
        <div class="panel-heading"><h2>操作任务</h2></div>
        <div v-if="latestTasks.length" class="task-list">
          <div v-for="task in latestTasks" :key="task.id" class="task-row" :data-state="task.state">
            <span class="task-state"></span>
            <div>
              <strong>{{ operationLabel(task.kind) }}</strong
              ><small>{{ task.instanceId }}</small>
            </div>
            <time>{{ formatTime(task.completedAt ?? task.createdAt) }}</time>
          </div>
        </div>
        <div v-else class="task-empty">暂无操作任务</div>
      </aside>
    </div>
  </main>
</template>
