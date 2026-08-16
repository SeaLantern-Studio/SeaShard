<script setup lang="ts">
defineProps<{
  version: string;
}>();
</script>

<template>
  <div class="about-settings-view">
    <section class="about-product" aria-labelledby="about-product-name">
      <div class="about-brand-mark" aria-hidden="true">S</div>
      <div class="about-product-copy">
        <h2 id="about-product-name">SeaShard</h2>
        <p>以全过程组件化为核心的桌面应用。</p>
      </div>
      <span class="about-version">v{{ version }}</span>
    </section>

    <dl class="about-details">
      <div>
        <dt>桌面技术</dt>
        <dd>Electron + Vue 3</dd>
      </div>
      <div>
        <dt>运行时设计</dt>
        <dd>一切皆组件</dd>
      </div>
    </dl>
  </div>
</template>

<style scoped>
.about-settings-view {
  display: flex;
  max-width: 760px;
  margin: 0 auto;
  flex-direction: column;
  gap: var(--sl-space-lg);
  padding-bottom: var(--sl-space-2xl);
}

.about-product-copy p {
  color: var(--sl-text-secondary);
  font-size: var(--sl-font-size-base);
  line-height: var(--sl-line-height-relaxed);
}

.about-product {
  display: flex;
  min-height: 104px;
  align-items: center;
  gap: var(--sl-space-md);
  padding: var(--sl-space-lg);
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-lg);
  background: var(--sl-surface);
}

.about-brand-mark {
  display: grid;
  width: 52px;
  height: 52px;
  flex: 0 0 52px;
  place-items: center;
  border-radius: 14px;
  background: var(--sl-primary-bg);
  color: var(--sl-primary);
  font-size: 1.25rem;
  font-weight: 750;
}

.about-product-copy {
  min-width: 0;
  flex: 1;
}

.about-product-copy h2 {
  margin-bottom: 3px;
  color: var(--sl-text-primary);
  font-size: var(--sl-font-size-xl);
  letter-spacing: -0.015em;
}

.about-version {
  flex-shrink: 0;
  padding: 5px 9px;
  border: 1px solid var(--sl-border-light);
  border-radius: var(--sl-radius-full);
  background: var(--sl-bg-secondary);
  color: var(--sl-text-secondary);
  font-family: var(--sl-font-mono);
  font-size: var(--sl-font-size-xs);
}

.about-details {
  overflow: hidden;
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius-lg);
  background: var(--sl-surface);
}

.about-details > div {
  display: flex;
  min-height: 52px;
  align-items: center;
  justify-content: space-between;
  gap: var(--sl-space-lg);
  padding: 12px var(--sl-space-md);
}

.about-details > div + div {
  border-top: 1px solid var(--sl-border-light);
}

.about-details dt {
  color: var(--sl-text-primary);
  font-size: var(--sl-font-size-base);
  font-weight: 600;
}

.about-details dd {
  color: var(--sl-text-secondary);
  font-size: var(--sl-font-size-sm);
  text-align: right;
}
</style>
