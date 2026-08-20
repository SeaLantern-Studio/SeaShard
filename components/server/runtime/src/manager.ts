import {
  type JavaInstallationSnapshot,
  type ServerConsoleLine,
  type ServerConsoleStream,
  type ServerInstanceSnapshot,
  type ServerRuntimeSnapshot,
  type ServerSettingsSnapshot,
} from "@seashard/contracts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import {
  buildServerLaunchPlan,
  parseJvmArguments,
  selectJavaInstallation,
  type ServerLaunchPlan,
  type ServerPreparationPlan,
  type ServerPreparationDownloadPlan,
} from "./profiles";

const maximumConsoleLines = 5_000;
const maximumCommandLength = 32_768;
const defaultStopGracePeriodMs = 15_000;
const managedJavaToolOptions = [
  "-Dfile.encoding=UTF-8",
  "-Dsun.stdout.encoding=UTF-8",
  "-Dsun.stderr.encoding=UTF-8",
].join(" ");
const javaToolOptionsNoticePattern = /^Picked up JAVA_TOOL_OPTIONS:/u;
const utf8ConsoleDecoder = new TextDecoder("utf-8", { fatal: true });
const gb18030ConsoleDecoder = new TextDecoder("gb18030");

export type SpawnServerProcess = (
  command: string,
  arguments_: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
  },
) => ChildProcessWithoutNullStreams;

export type FetchPreparationArtifact = (url: string) => Promise<Uint8Array>;

export interface ServerRuntimeFileSystem {
  access(path: string): Promise<void>;
  copyFile(source: string, target: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeBinaryFile(path: string, content: Uint8Array): Promise<void>;
  writeTextFile(path: string, content: string): Promise<void>;
  hashFile(path: string, algorithm: "md5" | "sha256"): Promise<string>;
}

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

interface ActivePreparation {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
}

const defaultFileSystem: ServerRuntimeFileSystem = {
  access,
  copyFile,
  createDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  readTextFile: (path) => readFile(path, "utf8"),
  hashFile: hashFileStreaming,
  writeBinaryFile: (path, content) => writeFile(path, content),
  writeTextFile: (path, content) => writeFile(path, content, "utf8"),
};

/**
 * 管理已声明启动策略的服务器进程。
 *
 * 核心类型、版本和原始产物身份均来自下载阶段写入的实例元数据；启动阶段不扫描 JAR。
 */
export class ServerRuntimeManager {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly preparations = new Map<string, ActivePreparation>();
  private readonly snapshots = new Map<string, ServerRuntimeSnapshot>();
  private readonly logs = new Map<string, ConsoleLogState>();
  private readonly fileSystem: ServerRuntimeFileSystem;
  private readonly spawnProcess: SpawnServerProcess;
  private readonly stopGracePeriodMs: number;
  private readonly fetchPreparationArtifact: FetchPreparationArtifact;
  private disposed = false;
  private disposeTask?: Promise<void>;

