<script setup lang="ts">
import type { ServerModSourceClientService } from "@seashard/contracts";
import { ServerResourceDownloadPage } from "@seashard/server-download-resource-shared";

defineProps<{
  resources: ServerModSourceClientService;
}>();
</script>

<template>
  <ServerResourceDownloadPage :resources="resources" resource-type="modpack" />
</template>
