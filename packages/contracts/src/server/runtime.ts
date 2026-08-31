import { defineServiceContract } from "@seashard/plugin-sdk";
import type { ServerInstanceStartupSettings } from "./instance.js";

/** 服务器进程运行组件发布的 Host/Client 稳定 Contract。 */
export const serverRuntimeContract =
  defineServiceContract<ServerRuntimeService>("seashard.server-runtime");
/** 运行组件已实现并可由启动页直接调度的核心类型。 */
export const serverRuntimeSupportedTypes = [
  "vanilla",
  "paper",
  "purpur",
  "folia",
  "fabric",
  "quilt",
  "neoforge",
  "arclight-neoforge",
  "mohist",
  "velocity",
  "nukkitx",
  "arclight-fabric",
  "arclight-forge",
  "banner",
  "bukkit",
  "bungeecord",
  "catserver",
  "leaf",
  "leaves",
  "lightfall",
  "pufferfish",
  "pufferfish_purpur",
  "spigot",
  "spongeforge",
  "spongevanilla",
  "travertine",
  "vanilla-snapshot",
  "youer",
] as const;
export type ServerRuntimeSupportedType = (typeof serverRuntimeSupportedTypes)[number];
/** 可接收普通 Java 世界存档的核心；Paper 系列会在启动时自动转换其维度布局。 */
const unifiedWorldServerTypes = new Set([
  "vanilla",
  "vanilla-snapshot",
  "forge",
  "fabric",
  "quilt",
  "neoforge",
  "spongeforge",
  "spongevanilla",
  "paper",
  "purpur",
  "folia",
  "pufferfish",
  "pufferfish_purpur",
  "leaf",
  "leaves",
  // Arclight 默认使用原版维度目录；开启 symlink-world 后才额外生成 Bukkit 映射。
  "arclight-fabric",
  "arclight-forge",
  "arclight-neoforge",
  // 这三个混合核心的实测首个世界均为单根目录 + DIM/维度目录。
  "banner",
  "mohist",
  "youer",
]);

export function supportsUnifiedWorldStorage(value: unknown): boolean {
  return typeof value === "string" && unifiedWorldServerTypes.has(value);
}

/** Renderer 与 Host 共享同一支持列表，避免页面和进程管理器各维护一份条件链。 */
export function isServerRuntimeSupportedType(value: unknown): value is ServerRuntimeSupportedType {
  return (
    typeof value === "string" && (serverRuntimeSupportedTypes as readonly string[]).includes(value)
  );
}

export type ServerProcessState = "stopped" | "starting" | "running" | "stopping" | "failed";
export type ServerConsoleStream = "stdout" | "stderr" | "input" | "system";

/** 启动组件根据当前 Java 选择和核心策略生成的等价命令行。 */
export interface ServerLaunchCommandPreview {
  instanceId: string;
  command: string;
}

/** 单个服务器进程的可序列化状态；不暴露 ChildProcess 或宿主句柄。 */
export interface ServerRuntimeSnapshot {
  instanceId: string;
  state: ServerProcessState;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number;
  error?: string;
}

/** 进程输出按实例递增编号，Renderer 可用编号补拉事件订阅前后的缺口。 */
export interface ServerConsoleLine {
  sequence: number;
  instanceId: string;
  stream: ServerConsoleStream;
  text: string;
  timestamp: string;
}

/** Agent 适配器使用的启动回执；日志序号与启动状态由 Host 在同一事务中生成。 */
export interface ServerRuntimeStartReceipt {
  readonly snapshot: ServerRuntimeSnapshot;
  readonly startedLogSequence: number;
}

/** Agent 适配器使用的安全停止回执。 */
export interface ServerRuntimeStopReceipt {
  readonly snapshot: ServerRuntimeSnapshot;
  readonly stopCommandLogSequence: number;
}

/** Agent 适配器使用的控制台命令回执。 */
export interface ServerRuntimeCommandReceipt {
  readonly accepted: true;
  readonly commandLogSequence: number;
}

/** Host 识别核心启动完成标志后返回的可序列化回执。 */
export interface ServerRuntimeReadyReceipt {
  readonly snapshot: ServerRuntimeSnapshot;
  readonly readyLogSequence: number;
  readonly readyAt: string;
  readonly readyMarker: string;
}

/** Host 完成进程退出与实例运行锁释放后返回的回执。 */
export interface ServerRuntimeStoppedReceipt {
  readonly snapshot: ServerRuntimeSnapshot;
}

/** Controller Agent 调用 Host 时使用的运行事务回执；Renderer 不暴露这组内部方法。 */
export const serverRuntimeAgentContract =
  defineServiceContract<ServerRuntimeAgentService>("seashard.server-runtime-agent");

