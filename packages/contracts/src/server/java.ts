import { defineServiceContract } from "@seashard/plugin-sdk";

/** Java 运行环境管理组件发布的只读扫描 Service contract。 */
export const javaRuntimeManagerContract = defineServiceContract<JavaRuntimeManagerService>(
  "seashard.java-runtime-manager",
);
export type JavaInstallationSource = "java-home" | "path" | "registry" | "filesystem" | "manual";

/** 自动发现的 Java 安装；路径已经由 Host 解析为规范化绝对路径。 */
export interface JavaInstallationSnapshot {
  id: string;
  path: string;
  javaHome: string;
  version: string;
  majorVersion: number;
  vendor: string;
  architecture: string;
  is64Bit: boolean;
  source: JavaInstallationSource;
  /** 禁用项继续展示，但不会参与服务器启动时的 Java 选择。 */
  disabled: boolean;
}

/** Host 组件的完整能力；显式检查只接受用户选择的可执行文件路径。 */
export interface JavaRuntimeManagerService {
  /**
   * 重新扫描系统和 SeaShard 保存的 Java 安装。
   *
   * @returns 规范化、去重并带启用状态的安装列表。
   */
  scan(): Promise<readonly JavaInstallationSnapshot[]>;
  /**
   * 检查用户明确选择的 Java 可执行文件。
   *
   * @param executablePath Java 可执行文件的绝对路径。
   * @returns 执行探测得到的版本、供应商和架构信息。
   */
  inspect(executablePath: string): Promise<JavaInstallationSnapshot>;
  /**
   * 仅移除 SeaShard 保存的手动路径记录，不删除或卸载本地 Java。
   *
   * @param executablePath 手动添加的 Java 可执行文件路径。
   * @returns 是否移除了已保存记录。
   */
  remove(executablePath: string): Promise<boolean>;
  /**
   * 持久化启用状态；禁用只影响 SeaShard 选择，不修改本地 Java。
   *
   * @param installationId 扫描快照中的稳定安装 ID。
   * @param disabled 是否从自动选择候选中排除。
   * @returns 是否更新了目标安装。
   */
  setDisabled(installationId: string, disabled: boolean): Promise<boolean>;
}

/** Renderer 只触发受控扫描或系统文件选择，不直接提交任意文件系统路径。 */
export interface JavaRuntimeClientService {
  scan(): Promise<readonly JavaInstallationSnapshot[]>;
  add(): Promise<JavaInstallationSnapshot | undefined>;
  /** 仅移除通过“添加”保存的记录；自动扫描到的安装不受影响。 */
  remove(executablePath: string): Promise<boolean>;
  /** 禁用项保留在列表中，可随时重新启用。 */
  setDisabled(installationId: string, disabled: boolean): Promise<boolean>;
}
