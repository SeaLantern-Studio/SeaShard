<script setup lang="ts">
import type {
  ServerInstanceClientService,
  ServerModSourceClientService,
  ServerRuntimeClientService,
} from "@seashard/contracts";
import { ServerResourceDownloadPage } from "@seashard/server-download-resource-shared";

defineProps<{
  resources: ServerModSourceClientService;
  instances: ServerInstanceClientService;
  runtime: ServerRuntimeClientService;
}>();
</script>

<template>
  <ServerResourceDownloadPage
    :resources="resources"
    :instances="instances"
    :runtime="runtime"
    resource-type="world"
  />
</template>

<style scoped src="./ServerWorldDownloadPage.css"></style>
