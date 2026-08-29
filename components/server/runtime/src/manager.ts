import {
  serverJvmArgumentsMaximumLength,
  serverPortLimits,
  type JavaInstallationSnapshot,
  type ServerConsoleLine,
  type ServerConsoleStream,
  type ServerInstanceStartupSettings,
  type ServerLaunchCommandPreview,
  type ServerInstanceSnapshot,
  type ServerRuntimeSnapshot,
  type ServerSettingsSnapshot,
} from "@seashard/contracts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ProcessLineDecoder } from "./console-decoder";
import { defaultServerRuntimeFileSystem, type ServerRuntimeFileSystem } from "./filesystem";
import {
  createJavaEnvironment,
  defaultSpawnServerProcess,
  type SpawnServerProcess,
  waitForSpawn,
} from "./process";
import {
  defaultFetchPreparationArtifact,
  type FetchPreparationArtifact,
  ServerPreparationRunner,
} from "./preparation-runner";
import { buildServerLaunchPlan, selectJavaInstallation } from "./profiles";
import { prepareRuntimeFiles } from "./runtime-files";

const maximumConsoleLines = 5_000;
const maximumCommandLength = 32_768;
const defaultStopGracePeriodMs = 15_000;

export interface ServerRuntimeManagerOptions {
  listInstances(): Promise<readonly ServerInstanceSnapshot[]>;
  scanJavaInstallations(): Promise<readonly JavaInstallationSnapshot[]>;
  recordInstanceStartedAt?(instanceId: string, startedAt: string): Promise<void>;
  recordInstanceRuntime?(instanceId: string, startedAt: string, stoppedAt: string): Promise<void>;
  /** 在实例文件队列内登记服务器生命周期，令底层世界写操作能够原子判断运行状态。 */
  reserveInstanceRuntime?(instanceId: string): Promise<void>;
  /** 进程完全退出后释放实例生命周期登记。 */
  releaseInstanceRuntime?(instanceId: string): Promise<void>;
  readSettings(): Promise<ServerSettingsSnapshot>;
  onConsoleLine?(line: ServerConsoleLine): void;
  reportError?(error: unknown): void;
  spawnProcess?: SpawnServerProcess;
  fileSystem?: ServerRuntimeFileSystem;
  fetchPreparationArtifact?: FetchPreparationArtifact;
  now?: () => Date;
  stopGracePeriodMs?: number;
}

/** 启动回执把领域状态与对应的 system 日志序号绑定，调用方无需按文本反查日志。 */
export interface ServerRuntimeStartReceipt {
  readonly snapshot: ServerRuntimeSnapshot;
  readonly startedLogSequence: number;
}

/** 安全停止回执指向实际写入核心进程的结束命令。 */
export interface ServerRuntimeStopReceipt {
  readonly snapshot: ServerRuntimeSnapshot;
  readonly stopCommandLogSequence: number;
}

/** 控制台命令回执只在 stdin 写入成功并记录 input 日志后生成。 */
export interface ServerRuntimeCommandReceipt {
  readonly accepted: true;
  readonly commandLogSequence: number;
}

interface ConsoleLogState {
  nextSequence: number;
  lines: ServerConsoleLine[];
}

interface ActiveSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: ProcessLineDecoder;
  readonly stderr: ProcessLineDecoder;
  readonly closed: Promise<void>;
  readonly resolveClosed: () => void;
  readonly stopCommand: string;
  snapshot: ServerRuntimeSnapshot;
  forceStopTimer?: ReturnType<typeof setTimeout>;
  stdinFailure?: Error;
  stopCommandLogSequence?: number;
}

