<script setup lang="ts">
import type { RuntimeSnapshot } from "@seashard/contracts";
import { Cmz_Badge, Cmz_Button, Cmz_Card, Cmz_Spinner } from "cmzya-modern-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{
  getSnapshot: () => Promise<RuntimeSnapshot>;
}>();

const snapshot = ref<RuntimeSnapshot>();
const loading = ref(true);
const error = ref<string>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;

const activeCount = computed(
  () => snapshot.value?.components.filter((component) => component.phase === "active").length ?? 0,
);

async function refresh(): Promise<void> {
  try {
    error.value = undefined;
    snapshot.value = await props.getSnapshot();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refresh();
  refreshTimer = setInterval(() => void refresh(), 5_000);
});

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <div class="runtime-page">
    <section class="runtime-intro">
      <div>
        <p class="section-label">SYSTEM DIAGNOSTICS</p>
        <h1>运行状态</h1>
        <p class="intro-copy">
          查看当前宿主与插件 Fiber 状态。该页面由内置 Client Entry 注册，页面卸载时会同步停止轮询。
        </p>
      </div>
      <div class="intro-actions">
        <Cmz_Badge text="Electron · Client Entry" size="small" />
        <Cmz_Button variant="outline" size="sm" :disabled="loading" @click="refresh">
          刷新状态
        </Cmz_Button>
      </div>
    </section>

    <section v-if="loading" class="state-panel" data-testid="runtime-loading">
      <Cmz_Spinner size="lg" />
      <span>正在读取运行状态…</span>
    </section>

    <section v-else-if="error" class="state-panel error-panel" data-testid="runtime-error">
      <p class="section-label">CONTRACT ERROR</p>
      <strong>{{ error }}</strong>
    </section>

    <template v-else-if="snapshot">
      <section class="summary-grid" data-testid="runtime-ready">
        <Cmz_Card class="summary-card">
          <p class="metric-label">宿主状态</p>
          <div class="metric-row">
            <span class="status-dot" :class="`status-dot--${snapshot.state}`"></span>
            <strong>{{ snapshot.state }}</strong>
          </div>
        </Cmz_Card>

        <Cmz_Card class="summary-card">
          <p class="metric-label">已激活组件</p>
          <strong class="metric-value">{{ activeCount }}/{{ snapshot.components.length }}</strong>
        </Cmz_Card>

        <Cmz_Card class="summary-card">
          <p class="metric-label">投影协议</p>
          <strong class="metric-value">v{{ snapshot.protocolVersion }}</strong>
        </Cmz_Card>
      </section>

      <section class="component-section">
        <div class="section-heading">
          <div>
            <p class="section-label">PLUGIN RUNTIMES</p>
            <h2>Cordis 插件</h2>
          </div>
          <time>{{ new Date(snapshot.startedAt).toLocaleString() }}</time>
        </div>

        <div class="component-list">
          <article
            v-for="component in snapshot.components"
            :key="component.id"
            class="component-row"
          >
            <div>
              <strong>{{ component.displayName }}</strong>
              <code>{{ component.id }}</code>
            </div>
            <div class="component-meta">
              <span class="phase" :class="`phase--${component.phase}`">{{ component.phase }}</span>
            </div>
          </article>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.runtime-page {
  display: grid;
  gap: 22px;
}

.runtime-intro,
.section-heading,
.component-row,
.metric-row,
.component-meta,
.intro-actions {
  display: flex;
  align-items: center;
}

.runtime-intro {
  justify-content: space-between;
  gap: 40px;
  padding: 18px 0 28px;
}

.runtime-intro h1,
.section-heading h2,
.runtime-intro p {
  margin: 0;
}

.runtime-intro h1 {
  margin-top: 10px;
  font-size: clamp(36px, 5vw, 58px);
  font-weight: 620;
  line-height: 1;
  letter-spacing: -0.055em;
}

.intro-copy {
  max-width: 660px;
  margin-top: 18px !important;
  color: var(--ss-text-muted);
  font-size: 14px;
  line-height: 1.7;
}

.intro-actions {
  align-items: flex-end;
  flex-direction: column;
  gap: 14px;
}

.section-label,
.metric-label {
  color: var(--ss-text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
}

.state-panel {
  display: flex;
  min-height: 220px;
  align-items: center;
  justify-content: center;
  gap: 14px;
  border: 1px solid var(--ss-border);
  border-radius: var(--ss-radius-lg);
  background: var(--ss-surface);
}

.error-panel {
  align-items: flex-start;
  flex-direction: column;
  padding: 28px;
  color: var(--ss-danger);
}

.summary-grid {
  display: grid;
  grid-template-columns: 1.5fr 1fr 1fr;
  overflow: hidden;
  border: 1px solid var(--ss-border);
  border-radius: var(--ss-radius-lg);
  background: var(--ss-surface);
}

.summary-card {
  min-height: 132px;
  padding: 24px !important;
  border: 0 !important;
  border-right: 1px solid var(--ss-border) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

.summary-card:last-child {
  border-right: 0 !important;
}

.metric-row {
  gap: 10px;
  margin-top: 22px;
  font-size: 25px;
  text-transform: capitalize;
}

.metric-value {
  display: block;
  margin-top: 22px;
  font-size: 25px;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #b2a89b;
}

.status-dot--active {
  background: var(--ss-success);
  box-shadow: 0 0 0 5px rgb(76 141 103 / 12%);
}

.status-dot--degraded {
  background: var(--ss-warning);
}

.component-section {
  padding: 26px;
  border: 1px solid var(--ss-border);
  border-radius: var(--ss-radius-lg);
  background: var(--ss-surface);
}

.section-heading {
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--ss-border-subtle);
}

.section-heading h2 {
  margin-top: 5px;
  font-size: 21px;
  font-weight: 620;
  letter-spacing: -0.025em;
}

.section-heading time,
.component-meta {
  color: var(--ss-text-muted);
  font-size: 12px;
}

.component-list {
  display: grid;
}

.component-row {
  min-height: 78px;
  justify-content: space-between;
  gap: 24px;
  border-bottom: 1px solid var(--ss-border-subtle);
}

.component-row:last-child {
  border-bottom: 0;
}

.component-row strong {
  display: block;
  margin-bottom: 6px;
  font-size: 14px;
}

.component-row code {
  color: var(--ss-text-muted);
  font-size: 12px;
}

.component-meta {
  justify-content: flex-end;
  gap: 18px;
}

.phase {
  min-width: 72px;
  padding: 6px 9px;
  border: 1px solid var(--ss-border-strong);
  border-radius: 999px;
  color: var(--ss-text-secondary);
  text-align: center;
  text-transform: capitalize;
}

.phase--active {
  border-color: #a9c8b4;
  color: #2f6e48;
  background: #edf5ef;
}

@media (max-width: 900px) {
  .runtime-intro {
    align-items: flex-start;
    flex-direction: column;
  }

  .intro-actions {
    align-items: flex-start;
  }

  .summary-grid {
    grid-template-columns: 1fr;
  }

  .summary-card {
    border-right: 0 !important;
    border-bottom: 1px solid var(--ss-border) !important;
  }

  .summary-card:last-child {
    border-bottom: 0 !important;
  }
}
</style>
