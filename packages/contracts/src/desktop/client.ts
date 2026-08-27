import { defineServiceContract } from "@seashard/plugin-sdk";
import type { ActivationScope, JsonValue } from "@seashard/plugin-sdk";

/** Desktop Shell 发布的主窗口生命周期 Service contract。 */
export const desktopShellContract =
  defineServiceContract<DesktopShellService>("seashard.desktop-shell");
/** 控制 Desktop 主窗口生命周期的宿主 Service。 */
export interface DesktopShellService {
  /** 创建或聚焦主窗口；窗口已经打开时保持幂等。 */
  openPrimary(): Promise<void>;
}
export type ClientSurface = "primary";

/** Renderer 可加载的 Client 模块引用；包目录始终留在 Main，跨边界只发布摘要 URL。 */
export type ClientEntryModuleReference =
  | {
      source: "builtin";
      key: string;
    }
  | {
      source: "package";
      url: string;
    };

/** Main 允许当前 Renderer 激活的单个 Client Entry；不暴露包目录或宿主内部对象。 */
export interface ClientEntryDescriptor {
  runtimeId: string;
  pluginId: string;
  pluginVersion: string;
  entryId: string;
  module: ClientEntryModuleReference;
  integrity: string;
  scopeType: ActivationScope;
  scopeId: string;
  config: JsonValue;
}

/** Client Entry 通过固定 IPC 请求 Main 调用一个 Host Service 方法。 */
export interface ClientServiceCallRequest {
  readonly runtimeId: string;
  readonly integrity: string;
  readonly contract: string;
  readonly method: string;
  readonly args: readonly JsonValue[];
}

/** Client Entry 期望状态；revision 用于丢弃迟到的 Renderer 更新。 */
export interface ClientEntryPublication {
  revision: number;
  entries: readonly ClientEntryDescriptor[];
}

/** 每个 Electron WebContents 独立取得的桌面 Client 启动快照。 */
export interface DesktopClientBootstrap extends ClientEntryPublication {
  protocolVersion: 1;
  clientSession: {
    id: string;
    target: "desktop";
    surface: ClientSurface;
  };
}