/** Host 提供给 Controller Agent 适配层的服务器运行事务能力。 */
export interface ServerRuntimeAgentService {
  /**
   * 启动服务器并返回本次启动的日志边界。
   *
   * @param instanceId 已登记实例 ID。
   * @returns 启动状态与首条启动日志序号。
   */
  startWithReceipt(instanceId: string): Promise<ServerRuntimeStartReceipt>;
  /**
   * 请求安全停止并返回实际停止命令的日志边界。
   *
   * @param instanceId 已登记实例 ID。
   * @returns 停止状态与停止命令日志序号。
   */
  stopWithReceipt(instanceId: string): Promise<ServerRuntimeStopReceipt>;
  /**
   * 向服务器控制台写入命令并返回输入日志序号。
   *
   * @param instanceId 已登记实例 ID。
   * @param command 不带换行符的服务端命令。
   * @returns 已接受状态与命令日志序号。
   */
  sendCommandWithReceipt(
    instanceId: string,
    command: string,
  ): Promise<ServerRuntimeCommandReceipt>;
  /**
   * 等待核心输出启动完成标志。
   *
   * @param instanceId 已登记实例 ID。
   * @param timeoutMs 最长等待毫秒数。
   * @returns Host 识别到的启动完成回执。
   */
  waitUntilReady(instanceId: string, timeoutMs: number): Promise<ServerRuntimeReadyReceipt>;
  /**
   * 等待进程退出与实例运行锁释放。
   *
   * @param instanceId 已登记实例 ID。
   * @param timeoutMs 最长等待毫秒数。
   * @returns 释放完成后的运行状态。
   */
  waitUntilStoppedWithReceipt(
    instanceId: string,
    timeoutMs: number,
  ): Promise<ServerRuntimeStoppedReceipt>;
}

/** Host 侧服务器进程能力；仅启动实例元数据中明确声明且已实现运行策略的核心。 */
export interface ServerRuntimeService {
  /**
   * 解析实例当前将使用的 Java、工作目录和启动命令，不创建进程。
   *
   * @param instanceId 已登记实例 ID。
   * @param startupSettings 只用于本次预览的启动设置覆盖。
   * @returns 不包含凭据的启动命令投影。
   */
  preview(
    instanceId: string,
    startupSettings?: ServerInstanceStartupSettings,
  ): Promise<ServerLaunchCommandPreview>;
  /**
   * 读取单个实例的进程状态。
   *
   * @param instanceId 已登记实例 ID。
   * @returns 当前进程快照。
   */
  get(instanceId: string): Promise<ServerRuntimeSnapshot>;
  /**
   * 按实例元数据解析运行策略并启动服务端。
   *
   * @param instanceId 已登记实例 ID。
   * @returns 进入启动状态后的进程快照。
   */
  start(instanceId: string): Promise<ServerRuntimeSnapshot>;
  /**
   * 请求安全停止当前服务器进程。
   *
   * @param instanceId 已登记实例 ID。
   * @returns 结算后的进程快照。
   */
  stop(instanceId: string): Promise<ServerRuntimeSnapshot>;
  /**
   * 等待当前启动事务离开 starting；启动成功、启动失败或并发停止都会返回最终快照。
   *
   * @param instanceId 已登记实例 ID。
   * @param timeoutMs 最长等待毫秒数。
   * @returns 不再处于 starting 的当前进程快照。
   */
  waitUntilStartupSettled(instanceId: string, timeoutMs: number): Promise<ServerRuntimeSnapshot>;
  /**
   * 等待停止请求完成进程退出与运行资源释放。
   *
   * @param instanceId 已登记实例 ID。
   * @param timeoutMs 最长等待毫秒数。
   * @returns stopped 或 failed 的最终进程快照。
   */
  waitUntilStopped(instanceId: string, timeoutMs: number): Promise<ServerRuntimeSnapshot>;
  /**
   * 将一条控制台命令写入运行中服务端的标准输入。
   *
   * @param instanceId 已登记实例 ID。
   * @param command 不带换行符的服务端命令。
   */
  sendCommand(instanceId: string, command: string): Promise<void>;
  /**
   * 补拉指定序号之后的控制台输出。
   *
   * @param instanceId 已登记实例 ID。
   * @param afterSequence 已消费的最后一条序号；省略时读取当前保留窗口。
   * @returns 按 sequence 递增排列的控制台行。
   */
  getLogs(instanceId: string, afterSequence?: number): Promise<readonly ServerConsoleLine[]>;
}

/** Desktop Client 在请求式进程能力之外获得实时控制台事件。 */
export interface ServerRuntimeClientService extends ServerRuntimeService {
  onConsoleLine(listener: (line: ServerConsoleLine) => void): () => void;
}
