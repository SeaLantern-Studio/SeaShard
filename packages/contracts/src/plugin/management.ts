import { defineServiceContract } from "@seashard/plugin-sdk";
import type {
  PluginExecutionLocation,
  PluginRuntime,
  PluginSourceKind,
  PluginTrustLevel,
} from "@seashard/plugin-sdk";

/** 软件设置中的第三方插件管理页面使用的受限 Contract。 */
export const pluginManagementContract = defineServiceContract<PluginManagementService>(
  "seashard.plugin-management",
);
/** 特权管理 Contract 只接受该内置 Client Binding 的调用身份。 */
export const pluginManagementUiRuntimeId = "core.plugin-management.ui";
export type PluginManagementEntryState = "active" | "failed" | "inactive";

/** 第三方包内单个 Entry 的只读运行状态。 */
export interface PluginManagementEntrySnapshot {
  readonly id: string;
  readonly runtimeId: string;
  readonly runtime: PluginRuntime;
  readonly execution?: PluginExecutionLocation;
  readonly enabled: boolean;
  readonly state: PluginManagementEntryState;
  readonly uses: Readonly<Record<string, readonly string[]>>;
  readonly error?: string;
}

/** 当前 Controller 实际采用的第三方包；开发覆盖与已安装版本按插件 ID 合并。 */
export interface PluginManagementSnapshot {
  readonly id: string;
  readonly version: string;
  readonly publisher: string;
  readonly source: Exclude<PluginSourceKind, "builtin">;
  readonly trust: Exclude<PluginTrustLevel, "builtin" | "official">;
  readonly digest: string;
  readonly installedAt: string;
  readonly enabled: boolean;
  readonly entries: readonly PluginManagementEntrySnapshot[];
}

/** 只向内置插件设置 Client Entry 开放的管理能力。 */
export interface PluginManagementService {
  /**
   * 列出当前有效的已安装包和命令行开发覆盖，不返回内置组件。
   *
   * @returns 按插件 ID 排序的第三方包运行快照。
   */
  list(): Promise<readonly PluginManagementSnapshot[]>;
  /**
   * 整体启停一个第三方包的全部自动 Binding，并等待 Runtime 完成收敛。
   *
   * @param pluginId 目标插件的 Manifest ID。
   * @param enabled 是否启用该插件的全部 Entry。
   * @returns Runtime 收敛后的插件快照。
   */
  setEnabled(pluginId: string, enabled: boolean): Promise<PluginManagementSnapshot>;
  /**
   * 停止并删除正式安装插件的全部版本、自动 Binding 和摘要信任记录。
   *
   * @param pluginId 目标插件的 Manifest ID；开发会话加载的临时插件不允许删除。
   * @returns 删除和 Runtime 收敛完成后返回。
   */
  uninstall(pluginId: string): Promise<void>;
}