/** 单个实例保存的是完整设置组；存在时整体映射到运行组件现有的全局设置结构。 */
export function resolveServerRuntimeSettings(
  instance: ServerInstanceSnapshot,
  defaults: ServerSettingsSnapshot,
  override: ServerInstanceStartupSettings | undefined = instance.startupSettings,
): ServerSettingsSnapshot {
  if (!override) return defaults;
  return {
    ...defaults,
    defaultMinimumMemoryMiB: override.minimumMemoryMiB,
    defaultMaximumMemoryMiB: override.maximumMemoryMiB,
    defaultServerPort: override.serverPort,
    autoAcceptEula: override.autoAcceptEula,
    defaultJvmArguments: override.jvmArguments,
  };
}

/**
 * 管理已声明启动策略的服务器进程。
 *
 * 核心类型、版本和原始产物身份均来自下载阶段写入的实例元数据；启动阶段不扫描 JAR。
 */
export class ServerRuntimeManager {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly snapshots = new Map<string, ServerRuntimeSnapshot>();
  private readonly logs = new Map<string, ConsoleLogState>();
  private readonly instanceOperations = new Map<string, Promise<void>>();
  private readonly fileSystem: ServerRuntimeFileSystem;
  private readonly spawnProcess: SpawnServerProcess;
  private readonly preparationRunner: ServerPreparationRunner;
  private readonly stopGracePeriodMs: number;
  private disposed = false;
  private disposeTask?: Promise<void>;

  constructor(private readonly options: ServerRuntimeManagerOptions) {
    this.fileSystem = options.fileSystem ?? defaultServerRuntimeFileSystem;
    this.spawnProcess = options.spawnProcess ?? defaultSpawnServerProcess;
    this.preparationRunner = new ServerPreparationRunner({
      fileSystem: this.fileSystem,
      spawnProcess: this.spawnProcess,
      fetchArtifact: options.fetchPreparationArtifact ?? defaultFetchPreparationArtifact,
      ensureActive: () => this.ensureActive(),
      onLine: (instanceId, stream, text) => this.appendLine(instanceId, stream, text),
      ...(options.reportError
        ? { reportError: (error: unknown) => options.reportError!(error) }
        : {}),
    });
    this.stopGracePeriodMs = options.stopGracePeriodMs ?? defaultStopGracePeriodMs;
  }

  get(value: unknown): ServerRuntimeSnapshot {
    const instanceId = expectInstanceId(value);
    return { ...(this.snapshots.get(instanceId) ?? stoppedSnapshot(instanceId)) };
  }
  async preview(
    instanceValue: unknown,
    startupSettingsValue?: unknown,
  ): Promise<ServerLaunchCommandPreview> {
    this.ensureActive();
    const instanceId = expectInstanceId(instanceValue);
    const [instance, defaults, installations] = await Promise.all([
      this.findInstance(instanceId),
      this.options.readSettings(),
      this.options.scanJavaInstallations(),
    ]);
    this.ensureActive();
    const override =
      startupSettingsValue === undefined
        ? instance.startupSettings
        : expectServerInstanceStartupSettings(startupSettingsValue);
    const settings = resolveServerRuntimeSettings(instance, defaults, override);
    const plan = buildServerLaunchPlan(instance, settings);
    const java = selectJavaInstallation(installations, plan.java);
    return {
      instanceId,
      command: formatServerLaunchCommand(java.path, plan.arguments),
    };
  }

  getLogs(instanceValue: unknown, afterSequenceValue: unknown = 0): readonly ServerConsoleLine[] {
    const instanceId = expectInstanceId(instanceValue);
    const afterSequence = expectAfterSequence(afterSequenceValue);
    const state = this.logs.get(instanceId);
    if (!state) return [];
    return state.lines.filter((line) => line.sequence > afterSequence).map((line) => ({ ...line }));
  }

  async start(value: unknown): Promise<ServerRuntimeSnapshot> {
    return (await this.startWithReceipt(value)).snapshot;
  }

  /**
   * 执行一次完整启动并返回可继续追踪日志的稳定序号。
   * 普通 Service 仍只投影 snapshot，Agent 等需要关联日志的调用方使用该回执。
   */
  async startWithReceipt(value: unknown): Promise<ServerRuntimeStartReceipt> {
    this.ensureActive();
    const instanceId = expectInstanceId(value);
    return this.runInstanceOperation(instanceId, () => this.startInstanceWithReceipt(instanceId));
  }

