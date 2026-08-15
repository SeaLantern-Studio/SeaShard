<script setup lang="ts">
import type { RuntimeSnapshot } from "@seashard/contracts";
import { Cmz_Badge, Cmz_Button, Cmz_Card, Cmz_Spinner } from "cmzya-modern-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

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
    snapshot.value = await window.seashard.runtime.getSnapshot();
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
  <main class="shell">
    <header class="topbar">
      <div class="identity">
        <span class="mark" aria-hidden="true">S</span>
        <div>
          <p class="eyebrow">SEASHARD</p>
          <h1>Runtime foundation</h1>
        </div>
      </div>
      <Cmz_Badge variant="outline">Electron host</Cmz_Badge>
    </header>

    <section class="intro">
      <div>
        <p class="section-label">FIRST RUNNING SLICE</p>
        <h2>One host. One lifecycle owner.</h2>
        <p class="intro-copy">
          Electron provides the desktop shell. Cordis owns component effects and cleanup. The
          renderer reads a typed projection through the preload boundary.
        </p>
      </div>
      <Cmz_Button variant="outline" size="sm" :disabled="loading" @click="refresh">
        Refresh status
      </Cmz_Button>
    </section>

    <section v-if="loading" class="state-panel" data-testid="runtime-loading">
      <Cmz_Spinner size="lg" />
      <span>Reading runtime state…</span>
    </section>

    <section v-else-if="error" class="state-panel error-panel" data-testid="runtime-error">
      <p class="section-label">CONTRACT ERROR</p>
      <strong>{{ error }}</strong>
    </section>

    <template v-else-if="snapshot">
      <section class="summary-grid" data-testid="runtime-ready">
        <Cmz_Card class="summary-card">
          <p class="metric-label">Runtime</p>
          <div class="metric-row">
            <span class="status-dot" :class="`status-dot--${snapshot.state}`"></span>
            <strong>{{ snapshot.state }}</strong>
          </div>
        </Cmz_Card>

        <Cmz_Card class="summary-card">
          <p class="metric-label">Active components</p>
          <strong class="metric-value">{{ activeCount }}/{{ snapshot.components.length }}</strong>
        </Cmz_Card>

        <Cmz_Card class="summary-card">
          <p class="metric-label">Contract</p>
          <strong class="metric-value">v{{ snapshot.protocolVersion }}</strong>
        </Cmz_Card>
      </section>

      <section class="component-section">
        <div class="section-heading">
          <div>
            <p class="section-label">LIVE COMPONENTS</p>
            <h3>Supervisor projection</h3>
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
              <span>generation {{ component.generation }}</span>
              <span class="phase" :class="`phase--${component.phase}`">{{ component.phase }}</span>
            </div>
          </article>
        </div>
      </section>
    </template>
  </main>
</template>
