import { Archive, Folder, Package, Puzzle, Server, Star } from "lucide-vue-next";
import type { Component } from "vue";

export type ResourceCategoryId =
  | "server-core"
  | "mod"
  | "modpack"
  | "datapack"
  | "world"
  | "favorites";

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

export const otherResourceCategories: readonly ResourceCategory[] = [
  {
    id: "mod",
    path: "/server/download/mod",
    label: "Mod",
    description: "浏览服务端 Mod",
    icon: Puzzle,
    order: 20,
  },
  {
    id: "modpack",
    path: "/server/download/modpack",
    label: "整合包",
    description: "浏览服务端整合包",
    icon: Package,
    order: 30,
  },
  {
    id: "datapack",
    path: "/server/download/datapack",
    label: "数据包",
    description: "浏览服务端数据包",
    icon: Archive,
    order: 40,
  },
  {
    id: "world",
    path: "/server/download/world",
    label: "世界",
    description: "浏览可下载世界",
    icon: Folder,
    order: 50,
  },
  {
    id: "favorites",
    path: "/server/download/favorites",
    label: "收藏夹",
    description: "查看收藏的服务器资源",
    icon: Star,
    order: 60,
  },
];

export const downloadResourceCategories: readonly ResourceCategory[] = [
  serverCoreResourceCategory,
  ...otherResourceCategories,
];
