<script setup lang="ts">
import type {
  ServerInstanceClientService,
  ServerModSourceClientService,
} from "@seashard/contracts";
import { ServerResourceDownloadPage } from "@seashard/server-download-resource-shared";

defineProps<{
  resources: ServerModSourceClientService;
  instances: ServerInstanceClientService;
}>();
</script>

<template>
  <ServerResourceDownloadPage
    :resources="resources"
    :instances="instances"
    resource-type="datapack"
  />
</template>
