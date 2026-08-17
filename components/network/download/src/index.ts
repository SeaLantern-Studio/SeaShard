import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import { DownloadManager } from "./download-manager";
import { downloadContract, type DownloadManagerOptions } from "./types";

export interface DownloadModuleOptions extends DownloadManagerOptions {}

export const downloadManifest: PluginManifest = {
  id: "seashard.download",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "download.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/** 创建进程级公共下载组件，集中管理所有业务类型的任务与网络传输入口。 */
export function createDownloadModule(options: DownloadModuleOptions = {}): PluginModule {
  return {
    provides: [downloadContract],
    apply(ctx) {
      const manager = new DownloadManager(options);
      ctx.provide(downloadContract, {
        start: async (request) => asJsonValue(await manager.start(request)),
        snapshot: (taskId) => asJsonValue(manager.snapshot(expectString(taskId, "taskId")) ?? null),
        wait: async (taskId) =>
          asJsonValue((await manager.wait(expectString(taskId, "taskId"))) ?? null),
        listTasks: () => asJsonValue(manager.listTasks()),
        cancel: (taskId) => manager.cancel(expectString(taskId, "taskId")),
      });
      return () => manager.dispose();
    },
  };
}

function expectString(value: JsonValue, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`download ${field} must be a non-empty string`);
  }
  return value;
}

/** DownloadManager 的快照只包含普通 JSON 字段，此处补足 SDK 服务边界类型。 */
function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export * from "./download-manager";
export * from "./types";