  /**
   * 在同一实例的启动互斥区间内执行停机操作。
   * 已排队的启动会等待操作完成；已经先取得互斥权的启动则会令操作在写文件前失败。
   */
  async runWhileStopped<T>(value: unknown, operation: () => Promise<T>): Promise<T> {
    this.ensureActive();
    const instanceId = expectInstanceId(value);
    return this.runInstanceOperation(instanceId, async () => {
      this.ensureActive();
      if (isActiveState(this.get(instanceId).state)) {
        throw new Error("服务器正在运行，无法修改世界数据包。请先停止服务器后重试。");
      }
      return operation();
    });
  }

  private async startInstanceWithReceipt(instanceId: string): Promise<ServerRuntimeStartReceipt> {
    this.ensureActive();
    const current = this.snapshots.get(instanceId);
    if (current && isActiveState(current.state)) {
      throw new Error(`server instance ${instanceId} is already ${current.state}`);
    }
    let runtimeReserved = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      // 生命周期预留与 Instance Manager 的世界写入共享队列；先到达的一方完整执行。
      await this.options.reserveInstanceRuntime?.(instanceId);
      runtimeReserved = true;

      const startingSnapshot: ServerRuntimeSnapshot = { instanceId, state: "starting" };
      this.snapshots.set(instanceId, startingSnapshot);
      this.appendLine(instanceId, "system", "[SeaShard] 正在解析服务器核心启动策略…");

      const [instance, settings, installations] = await Promise.all([
        this.findInstance(instanceId),
        this.options.readSettings(),
        this.options.scanJavaInstallations(),
      ]);
      const effectiveSettings = resolveServerRuntimeSettings(instance, settings);
      // 异步扫描期间组件可能开始卸载；此后不得再写实例文件或创建新进程。
      this.ensureActive();
      const plan = buildServerLaunchPlan(instance, effectiveSettings);
      const java = selectJavaInstallation(installations, plan.java);
      await this.preparationRunner.prepare(instanceId, java, plan);
      this.ensureActive();
      await prepareRuntimeFiles(this.fileSystem, plan, effectiveSettings);
      const environment = createJavaEnvironment(java);

      child = this.spawnProcess(java.path, plan.arguments, {
        cwd: plan.workingDirectory,
        env: environment,
        windowsHide: true,
      });
      const session = this.createSession(instanceId, child, startingSnapshot, plan.stopCommand);
      this.sessions.set(instanceId, session);
      await waitForSpawn(child);
      if (this.sessions.get(instanceId) !== session) {
        throw new Error(`server instance ${instanceId} exited before startup completed`);
      }
      if (plan.eula === "interactive-minecraft" && effectiveSettings.autoAcceptEula) {
        // Banner 只从 stdin 接受严格小写 true；提前写入管道，由其到达 EULA 门后读取。
        await this.writeCommand(instanceId, session, "true");
        this.appendLine(instanceId, "input", "> true");
        this.appendLine(instanceId, "system", "[SeaShard] 已提交交互式 Minecraft EULA 同意。");
      }

      const startedAt = this.nowIso();
      const runningSnapshot: ServerRuntimeSnapshot = {
        instanceId,
        state: "running",
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        startedAt,
      };
      session.snapshot = runningSnapshot;
      this.snapshots.set(instanceId, runningSnapshot);
      const startedLine = this.appendLine(
        instanceId,
        "system",
        `[SeaShard] ${plan.displayName} 服务器进程已启动（Java ${java.version}）。`,
      );
      try {
        await this.options.recordInstanceStartedAt?.(instanceId, startedAt);
      } catch (error) {
        this.options.reportError?.(error);
      }
      return {
        snapshot: { ...runningSnapshot },
        startedLogSequence: startedLine.sequence,
      };
    } catch (error) {
      const session = child ? this.sessions.get(instanceId) : undefined;
      if (child && session?.child === child) {
        child.kill();
        await session.closed;
      }
      if (runtimeReserved) await this.releaseInstanceRuntime(instanceId);
      const message = errorMessage(error);
      const failedSnapshot: ServerRuntimeSnapshot = {
        instanceId,
        state: "failed",
        stoppedAt: this.nowIso(),
        error: message,
      };
      this.snapshots.set(instanceId, failedSnapshot);
      this.appendLine(instanceId, "stderr", `[SeaShard] 启动失败：${message}`);
      throw error;
    }
  }

  async stop(value: unknown): Promise<ServerRuntimeSnapshot> {
    return (await this.requestStop(value)).snapshot;
  }

  /** 返回安全停止命令对应的 input 日志序号，避免并发输出造成反查错位。 */
  async stopWithReceipt(value: unknown): Promise<ServerRuntimeStopReceipt> {
    const result = await this.requestStop(value);
    if (result.stopCommandLogSequence === undefined) {
      throw new Error(
        `server instance ${result.snapshot.instanceId} has no safe stop command receipt`,
      );
    }
    return {
      snapshot: result.snapshot,
      stopCommandLogSequence: result.stopCommandLogSequence,
    };
  }

  async sendCommand(instanceValue: unknown, commandValue: unknown): Promise<void> {
    await this.sendCommandWithReceipt(instanceValue, commandValue);
  }

  /** 命令写入与 input 日志在同一调用内完成，回执序号可直接作为后续日志游标。 */
  async sendCommandWithReceipt(
    instanceValue: unknown,
    commandValue: unknown,
  ): Promise<ServerRuntimeCommandReceipt> {
    this.ensureActive();
    const instanceId = expectInstanceId(instanceValue);
    const command = expectCommand(commandValue);
    const session = this.sessions.get(instanceId);
    if (!session || session.snapshot.state !== "running") {
      throw new Error(`server instance ${instanceId} is not accepting commands`);
    }
    await this.writeCommand(instanceId, session, command);
    const commandLine = this.appendLine(instanceId, "input", `> ${command}`);
    return {
      accepted: true,
      commandLogSequence: commandLine.sequence,
    };
  }

  /** 组件卸载必须等待运行进程安全停止，并终止仍在执行的安装器。 */
  dispose(): Promise<void> {
    if (this.disposeTask) return this.disposeTask;
    this.disposed = true;
    const pendingOperations = [...this.instanceOperations.values()];
    this.disposeTask = Promise.all([
      this.disposeSessions(),
      this.preparationRunner.dispose(),
      ...pendingOperations,
    ]).then(() => undefined);
    return this.disposeTask;
  }

  private async disposeSessions(): Promise<void> {
    const pendingSessions = [...this.sessions.entries()].map(async ([instanceId, session]) => {
      if (session.snapshot.state !== "stopping") {
        try {
          await this.requestSafeStop(instanceId, session);
        } catch {
          // 写入失败已经记录，并已转入强制终止；此处继续等待进程真正关闭。
        }
      }
      await session.closed;
    });
    await Promise.all(pendingSessions);
  }

  private async requestStop(value: unknown): Promise<{
    readonly snapshot: ServerRuntimeSnapshot;
    readonly stopCommandLogSequence?: number;
  }> {
    this.ensureActive();
    const instanceId = expectInstanceId(value);
    const session = this.sessions.get(instanceId);
    if (!session || !isActiveState(session.snapshot.state)) {
      throw new Error(`server instance ${instanceId} is not running`);
    }
    if (session.snapshot.state !== "stopping") {
      await this.requestSafeStop(instanceId, session);
    }
    return {
      snapshot: this.get(instanceId),
      ...(session.stopCommandLogSequence === undefined
        ? {}
        : { stopCommandLogSequence: session.stopCommandLogSequence }),
    };
  }

  private async requestSafeStop(instanceId: string, session: ActiveSession): Promise<void> {
    const stoppingSnapshot: ServerRuntimeSnapshot = {
      ...session.snapshot,
      state: "stopping",
    };
    session.snapshot = stoppingSnapshot;
    this.snapshots.set(instanceId, stoppingSnapshot);
    try {
      await this.writeCommand(instanceId, session, session.stopCommand);
    } catch (error) {
      this.forceTerminate(instanceId, session, "[SeaShard] 无法发送安全停止命令，正在终止进程。");
      throw error;
    }
    if (this.sessions.get(instanceId)?.child !== session.child) return;
    const stopCommandLine = this.appendLine(instanceId, "input", `> ${session.stopCommand}`);
    session.stopCommandLogSequence = stopCommandLine.sequence;
    this.appendLine(instanceId, "system", "[SeaShard] 已请求服务器安全停止。");
    this.armForceStop(instanceId, session);
  }

  private armForceStop(instanceId: string, session: ActiveSession): void {
    clearTimeout(session.forceStopTimer);
    session.forceStopTimer = setTimeout(() => {
      this.forceTerminate(
        instanceId,
        session,
        "[SeaShard] 服务器未在等待时间内退出，正在终止进程。",
      );
    }, this.stopGracePeriodMs);
    session.forceStopTimer.unref?.();
  }

  private forceTerminate(instanceId: string, session: ActiveSession, message: string): void {
    if (this.sessions.get(instanceId)?.child !== session.child) return;
    clearTimeout(session.forceStopTimer);
    this.appendLine(instanceId, "stderr", message);
    if (!session.child.kill()) {
      this.options.reportError?.(
        new Error(`failed to terminate server instance ${instanceId} process`),
      );
    }
  }

  private createSession(
    instanceId: string,
    child: ChildProcessWithoutNullStreams,
    snapshot: ServerRuntimeSnapshot,
    stopCommand: string,
  ): ActiveSession {
    const stdout = new ProcessLineDecoder((line) => this.appendLine(instanceId, "stdout", line));
    const stderr = new ProcessLineDecoder((line) => this.appendLine(instanceId, "stderr", line));
    let resolveClosed = (): void => {};
    const closed = new Promise<void>((resolveSession) => {
      resolveClosed = resolveSession;
    });
    const session: ActiveSession = {
      child,
      stdout,
      stderr,
      closed,
      resolveClosed,
      stopCommand,
      snapshot,
    };
    child.stdout.on("data", (chunk: Buffer | string) => stdout.write(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.write(chunk));
    child.stdin.on("error", (error: Error) => this.handleStdinError(instanceId, child, error));
    child.on("error", (error) => this.handleProcessError(instanceId, child, error));
    // close 在 stdout/stderr 已关闭后触发，能够保证最后一块无换行输出也被解码。
    child.once("close", (code, signal) => {
      void this.handleClose(instanceId, child, code, signal);
    });
    return session;
  }

  private async handleClose(
    instanceId: string,
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const session = this.sessions.get(instanceId);
    if (!session || session.child !== child) return;
    const closingSnapshot = session.snapshot;
    const expectedStop = closingSnapshot.state === "stopping" && !session.stdinFailure;
    if (closingSnapshot.state !== "stopping") {
      // close 后继续保留 session，令组件卸载等待累计时长和生命周期标记真正结算。
      session.snapshot = { ...closingSnapshot, state: "stopping" };
      this.snapshots.set(instanceId, session.snapshot);
    }

    try {
      session.stdout.end();
      session.stderr.end();
      clearTimeout(session.forceStopTimer);

      const state = session.stdinFailure
        ? "failed"
        : expectedStop || code === 0
          ? "stopped"
          : "failed";
      const message = session.stdinFailure
        ? `服务器进程因标准输入故障退出：${session.stdinFailure.message}`
        : signal
          ? `服务器进程因信号 ${signal} 退出。`
          : `服务器进程已退出，退出码 ${code ?? "未知"}。`;
      const stoppedAt = this.nowIso();
      const snapshot: ServerRuntimeSnapshot = {
        instanceId,
        state,
        ...(closingSnapshot.pid === undefined ? {} : { pid: closingSnapshot.pid }),
        ...(closingSnapshot.startedAt ? { startedAt: closingSnapshot.startedAt } : {}),
        stoppedAt,
        ...(code === null ? {} : { exitCode: code }),
        ...(state === "failed" ? { error: message } : {}),
      };

      if (closingSnapshot.startedAt && this.options.recordInstanceRuntime) {
        try {
          await this.options.recordInstanceRuntime(
            instanceId,
            closingSnapshot.startedAt,
            stoppedAt,
          );
        } catch (error) {
          this.options.reportError?.(error);
        }
      }

      // 先释放底层生命周期标记，再发布 stopped；读取到 stopped 的调用方随后一定可以取得写锁。
      await this.releaseInstanceRuntime(instanceId);
      this.snapshots.set(instanceId, snapshot);
      this.appendLine(
        instanceId,
        state === "failed" ? "stderr" : "system",
        `[SeaShard] ${message}`,
      );
    } catch (error) {
      await this.releaseInstanceRuntime(instanceId);
      this.options.reportError?.(error);
    } finally {
      if (this.sessions.get(instanceId) === session) {
        this.sessions.delete(instanceId);
      }
      session.resolveClosed();
    }
  }
  /** 生命周期释放失败时保持原始进程结算结果，并把底层同步故障交给统一诊断入口。 */
  private async releaseInstanceRuntime(instanceId: string): Promise<void> {
    try {
      await this.options.releaseInstanceRuntime?.(instanceId);
    } catch (error) {
      this.options.reportError?.(error);
    }
  }

  private handleProcessError(
    instanceId: string,
    child: ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    if (this.sessions.get(instanceId)?.child !== child) return;
    this.appendLine(instanceId, "stderr", `[SeaShard] 服务器进程错误：${error.message}`);
    this.options.reportError?.(error);
  }

  /** stdin 的 error 事件独立于 ChildProcess.error，必须消费以免 Electron Main 崩溃。 */
  private handleStdinError(
    instanceId: string,
    child: ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    const session = this.sessions.get(instanceId);
    if (!session || session.child !== child || session.stdinFailure) return;
    session.stdinFailure = error;
    const message = `服务器标准输入错误：${error.message}`;
    this.appendLine(instanceId, "stderr", `[SeaShard] ${message}`);
    this.options.reportError?.(error);
    if (session.snapshot.state !== "stopping") {
      session.snapshot = { ...session.snapshot, state: "stopping", error: message };
      this.snapshots.set(instanceId, session.snapshot);
      if (!child.kill()) {
        this.options.reportError?.(
          new Error(`failed to terminate server instance ${instanceId} after stdin failure`),
        );
      }
    }
  }

  private async findInstance(instanceId: string): Promise<ServerInstanceSnapshot> {
    const instance = (await this.options.listInstances()).find(
      (candidate) => candidate.id === instanceId,
    );
    if (!instance) throw new Error(`server instance ${instanceId} was not found`);
    return instance;
  }

  private async writeCommand(
    instanceId: string,
    session: ActiveSession,
    command: string,
  ): Promise<void> {
    if (session.stdinFailure) throw session.stdinFailure;
    if (session.child.stdin.destroyed || !session.child.stdin.writable) {
      const error = new Error("server process standard input is unavailable");
      this.handleStdinError(instanceId, session.child, error);
      throw error;
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      const failWrite = (error: Error): void => {
        this.handleStdinError(instanceId, session.child, error);
        rejectWrite(error);
      };
      try {
        session.child.stdin.write(`${command}\n`, (error) => {
          if (error) failWrite(error);
          else resolveWrite();
        });
      } catch (error) {
        failWrite(toError(error));
      }
    });
  }

  private appendLine(
    instanceId: string,
    stream: ServerConsoleStream,
    text: string,
  ): ServerConsoleLine {
    const state = this.logs.get(instanceId) ?? { nextSequence: 1, lines: [] };
    const line: ServerConsoleLine = {
      sequence: state.nextSequence++,
      instanceId,
      stream,
      text,
      timestamp: this.nowIso(),
    };
    state.lines.push(line);
    if (state.lines.length > maximumConsoleLines) {
      state.lines.splice(0, state.lines.length - maximumConsoleLines);
    }
    this.logs.set(instanceId, state);
    try {
      this.options.onConsoleLine?.({ ...line });
    } catch (error) {
      this.options.reportError?.(error);
    }
    return line;
  }

  /** 启动和停机文件事务共享同一实例队列，队列失败不会阻塞后续操作。 */
  private runInstanceOperation<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.instanceOperations.get(instanceId);
    const task = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation);
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.instanceOperations.set(instanceId, settled);
    return task.finally(() => {
      if (this.instanceOperations.get(instanceId) === settled) {
        this.instanceOperations.delete(instanceId);
      }
    });
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error("server runtime is stopped");
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