  constructor(private readonly options: ServerRuntimeManagerOptions) {
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.fetchPreparationArtifact =
      options.fetchPreparationArtifact ?? defaultFetchPreparationArtifact;
    this.spawnProcess =
      options.spawnProcess ??
      ((command, arguments_, spawnOptions) =>
        spawn(command, [...arguments_], {
          ...spawnOptions,
          stdio: "pipe",
        }));
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
      await this.prepareInstallation(instanceId, java, plan);
      this.ensureActive();
      await this.prepareRuntimeFiles(plan, settings);
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
    this.disposeTask = Promise.all([this.disposeSessions(), this.disposePreparations()]).then(
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

  private async disposePreparations(): Promise<void> {
    await Promise.all(
      [...this.preparations.values()].map(async ({ child, closed }) => {
        child.kill();
        await closed;
      }),
    );
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

  /** 仅在安装哨兵不完整时执行上游安装器；正常启动不重复下载和修补。 */
  private async prepareInstallation(
    instanceId: string,
    java: JavaInstallationSnapshot,
    plan: ServerLaunchPlan,
  ): Promise<void> {
    const preparation = plan.preparation;
    if (!preparation) return;
    await this.preparePreparationInputs(instanceId, preparation);
    if (await this.isPreparationComplete(preparation)) {
      this.appendLine(instanceId, "system", `[SeaShard] ${preparation.description} 已准备完成。`);
      return;
    }

    this.appendLine(instanceId, "system", `[SeaShard] 正在准备 ${preparation.description}…`);
    const outcome = await this.runPreparationProcess(instanceId, java, preparation);
    this.ensureActive();
    const complete = await this.isPreparationComplete(preparation);
    if (!complete) {
      throw new Error(`${preparation.description} installer exited without complete runtime files`);
    }
    if (outcome.code !== 0 && !preparation.acceptNonZeroWithSentinels) {
      throw new Error(
        `${preparation.description} installer exited with code ${outcome.code ?? "unknown"}`,
      );
    }
    if (outcome.signal) {
      throw new Error(`${preparation.description} installer exited by signal ${outcome.signal}`);
    }
    this.appendLine(instanceId, "system", `[SeaShard] ${preparation.description} 准备完成。`);
  }

  /**
   * Forge 等复合核心的安装器不在核心目录清单中；先校验并补齐固定输入，
   * 再判断生成物是否完整，避免“已安装”实例漏装模组或重复运行安装器。
   */
  private async preparePreparationInputs(
    instanceId: string,
    preparation: ServerPreparationPlan,
  ): Promise<void> {
    for (const download of preparation.downloads ?? []) {
      this.ensureActive();
      const expectedSha256 = await this.resolveDownloadSha256(download);
      this.ensureActive();
      if (await this.hasExpectedSha256(download.path, expectedSha256)) continue;
      this.ensureActive();
      this.appendLine(
        instanceId,
        "system",
        `[SeaShard] 正在下载 ${preparation.description} 的安装依赖…`,
      );
      const content = await this.fetchPreparationArtifact(download.url);
      this.ensureActive();
      const actualSha256 = createHash("sha256").update(content).digest("hex");
      if (actualSha256 !== expectedSha256) {
        throw new Error(
          `${preparation.description} downloaded artifact failed SHA-256 verification`,
        );
      }
      await this.fileSystem.createDirectory(dirname(download.path));
      this.ensureActive();
      await this.fileSystem.writeBinaryFile(download.path, content);
      if (!(await this.hasExpectedSha256(download.path, expectedSha256))) {
        throw new Error(`${preparation.description} installer was not written intact`);
      }
    }

    for (const copy of preparation.copies ?? []) {
      this.ensureActive();
      const expectedSha256 =
        copy.sha256 === undefined
          ? await this.hashExistingFile(copy.source)
          : this.normalizeSha256(copy.sha256, copy.source);
      if (!(await this.hasExpectedSha256(copy.source, expectedSha256))) {
        throw new Error(`${preparation.description} source artifact failed SHA-256 verification`);
      }
      this.ensureActive();
      if (await this.hasExpectedSha256(copy.target, expectedSha256)) continue;
      this.ensureActive();
      await this.fileSystem.createDirectory(dirname(copy.target));
      this.ensureActive();
      await this.fileSystem.copyFile(copy.source, copy.target);
      if (!(await this.hasExpectedSha256(copy.target, expectedSha256))) {
        throw new Error(`${preparation.description} copied artifact failed SHA-256 verification`);
      }
    }
  }

  private async resolveDownloadSha256(download: ServerPreparationDownloadPlan): Promise<string> {
    if (download.sha256 !== undefined) {
      return this.normalizeSha256(download.sha256, download.path);
    }
    if (!download.sha256Url) {
      throw new Error(`preparation download ${download.url} is missing SHA-256 metadata`);
    }

    const cached = download.sha256Path
      ? await readOptionalText(this.fileSystem, download.sha256Path)
      : undefined;
    if (cached !== undefined) return this.normalizeSha256(cached, download.sha256Path!);

    const checksumBytes = await this.fetchPreparationArtifact(download.sha256Url);
    this.ensureActive();
    const checksum = this.normalizeSha256(
      new TextDecoder("utf-8", { fatal: true }).decode(checksumBytes),
      download.sha256Url,
    );
    if (download.sha256Path) {
      await this.fileSystem.createDirectory(dirname(download.sha256Path));
      this.ensureActive();
      await this.fileSystem.writeTextFile(download.sha256Path, `${checksum}\n`);
    }
    return checksum;
  }

  private normalizeSha256(value: string, source: string): string {
    const normalized = value.trim().split(/\s+/u)[0]?.toLowerCase();
    if (!normalized || !/^[a-f\d]{64}$/u.test(normalized)) {
      throw new Error(`invalid SHA-256 declared for preparation input ${source}`);
    }
    return normalized;
  }

  private async hashExistingFile(path: string): Promise<string> {
    await this.fileSystem.access(path);
    return (await this.fileSystem.hashFile(path, "sha256")).toLowerCase();
  }

  private async hasExpectedSha256(path: string, expectedSha256: string): Promise<boolean> {
    const normalized = this.normalizeSha256(expectedSha256, path);
    if (!(await canAccess(this.fileSystem, path))) return false;
    return (await this.fileSystem.hashFile(path, "sha256")).toLowerCase() === normalized;
  }

  private async runPreparationProcess(
    instanceId: string,
    java: JavaInstallationSnapshot,
    preparation: ServerPreparationPlan,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const child = this.spawnProcess(java.path, preparation.arguments, {
      cwd: preparation.workingDirectory,
      env: createJavaEnvironment(java),
      windowsHide: true,
    });
    const stdout = new ProcessLineDecoder((line) => this.appendLine(instanceId, "stdout", line));
    const stderr = new ProcessLineDecoder((line) => this.appendLine(instanceId, "stderr", line));
    child.stdout.on("data", (chunk: Buffer | string) => stdout.write(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.write(chunk));
    child.stdin.on("error", (error: Error) => {
      this.appendLine(instanceId, "stderr", `[SeaShard] 准备进程标准输入错误：${error.message}`);
      this.options.reportError?.(error);
    });
    child.on("error", (error) => {
      this.appendLine(instanceId, "stderr", `[SeaShard] 准备进程错误：${error.message}`);
      this.options.reportError?.(error);
    });

    let resolveClosed = (): void => {};
    const closed = new Promise<void>((resolvePreparation) => {
      resolveClosed = resolvePreparation;
    });
    const outcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveOutcome) => {
        child.once("close", (code, signal) => {
          stdout.end();
          stderr.end();
          resolveOutcome({ code, signal });
          resolveClosed();
        });
      },
    );
    const active: ActivePreparation = { child, closed };
    this.preparations.set(instanceId, active);

    try {
      await waitForSpawn(child);
      if (preparation.closeStdin) child.stdin.end();
      return await outcome;
    } catch (error) {
      child.kill();
      await closed;
      throw error;
    } finally {
      if (this.preparations.get(instanceId) === active) {
        this.preparations.delete(instanceId);
      }
    }
  }

  private async isPreparationComplete(preparation: ServerPreparationPlan): Promise<boolean> {
    for (const path of preparation.sentinels) {
      if (!(await canAccess(this.fileSystem, path))) return false;
    }
    if (
      preparation.runtimeArgumentFile &&
      !(await this.hasCompleteRuntimeArgumentFile(
        preparation.workingDirectory,
        preparation.runtimeArgumentFile,
      ))
    ) {
      return false;
    }
    return true;
  }

  /** Forge 新版使用 -jar shim，NeoForge 等版本使用 classpath；两种生成格式都按实际目标校验。 */
  private async hasCompleteRuntimeArgumentFile(
    workingDirectory: string,
    argumentFilePath: string,
  ): Promise<boolean> {
    const content = await readOptionalText(this.fileSystem, argumentFilePath);
    if (content === undefined) return false;
    const uncommented = content
      .replaceAll("\r\n", "\n")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    let arguments_: readonly string[];
    try {
      arguments_ = parseJvmArguments(uncommented);
    } catch {
      return false;
    }

    const classPathOption = arguments_.findIndex(
      (argument) => argument === "-cp" || argument === "-classpath" || argument === "--class-path",
    );
    const classPath = classPathOption < 0 ? undefined : arguments_[classPathOption + 1];
    if (classPath) {
      const separator = argumentFilePath.endsWith("win_args.txt") ? ";" : ":";
      for (const entry of classPath.split(separator).filter(Boolean)) {
        if (!(await canAccess(this.fileSystem, resolve(workingDirectory, entry)))) return false;
      }
      return true;
    }

    const jarOption = arguments_.findIndex((argument) => argument === "-jar");
    const jarPath = jarOption < 0 ? undefined : arguments_[jarOption + 1];
    return jarPath ? canAccess(this.fileSystem, resolve(workingDirectory, jarPath)) : false;
  }

  private async prepareRuntimeFiles(
    plan: ServerLaunchPlan,
    settings: ServerSettingsSnapshot,
  ): Promise<void> {
    for (const path of plan.requiredRuntimeFiles) await this.fileSystem.access(path);

    if (plan.jvmArgumentFile) {
      const current = await readOptionalText(this.fileSystem, plan.jvmArgumentFile.path);
      await this.fileSystem.writeTextFile(
        plan.jvmArgumentFile.path,
        updateManagedJvmArgumentFile(current ?? "", plan.jvmArgumentFile.managedArguments),
      );
    }
    if (plan.eula === "minecraft" && settings.autoAcceptEula) {
      const eulaPath = resolve(plan.workingDirectory, "eula.txt");
      const current = await readOptionalText(this.fileSystem, eulaPath);
      await this.fileSystem.writeTextFile(eulaPath, upsertProperty(current ?? "", "eula", "true"));
    }
    if (plan.writesServerProperties) {
      const propertiesPath = resolve(plan.workingDirectory, "server.properties");
      if ((await readOptionalText(this.fileSystem, propertiesPath)) === undefined) {
        await this.fileSystem.writeTextFile(
          propertiesPath,
          `server-port=${settings.defaultServerPort}\n`,
        );
      }
    }
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

class ProcessLineDecoder {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(private readonly emit: (line: string) => void) {}

  write(chunk: Buffer | string): void {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.pending = this.pending.length === 0 ? incoming : Buffer.concat([this.pending, incoming]);
    this.flushCompleteLines();
  }

  end(): void {
    if (this.pending.length > 0) this.emitBytes(this.pending);
    this.pending = Buffer.alloc(0);
  }

  private flushCompleteLines(): void {
    let lineStart = 0;
    for (let index = 0; index < this.pending.length; index += 1) {
      if (this.pending[index] !== 0x0a) continue;
      this.emitBytes(this.pending.subarray(lineStart, index));
      lineStart = index + 1;
    }
    if (lineStart > 0) this.pending = Buffer.from(this.pending.subarray(lineStart));
  }

  private emitBytes(bytes: Buffer): void {
    const content = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
    const line = normalizeProcessLine(decodeConsoleBytes(content));
    if (line !== undefined) this.emit(line);
  }
}

function decodeConsoleBytes(bytes: Buffer): string {
  if (bytes.length === 0) return "";
  try {
    return utf8ConsoleDecoder.decode(bytes);
  } catch {
    // 部分 Windows 核心及其子安装器仍直接向管道写入 GBK/GB18030。
    return gb18030ConsoleDecoder.decode(bytes);
  }
}

function normalizeProcessLine(text: string): string | undefined {
  const normalized = stripTerminalControlSequences(lastTerminalCarriageReturnFrame(text));
  return javaToolOptionsNoticePattern.test(normalized) ? undefined : normalized;
}

/**
 * 回车符会把终端光标移回当前行开头。进度条用它反复覆盖同一行，因此日志只保留最终帧，
 * 避免把 1% 到 100% 的所有刷新内容拼成一条超长文本。
 */
function lastTerminalCarriageReturnFrame(text: string): string {
  const lastCarriageReturn = text.lastIndexOf("\r");
  return lastCarriageReturn < 0 ? text : text.slice(lastCarriageReturn + 1);
}

/**
 * 移除终端标题（OSC）、颜色（CSI）和不可见控制字符，避免其进入 Renderer 标签解析。
 * 普通文本按 UTF-16 代码单元原样拼回，中文和代理对不会被改写。
 */
function stripTerminalControlSequences(text: string): string {
  let normalized = "";
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      const next = text.charCodeAt(index + 1);
      if (next === 0x5b) {
        index += 2;
        while (index < text.length) {
          const sequenceCode = text.charCodeAt(index);
          index += 1;
          if (sequenceCode >= 0x40 && sequenceCode <= 0x7e) break;
        }
        continue;
      }
      if (next === 0x5d) {
        index += 2;
        while (index < text.length) {
          const sequenceCode = text.charCodeAt(index);
          if (sequenceCode === 0x07) {
            index += 1;
            break;
          }
          if (sequenceCode === 0x1b && text.charCodeAt(index + 1) === 0x5c) {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += 1;
      continue;
    }
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      index += 1;
      continue;
    }
    normalized += text[index];
    index += 1;
  }
  return normalized;
}

function createJavaEnvironment(java: JavaInstallationSnapshot): NodeJS.ProcessEnv {
  const javaBin = dirname(java.path);
  const path = process.env.PATH;
  const existingJavaToolOptions = process.env.JAVA_TOOL_OPTIONS?.trim();
  return {
    ...process.env,
    JAVA_HOME: java.javaHome,
    JAVA_TOOL_OPTIONS: existingJavaToolOptions
      ? `${existingJavaToolOptions} ${managedJavaToolOptions}`
      : managedJavaToolOptions,
    PATH: path ? `${javaBin}${delimiter}${path}` : javaBin,
  };
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

async function readOptionalText(
  fileSystem: ServerRuntimeFileSystem,
  path: string,
): Promise<string | undefined> {
  try {
    return await fileSystem.readTextFile(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function upsertProperty(content: string, key: string, value: string): string {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const propertyPattern = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*=`,
    "u",
  );
  const updatedLines: string[] = [];
  let propertyWritten = false;
  for (const line of lines) {
    if (!propertyPattern.test(line)) {
      updatedLines.push(line);
      continue;
    }
    if (!propertyWritten) updatedLines.push(`${key}=${value}`);
    propertyWritten = true;
  }
  if (!propertyWritten) updatedLines.push(`${key}=${value}`);
  return `${updatedLines.join("\n")}\n`;
}

const managedJvmArgumentsBegin = "# >>> SeaShard managed JVM arguments";
const managedJvmArgumentsEnd = "# <<< SeaShard managed JVM arguments";

/** 保留安装器和用户注释，只接管活动的堆参数及 SeaShard 自己的参数块。 */
function updateManagedJvmArgumentFile(
  content: string,
  managedArguments: readonly string[],
): string {
  const sourceLines = content.replaceAll("\r\n", "\n").split("\n");
  const retained: string[] = [];
  let insideManagedBlock = false;
  for (const line of sourceLines) {
    if (line.trim() === managedJvmArgumentsBegin) {
      insideManagedBlock = true;
      continue;
    }
    if (line.trim() === managedJvmArgumentsEnd) {
      insideManagedBlock = false;
      continue;
    }
    if (insideManagedBlock || /^\s*-Xm[sx]\S*\s*$/iu.test(line)) continue;
    retained.push(line);
  }
  while (retained.at(-1) === "") retained.pop();
  if (retained.length > 0) retained.push("");
  retained.push(
    managedJvmArgumentsBegin,
    ...managedArguments.map(encodeJvmArgumentFileEntry),
    managedJvmArgumentsEnd,
  );
  return `${retained.join("\n")}\n`;
}

function encodeJvmArgumentFileEntry(argument: string): string {
  return /\s|"/u.test(argument)
    ? `"${argument.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : argument;
}

async function canAccess(fileSystem: ServerRuntimeFileSystem, path: string): Promise<boolean> {
  try {
    await fileSystem.access(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function hashFileStreaming(path: string, algorithm: "md5" | "sha256"): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash(algorithm);
    const input = createReadStream(path);
    input.once("error", rejectHash);
    input.on("data", (chunk: Buffer) => hash.update(chunk));
    input.once("end", () => resolveHash(hash.digest("hex")));
  });
}

async function defaultFetchPreparationArtifact(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download preparation artifact: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const handleSpawn = (): void => {
      child.off("error", handleError);
      resolveSpawn();
    };
    const handleError = (error: Error): void => {
      child.off("spawn", handleSpawn);
      rejectSpawn(error);
    };
    child.once("spawn", handleSpawn);
    child.once("error", handleError);
  });
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    Reflect.get(error, "code") === "ENOENT"
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
