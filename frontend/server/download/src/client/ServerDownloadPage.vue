<script setup lang="ts">
import type { ServerCoreSourceClientService } from "@seashard/contracts";
import { computed, onMounted, ref } from "vue";
import type { ResourceCategory } from "./resource-categories";

interface CoreCard {
  readonly id: string;
  readonly label: string;
}

const props = defineProps<{
  coreSource: ServerCoreSourceClientService;
  category: ResourceCategory;
}>();

const catalogTypes = ref<readonly string[]>([]);
const catalogLoading = ref(props.category.id === "server-core");
const catalogError = ref<string>();
const coreCards = computed<readonly CoreCard[]>(() => [
  { id: "vanilla", label: "原版核心" },
  ...catalogTypes.value
    .filter((type) => type !== "vanilla")
    .map((type) => ({ id: type, label: formatCoreType(type) })),
]);

onMounted(() => {
  if (props.category.id === "server-core") void loadCatalogTypes();
});

async function loadCatalogTypes(): Promise<void> {
  catalogLoading.value = true;
  catalogError.value = undefined;
  try {
    catalogTypes.value = await props.coreSource.listTypes();
  } catch (error) {
    catalogError.value = error instanceof Error ? error.message : String(error);
  } finally {
    catalogLoading.value = false;
  }
}

const coreTypeNames: Readonly<Record<string, string>> = {
  "arclight-fabric": "Arclight Fabric",
  "arclight-forge": "Arclight Forge",
  "arclight-neoforge": "Arclight NeoForge",
  banner: "Banner",
  bukkit: "Bukkit",
  bungeecord: "BungeeCord",
  catserver: "CatServer",
  fabric: "Fabric",
  folia: "Folia",
  leaf: "Leaf",
  leaves: "Leaves",
  lightfall: "Lightfall",
  mohist: "Mohist",
  neoforge: "NeoForge",
  nukkitx: "NukkitX",
  paper: "Paper",
  pufferfish: "Pufferfish",
  pufferfish_purpur: "Pufferfish Purpur",
  purpur: "Purpur",
  quilt: "Quilt",
  spigot: "Spigot",
  spongeforge: "SpongeForge",
  spongevanilla: "SpongeVanilla",
  travertine: "Travertine",
  "vanilla-snapshot": "原版快照",
  velocity: "Velocity",
  youer: "Youer",
};

function formatCoreType(type: string): string {
  return (
    coreTypeNames[type] ??
    type
      .split(/[-_]/u)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" ")
  );
}
</script>

<template>
  <section class="server-download-page" :aria-labelledby="`resource-title-${category.id}`">
    <h1 :id="`resource-title-${category.id}`">{{ category.label }}</h1>

    <template v-if="category.id === 'server-core'">
      <div v-if="catalogLoading" class="core-card-grid" aria-label="正在加载服务器核心">
        <div v-for="index in 12" :key="index" class="core-card core-card-loading">
          <div class="core-card-icon"></div>
          <div class="core-card-label-placeholder"></div>
        </div>
      </div>

      <div v-else-if="catalogError" class="catalog-error" role="alert">
        <p>无法读取服务器核心目录</p>
        <span>{{ catalogError }}</span>
        <button type="button" @click="loadCatalogTypes">重新加载</button>
      </div>

      <div v-else class="core-card-grid" aria-label="服务器核心列表">
        <article v-for="core in coreCards" :key="core.id" class="core-card" :data-core-id="core.id">
          <div class="core-card-icon" aria-hidden="true"></div>
          <h2>{{ core.label }}</h2>
        </article>
      </div>
    </template>
  </section>
</template>

<style scoped>
.server-download-page {
  min-width: 0;
  min-height: 100%;
  padding: 8px clamp(4px, 1.6vw, 18px) 34px;
}

.server-download-page h1 {
  margin: 0 0 27px;
  color: var(--sl-text-primary);
  font-size: clamp(1.6rem, 2.6vw, 2rem);
  font-weight: 700;
  letter-spacing: -0.028em;
  line-height: 1.15;
}

.core-card-grid {
  display: grid;
  align-items: start;
  grid-template-columns: repeat(auto-fill, minmax(142px, 1fr));
  gap: 14px;
}

.core-card {
  display: flex;
  min-width: 0;
  min-height: 154px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 15px;
  padding: 19px 14px 17px;
  border: 1px solid var(--sl-border-light);
  border-radius: var(--sl-radius-lg);
  background: color-mix(in srgb, var(--sl-surface) 82%, var(--sl-bg-secondary));
}

.core-card-icon {
  width: 68px;
  height: 68px;
  flex: 0 0 68px;
  border: 1px dashed color-mix(in srgb, var(--sl-border) 78%, transparent);
  border-radius: var(--sl-radius-md);
  background: color-mix(in srgb, var(--sl-bg-secondary) 75%, transparent);
}

.core-card h2 {
  max-width: 100%;
  margin: 0;
  overflow: hidden;
  color: var(--sl-text-primary);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.35;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.core-card-loading {
  border-color: transparent;
}

.core-card-loading .core-card-icon,
.core-card-label-placeholder {
  border: 0;
  background: linear-gradient(
    100deg,
    var(--sl-bg-secondary) 30%,
    var(--sl-bg-tertiary) 48%,
    var(--sl-bg-secondary) 66%
  );
  background-size: 220% 100%;
  animation: catalog-loading 1.35s ease-in-out infinite;
}

.core-card-label-placeholder {
  width: 72%;
  height: 12px;
  border-radius: var(--sl-radius-full);
}

.catalog-error {
  max-width: 520px;
  padding: 20px 22px;
  border-left: 3px solid #dc6b6b;
  background: color-mix(in srgb, #dc6b6b 8%, var(--sl-surface));
}

.catalog-error p {
  margin: 0;
  color: var(--sl-text-primary);
  font-size: 0.9375rem;
  font-weight: 650;
}

.catalog-error span {
  display: block;
  margin-top: 6px;
  color: var(--sl-text-secondary);
  font-size: 0.8125rem;
  line-height: 1.55;
}

.catalog-error button {
  margin-top: 15px;
  padding: 7px 12px;
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-md);
  background: var(--sl-surface);
  color: var(--sl-text-primary);
  font-size: 0.8125rem;
  font-weight: 600;
}

.catalog-error button:hover {
  background: var(--sl-bg-tertiary);
}

.catalog-error button:focus-visible {
  outline: 2px solid var(--sl-primary);
  outline-offset: 2px;
}

@keyframes catalog-loading {
  from {
    background-position: 100% 0;
  }

  to {
    background-position: -100% 0;
  }
}

@media (max-width: 1120px) {
  .server-download-page {
    padding-inline: 4px;
  }

  .core-card-grid {
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  }
}

@media (prefers-reduced-motion: reduce) {
  .core-card-loading .core-card-icon,
  .core-card-label-placeholder {
    animation: none;
  }
}
</style>