function stoppedSnapshot(instanceId: string): ServerRuntimeSnapshot {
  return { instanceId, state: "stopped" };
}

function isActiveState(state: ServerRuntimeSnapshot["state"]): boolean {
  return state === "starting" || state === "running" || state === "stopping";
}

/** spawn 不经过 Shell；这里按当前平台生成便于用户阅读和复制的等价命令。 */
export function formatServerLaunchCommand(
  executable: string,
  arguments_: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return [executable, ...arguments_]
    .map((argument) => quoteCommandArgument(argument, platform))
    .join(" ");
}

function quoteCommandArgument(argument: string, platform: NodeJS.Platform): string {
  if (argument && !/[\s"']/u.test(argument)) return argument;
  if (platform === "win32") return `"${argument.replaceAll('"', '\\"')}"`;
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

function expectServerInstanceStartupSettings(value: unknown): ServerInstanceStartupSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("server runtime startup settings must be an object");
  }
  const settings = value as Record<string, unknown>;
  const minimumMemoryMiB = expectPositiveInteger(settings.minimumMemoryMiB, "minimum memory");
  const maximumMemoryMiB = expectPositiveInteger(settings.maximumMemoryMiB, "maximum memory");
  const serverPort = expectPositiveInteger(settings.serverPort, "server port");
  if (minimumMemoryMiB > maximumMemoryMiB) {
    throw new TypeError("server runtime minimum memory must not exceed maximum memory");
  }
  if (serverPort < serverPortLimits.minimum || serverPort > serverPortLimits.maximum) {
    throw new TypeError("server runtime port is outside the allowed range");
  }
  if (typeof settings.autoAcceptEula !== "boolean") {
    throw new TypeError("server runtime auto accept EULA must be a boolean");
  }
  if (
    typeof settings.jvmArguments !== "string" ||
    settings.jvmArguments.length > serverJvmArgumentsMaximumLength ||
    settings.jvmArguments.includes("\0")
  ) {
    throw new TypeError("server runtime JVM arguments are invalid");
  }
  return {
    minimumMemoryMiB,
    maximumMemoryMiB,
    serverPort,
    autoAcceptEula: settings.autoAcceptEula,
    jvmArguments: settings.jvmArguments,
  };
}

function expectPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`server runtime ${label} must be a positive safe integer`);
  }
  return value as number;
}

function expectInstanceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new TypeError("server runtime instance id must be a plain identifier");
  }
  return value;
}

function expectAfterSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("server console sequence must be a non-negative safe integer");
  }
  return value as number;
}

function expectCommand(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("server command must be a string");
  const command = value.trim();
  if (
    !command ||
    command.length > maximumCommandLength ||
    command.includes("\0") ||
    command.includes("\r") ||
    command.includes("\n")
  ) {
    throw new TypeError("server command must be one non-empty line");
  }
  return command;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
