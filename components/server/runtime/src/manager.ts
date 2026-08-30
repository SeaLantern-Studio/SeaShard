import type {
  JavaInstallationSnapshot,
  ServerConsoleLine,
  ServerConsoleStream,
  ServerInstanceStartupSettings,
  ServerLaunchCommandPreview,
  ServerInstanceSnapshot,
  ServerRuntimeSnapshot,
  ServerSettingsSnapshot,
} from "@seashard/contracts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
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
import {
  captureSessionReadiness,
  createActiveSession,
  type ActiveSession,
} from "./manager/session";
import {
  waitForRuntimeEvent,
  type ServerRuntimeReadyReceipt,
  type ServerRuntimeStoppedReceipt,
  type ServerRuntimeWaitOptions,
} from "./manager/wait";
import {
  createServerInstanceStartupSettings,
  expectAfterSequence,
  expectCommand,
  expectInstanceId,
  expectServerInstanceStartupSettings,
  formatServerLaunchCommand,
  resolveServerRuntimeSettings,
} from "./manager/validation";
import { buildServerLaunchPlan, selectJavaInstallation } from "./profiles";
import { prepareRuntimeFiles } from "./runtime-files";

const maximumConsoleLines = 5_000;
const defaultStopGracePeriodMs = 15_000;

export interface ServerRuntimeManagerOptions {
  listInstances(): Promise<readonly ServerInstanceSnapshot[]>;
  scanJavaInstallations(): Promise<readonly JavaInstallationSnapshot[]>;
  /** 首次启动前固化通用默认值；已经固化或由用户保存的实例设置不得覆盖。 */
  ensureInstanceStartupSettings(
    instanceId: string,
    settings: ServerInstanceStartupSettings,
  ): Promise<ServerInstanceSnapshot>;
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

export type {
  ServerRuntimeReadyReceipt,
  ServerRuntimeStoppedReceipt,
  ServerRuntimeWaitOptions,
} from "./manager/wait";
export { formatServerLaunchCommand, resolveServerRuntimeSettings } from "./manager/validation";

interface ConsoleLogState {
  nextSequence: number;
  lines: ServerConsoleLine[];
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
   * 等待当前进程输出其核心协议对应的启动完成标志。
   * 匹配状态保存在 ActiveSession 中，因此不会把上一次运行残留的 Done 日志误认为本次已就绪。
   */
  async waitUntilReady(
    value: unknown,
    options: ServerRuntimeWaitOptions,
  ): Promise<ServerRuntimeReadyReceipt> {
    this.ensureActive();
    const instanceId = expectInstanceId(value);
    const session = this.sessions.get(instanceId);
    if (!session || session.snapshot.state !== "running") {
      throw new Error(`server instance ${instanceId} is not running`);
    }

    let readyLine = session.readyLine;
    if (!readyLine) {
      const outcome = await waitForRuntimeEvent(
        Promise.race([
          session.ready.then((line) => ({ kind: "ready", line }) as const),
          session.closed.then(() => ({ kind: "closed" }) as const),
        ]),
        options,
        `等待服务器 ${instanceId} 启动完成`,
      );
      readyLine = outcome.kind === "ready" ? outcome.line : session.readyLine;
      if (!readyLine) {
        const snapshot = this.get(instanceId);
        throw new Error(
          `server instance ${instanceId} exited before becoming ready (state: ${snapshot.state})`,
        );
      }
    }

    const snapshot = this.get(instanceId);
    if (this.sessions.get(instanceId) !== session || snapshot.state !== "running") {
      throw new Error(
        `server instance ${instanceId} stopped before the ready receipt was completed`,
      );
    }
    return {
      snapshot,
      readyLogSequence: readyLine.sequence,
      readyAt: readyLine.timestamp,
      readyMarker: readyLine.text,
    };
  }

