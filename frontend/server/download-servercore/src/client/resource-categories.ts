import { Server } from "lucide-vue-next";
import type { Component } from "vue";

export type ResourceCategoryId = "server-core" | "modpack" | "datapack" | "world" | "favorites";

export interface ResourceCategory {
  readonly id: ResourceCategoryId;
  readonly path: `/${string}`;
  readonly label: string;
  readonly description: string;
  readonly icon: Component;
  readonly order: number;
}

export const serverCoreResourceCategory: ResourceCategory = {
  id: "server-core",
  path: "/server/download",
  label: "服务器核心",
  description: "浏览并下载服务端核心",
  icon: Server,
  order: 10,
};

export const downloadResourceCategories: readonly ResourceCategory[] = [serverCoreResourceCategory];
