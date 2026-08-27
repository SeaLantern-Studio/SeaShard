import { defineServiceContract } from "@seashard/plugin-sdk";

/** 服务器与插件配置文件管理组件发布的 Host/Client 稳定 Contract。 */
export const serverConfigurationContract = defineServiceContract<ServerConfigurationService>(
  "seashard.server-configuration",
);
export type ServerConfigurationFileKind = "properties" | "yaml" | "json" | "toml" | "text";
export type ServerConfigurationFileScope = "server" | "other" | "plugin";
export type ServerConfigurationTextEncoding = "utf-8" | "utf-8-bom";

/** Renderer 可选择的配置文件只使用实例内相对路径，不暴露宿主绝对路径。 */
export interface ServerConfigurationFile {
  path: string;
  name: string;
  kind: ServerConfigurationFileKind;
  scope: ServerConfigurationFileScope;
  pluginName?: string;
}

export interface ServerPluginConfigurationGroup {
  name: string;
  files: readonly ServerConfigurationFile[];
}

/** 单个实例当前可编辑配置的目录；其他配置只在实际发现文件时显示。 */
export interface ServerConfigurationCatalog {
  instanceId: string;
  serverType?: string;
  /** 实际配置根目录；Quilt 等核心可能位于实例根目录的子目录。 */
  configurationRootPath: string;
  pluginSupported: boolean;
  serverFiles: readonly ServerConfigurationFile[];
  otherFiles: readonly ServerConfigurationFile[];
  plugins: readonly ServerPluginConfigurationGroup[];
}

/** revision 是原始文件字节的 SHA-256，用于拒绝覆盖服务器或外部编辑器的新修改。 */
export interface ServerConfigurationDocument extends ServerConfigurationFile {
  instanceId: string;
  content: string;
  revision: string;
  encoding: ServerConfigurationTextEncoding;
  modifiedAt: string;
}

export interface ServerConfigurationWriteRequest {
  instanceId: string;
  path: string;
  content: string;
  expectedRevision: string;
}

/** 配置文件路径必须先由 list 发布；Host 仍会独立校验实例边界、后缀与符号链接。 */
export interface ServerConfigurationService {
  /**
   * 扫描实例内允许编辑的服务端、其他及插件配置文件。
   *
   * @param instanceId 已登记实例 ID。
   * @returns 已通过路径与文件类型校验的配置目录。
   */
  list(instanceId: string): Promise<ServerConfigurationCatalog>;
  /**
   * 读取目录中已经发布的配置文件。
   *
   * @param instanceId 已登记实例 ID。
   * @param path list 返回的实例内相对路径。
   * @returns 文本内容、编码和用于并发控制的 revision。
   */
  read(instanceId: string, path: string): Promise<ServerConfigurationDocument>;
  /**
   * 仅在 revision 未变化时原子写入配置文件。
   *
   * @param request 实例、相对路径、正文与预期 revision。
   * @returns 写入后的最新配置文档。
   */
  write(request: ServerConfigurationWriteRequest): Promise<ServerConfigurationDocument>;
}

export interface ServerConfigurationClientService extends ServerConfigurationService {}
