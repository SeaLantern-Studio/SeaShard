import {
  type JavaInstallationSnapshot,
  type ServerConsoleLine,
  type ServerConsoleStream,
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
  readSettings(): Promise<ServerSettingsSnapshot>;
  onConsoleLine?(line: ServerConsoleLine): void;
  reportError?(error: unknown): void;
  spawnProcess?: SpawnServerProcess;
  fileSystem?: ServerRuntimeFileSystem;
  fetchPreparationArtifact?: FetchPreparationArtifact;
  now?: () => Date;
  stopGracePeriodMs?: number;
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

  getLogs(instanceValue: unknown, afterSequenceValue: unknown = 0): readonly ServerConsoleLine[] {
    const instanceId = expectInstanceId(instanceValue);
    const afterSequence = expectAfterSequence(afterSequenceValue);
    const state = this.logs.get(instanceId);
    if (!state) return [];
    return state.lines.filter((line) => line.sequence > afterSequence).map((line) => ({ ...line }));
  }

  async start(value: unknown): Promise<ServerRuntimeSnapshot> {
    this.ensureActive();
    const instanceId = expectInstanceId(value);
    const current = this.snapshots.get(instanceId);
    if (current && isActiveState(current.state)) {
      throw new Error(`server instance ${instanceId} is already ${current.state}`);
    }

    const startingSnapshot: ServerRuntimeSnapshot = { instanceId, state: "starting" };
    this.snapshots.set(instanceId, startingSnapshot);
    this.appendLine(instanceId, "system", "[SeaShard] 正在解析服务器核心启动策略…");

    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      const [instance, settings, installations] = await Promise.all([
        this.findInstance(instanceId),
        this.options.readSettings(),
        this.options.scanJavaInstallations(),
      ]);
      // 异步扫描期间组件可能开始卸载；此后不得再写实例文件或创建新进程。
      this.ensureActive();
      const plan = buildServerLaunchPlan(instance, settings);
      const java = selectJavaInstallation(installations, plan.java);
      await this.preparationRunner.prepare(instanceId, java, plan);
      this.ensureActive();
      await prepareRuntimeFiles(this.fileSystem, plan, settings);
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
      if (plan.eula === "interactive-minecraft" && settings.autoAcceptEula) {
        // Banner 只从 stdin 接受严格小写 true；提前写入管道，由其到达 EULA 门后读取。
        await this.writeCommand(instanceId, session, "true");
        this.appendLine(instanceId, "input", "> true");
        this.appendLine(instanceId, "system", "[SeaShard] 已提交交互式 Minecraft EULA 同意。");
      }

      const runningSnapshot: ServerRuntimeSnapshot = {
        instanceId,
        state: "running",
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        startedAt: this.nowIso(),
      };
      session.snapshot = runningSnapshot;
      this.snapshots.set(instanceId, runningSnapshot);
      this.appendLine(
        instanceId,
        "system",
        `[SeaShard] ${plan.displayName} 服务器进程已启动（Java ${java.version}）。`,
      );
      return { ...runningSnapshot };
    } catch (error) {
      const session = child ? this.sessions.get(instanceId) : undefined;
      if (child && session?.child === child) {
        child.kill();
        await session.closed;
      }
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
    this.ensureActive();
    const instanceId = expectInstanceId(value);
    const session = this.sessions.get(instanceId);
    if (!session || !isActiveState(session.snapshot.state)) {
      throw new Error(`server instance ${instanceId} is not running`);
    }
    if (session.snapshot.state === "stopping") return { ...session.snapshot };

    await this.requestSafeStop(instanceId, session);
    return this.get(instanceId);
  }

  async sendCommand(instanceValue: unknown, commandValue: unknown): Promise<void> {
    this.ensureActive();
    const instanceId = expectInstanceId(instanceValue);
    const command = expectCommand(commandValue);
    const session = this.sessions.get(instanceId);
    if (!session || session.snapshot.state !== "running") {
      throw new Error(`server instance ${instanceId} is not accepting commands`);
    }
    await this.writeCommand(instanceId, session, command);
    if (this.sessions.get(instanceId)?.child === session.child) {
      this.appendLine(instanceId, "input", `> ${command}`);
    }
  }

  /** 组件卸载必须等待运行进程安全停止，并终止仍在执行的安装器。 */
  dispose(): Promise<void> {
    if (this.disposeTask) return this.disposeTask;
    this.disposed = true;
    this.disposeTask = Promise.all([this.disposeSessions(), this.preparationRunner.dispose()]).then(
      () => undefined,
    );
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
    this.appendLine(instanceId, "input", `> ${session.stopCommand}`);
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
    child.once("close", (code, signal) => this.handleClose(instanceId, child, code, signal));
    return session;
  }

  private handleClose(
    instanceId: string,
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const session = this.sessions.get(instanceId);
    if (!session || session.child !== child) return;
    try {
      session.stdout.end();
      session.stderr.end();
      clearTimeout(session.forceStopTimer);
      this.sessions.delete(instanceId);

      const expectedStop = session.snapshot.state === "stopping" && !session.stdinFailure;
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
      const snapshot: ServerRuntimeSnapshot = {
        instanceId,
        state,
        ...(session.snapshot.pid === undefined ? {} : { pid: session.snapshot.pid }),
        ...(session.snapshot.startedAt ? { startedAt: session.snapshot.startedAt } : {}),
        stoppedAt: this.nowIso(),
        ...(code === null ? {} : { exitCode: code }),
        ...(state === "failed" ? { error: message } : {}),
      };
      this.snapshots.set(instanceId, snapshot);
      this.appendLine(
        instanceId,
        state === "failed" ? "stderr" : "system",
        `[SeaShard] ${message}`,
      );
    } finally {
      session.resolveClosed();
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

  private appendLine(instanceId: string, stream: ServerConsoleStream, text: string): void {
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
