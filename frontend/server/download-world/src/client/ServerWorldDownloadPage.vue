<script setup lang="ts">
import { CircleOff, Folder } from "lucide-vue-next";
</script>

<template>
  <section class="server-world-download-page" aria-labelledby="world-download-title">
    <h1 id="world-download-title">世界</h1>
    <div class="world-source-state" role="status">
      <span class="world-source-icon" aria-hidden="true">
        <Folder :size="28" :stroke-width="1.6" />
        <CircleOff :size="15" :stroke-width="2" />
      </span>
      <strong>Modrinth 暂无独立世界资源</strong>
      <p>当前接口没有 world 项目类型，SeaShard 不会把世界生成数据包伪装成世界存档。</p>
      <span class="world-download-status">世界下载暂未开放</span>
    </div>
  </section>
</template>

<style scoped src="./ServerWorldDownloadPage.css"></style>