  /**
   * 等待安全停止请求完成进程退出和实例生命周期释放。
   * 已结算的 stopped/failed 状态直接返回，便于 Agent 对重复等待保持幂等。
   */
  async waitUntilStopped(
    value: unknown,
    options: ServerRuntimeWaitOptions,
  ): Promise<ServerRuntimeStoppedReceipt> {
    this.ensureActive();
    const instanceId = expectInstanceId(value);
    const current = this.get(instanceId);
    if (isTerminalState(current.state)) return { snapshot: current };

    const session = this.sessions.get(instanceId);
    if (!session || current.state !== "stopping") {
      throw new Error(`server instance ${instanceId} has not been requested to stop`);
    }
    await waitForRuntimeEvent(session.closed, options, `等待服务器 ${instanceId} 完全停止`);
    const snapshot = this.get(instanceId);
    if (!isTerminalState(snapshot.state)) {
      throw new Error(`server instance ${instanceId} returned an incomplete stopped state`);
    }
    return { snapshot };
  }

  /**
   * 在同一实例的启动互斥区间内执行停机操作。
   * 已排队的启动会等待操作完成；已经先取得互斥权的启动则会令操作在写文件前失败。
   * action 由内部调用方提供具体中文动作，让 Agent 收到与本次工具一致的停机提示。
   */
  async runWhileStopped<T>(
    value: unknown,
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.ensureActive();
    const instanceId = expectInstanceId(value);
    return this.runInstanceOperation(instanceId, async () => {
      this.ensureActive();
      if (isActiveState(this.get(instanceId).state)) {
        throw new Error(`服务器正在运行，无法${action}。请先停止服务器后重试。`);
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

      const [discoveredInstance, settings, installations] = await Promise.all([
        this.findInstance(instanceId),
        this.options.readSettings(),
        this.options.scanJavaInstallations(),
      ]);
      let instance = discoveredInstance;
      let effectiveSettings = resolveServerRuntimeSettings(instance, settings);
      let plan = buildServerLaunchPlan(instance, effectiveSettings);
      let java = selectJavaInstallation(installations, plan.java);

      // 扫描和核心准备期间组件可能开始卸载；准备完成后才允许固化设置或创建新进程。
      this.ensureActive();
      await this.preparationRunner.prepare(instanceId, java, plan);
      this.ensureActive();
      if (!instance.startupSettings) {
        // 这是进程启动前的首次应用边界；固化成功后，通用设置变化不再影响该实例。
        instance = await this.options.ensureInstanceStartupSettings(
          instanceId,
          createServerInstanceStartupSettings(settings),
        );
        this.ensureActive();
        if (instance.id !== instanceId || !instance.startupSettings) {
          throw new Error(`server instance ${instanceId} did not persist startup settings`);
        }
        // ensure 可能保留并发先写入的用户设置，因此必须按最终实例快照重新生成启动计划。
        effectiveSettings = resolveServerRuntimeSettings(instance, settings);
        plan = buildServerLaunchPlan(instance, effectiveSettings);
        java = selectJavaInstallation(installations, plan.java);
      }
      await prepareRuntimeFiles(this.fileSystem, plan, effectiveSettings);
      const environment = createJavaEnvironment(java);

      child = this.spawnProcess(java.path, plan.arguments, {
        cwd: plan.workingDirectory,
        env: environment,
        windowsHide: true,
      });
      const session = createActiveSession(
        child,
        startingSnapshot,
        plan.serverType,
        plan.stopCommand,
        {
          onLine: (stream, text) => this.appendLine(instanceId, stream, text),
          onStdinError: (error) => this.handleStdinError(instanceId, child!, error),
          onProcessError: (error) => this.handleProcessError(instanceId, child!, error),
          onClose: (code, signal) => {
            void this.handleClose(instanceId, child!, code, signal);
          },
        },
      );
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
    const session = this.sessions.get(instanceId);
    if (session) captureSessionReadiness(session, stream, line);
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

function isTerminalState(state: ServerRuntimeSnapshot["state"]): boolean {
  return state === "stopped" || state === "failed";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
