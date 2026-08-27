import { defineServiceContract } from "@seashard/plugin-sdk";

/** 服务器设置 Host 组件发布的稳定 Service contract。 */
export const serverSettingsContract = defineServiceContract<ServerSettingsClientService>(
  "seashard.server-settings",
);
/** 新服务器继承的全局启动默认值；具体实例后续可以单独覆盖。 */
export const serverStartupDefaults = {
  minimumMemoryMiB: 512,
  maximumMemoryMiB: 2_048,
  port: 25_565,
  autoAcceptEula: true,
  jvmArguments: "",
} as const;

export const serverPortLimits = {
  minimum: 1,
  maximum: 65_535,
} as const;

/** 防止无界 IPC 与持久化输入；该值只限制参数文本，不改变 JVM 参数语义。 */
export const serverJvmArgumentsMaximumLength = 8_192;
/** 一次性提交相互依赖的启动默认值，避免最小内存与最大内存出现中间非法状态。 */
export interface ServerStartupDefaultsUpdate {
  defaultMinimumMemoryMiB: number;
  defaultMaximumMemoryMiB: number;
  defaultServerPort: number;
  autoAcceptEula: boolean;
  defaultJvmArguments: string;
}

/** 可持久化并跨 Host/Client 边界传输的服务器设置快照。 */
export interface ServerSettingsSnapshot extends ServerStartupDefaultsUpdate {
  resourceDownloadDirectory: string;
  defaultDownloadConnections: number;
}

/** Renderer 只获得设置读写能力，不接触插件存储或数据库对象。 */
export interface ServerSettingsClientService {
  /**
   * 读取当前服务器全局设置。
   *
   * @returns 下载目录、并发数和新实例启动默认值。
   */
  get(): Promise<ServerSettingsSnapshot>;
  /**
   * 更新资源另存为默认目录。
   *
   * @param directory 由 Host 选择并验证的绝对目录。
   * @returns 更新后的设置快照。
   */
  setResourceDownloadDirectory(directory: string): Promise<ServerSettingsSnapshot>;
  /**
   * 更新公共下载器默认并发数。
   *
   * @param connections 处于 serverDownloadConnectionLimits 内的并发数。
   * @returns 更新后的设置快照。
   */
  setDefaultDownloadConnections(connections: number): Promise<ServerSettingsSnapshot>;
  /**
   * 一次性更新相互依赖的新实例启动默认值。
   *
   * @param update 内存、端口、EULA 和 JVM 参数默认值。
   * @returns 更新后的设置快照。
   */
  setStartupDefaults(update: ServerStartupDefaultsUpdate): Promise<ServerSettingsSnapshot>;
}
