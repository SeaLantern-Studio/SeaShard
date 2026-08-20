import { type JavaInstallationSnapshot, type ServerConsoleStream } from "@seashard/contracts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { ProcessLineDecoder } from "./console-decoder";
import { canAccess, readOptionalText, type ServerRuntimeFileSystem } from "./filesystem";
import { createJavaEnvironment, type SpawnServerProcess, waitForSpawn } from "./process";
import {
  parseJvmArguments,
  type ServerLaunchPlan,
  type ServerPreparationDownloadPlan,
  type ServerPreparationPlan,
} from "./profiles";

export type FetchPreparationArtifact = (url: string) => Promise<Uint8Array>;

interface ActivePreparation {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
}

interface ServerPreparationRunnerOptions {
  readonly fileSystem: ServerRuntimeFileSystem;
  readonly spawnProcess: SpawnServerProcess;
  readonly fetchArtifact: FetchPreparationArtifact;
  readonly ensureActive: () => void;
  readonly onLine: (instanceId: string, stream: ServerConsoleStream, text: string) => void;
  readonly reportError?: (error: unknown) => void;
}

/** 执行安装型核心的输入准备、安装器进程与生成物完整性校验。 */
export class ServerPreparationRunner {
  private readonly activePreparations = new Map<string, ActivePreparation>();

  constructor(private readonly options: ServerPreparationRunnerOptions) {}

  /** 仅在安装哨兵不完整时执行上游安装器；正常启动不重复下载和修补。 */
  async prepare(
    instanceId: string,
    java: JavaInstallationSnapshot,
    plan: ServerLaunchPlan,
  ): Promise<void> {
    const preparation = plan.preparation;
    if (!preparation) return;
    await this.preparePreparationInputs(instanceId, preparation);
    if (await this.isPreparationComplete(preparation)) {
      this.options.onLine(
        instanceId,
        "system",
        `[SeaShard] ${preparation.description} 已准备完成。`,
      );
      return;
    }

    this.options.onLine(instanceId, "system", `[SeaShard] 正在准备 ${preparation.description}…`);
    const outcome = await this.runPreparationProcess(instanceId, java, preparation);
    this.options.ensureActive();
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
    this.options.onLine(instanceId, "system", `[SeaShard] ${preparation.description} 准备完成。`);
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
      this.options.ensureActive();
      const expectedSha256 = await this.resolveDownloadSha256(download);
      this.options.ensureActive();
      if (await this.hasExpectedSha256(download.path, expectedSha256)) continue;
      this.options.ensureActive();
      this.options.onLine(
        instanceId,
        "system",
        `[SeaShard] 正在下载 ${preparation.description} 的安装依赖…`,
      );
      const content = await this.options.fetchArtifact(download.url);
      this.options.ensureActive();
      const actualSha256 = createHash("sha256").update(content).digest("hex");
      if (actualSha256 !== expectedSha256) {
        throw new Error(
          `${preparation.description} downloaded artifact failed SHA-256 verification`,
        );
      }
      await this.options.fileSystem.createDirectory(dirname(download.path));
      this.options.ensureActive();
      await this.options.fileSystem.writeBinaryFile(download.path, content);
      if (!(await this.hasExpectedSha256(download.path, expectedSha256))) {
        throw new Error(`${preparation.description} installer was not written intact`);
      }
    }

    for (const copy of preparation.copies ?? []) {
      this.options.ensureActive();
      const expectedSha256 =
        copy.sha256 === undefined
          ? await this.hashExistingFile(copy.source)
          : this.normalizeSha256(copy.sha256, copy.source);
      if (!(await this.hasExpectedSha256(copy.source, expectedSha256))) {
        throw new Error(`${preparation.description} source artifact failed SHA-256 verification`);
      }
      this.options.ensureActive();
      if (await this.hasExpectedSha256(copy.target, expectedSha256)) continue;
      this.options.ensureActive();
      await this.options.fileSystem.createDirectory(dirname(copy.target));
      this.options.ensureActive();
      await this.options.fileSystem.copyFile(copy.source, copy.target);
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
      ? await readOptionalText(this.options.fileSystem, download.sha256Path)
      : undefined;
    if (cached !== undefined) return this.normalizeSha256(cached, download.sha256Path!);

    const checksumBytes = await this.options.fetchArtifact(download.sha256Url);
    this.options.ensureActive();
    const checksum = this.normalizeSha256(
      new TextDecoder("utf-8", { fatal: true }).decode(checksumBytes),
      download.sha256Url,
    );
    if (download.sha256Path) {
      await this.options.fileSystem.createDirectory(dirname(download.sha256Path));
      this.options.ensureActive();
      await this.options.fileSystem.writeTextFile(download.sha256Path, `${checksum}\n`);
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
    await this.options.fileSystem.access(path);
    return (await this.options.fileSystem.hashFile(path, "sha256")).toLowerCase();
  }

  private async hasExpectedSha256(path: string, expectedSha256: string): Promise<boolean> {
    const normalized = this.normalizeSha256(expectedSha256, path);
    if (!(await canAccess(this.options.fileSystem, path))) return false;
    return (await this.options.fileSystem.hashFile(path, "sha256")).toLowerCase() === normalized;
  }

  private async runPreparationProcess(
    instanceId: string,
    java: JavaInstallationSnapshot,
    preparation: ServerPreparationPlan,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const child = this.options.spawnProcess(java.path, preparation.arguments, {
      cwd: preparation.workingDirectory,
      env: createJavaEnvironment(java),
      windowsHide: true,
    });
    const stdout = new ProcessLineDecoder((line) =>
      this.options.onLine(instanceId, "stdout", line),
    );
    const stderr = new ProcessLineDecoder((line) =>
      this.options.onLine(instanceId, "stderr", line),
    );
    child.stdout.on("data", (chunk: Buffer | string) => stdout.write(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.write(chunk));
    child.stdin.on("error", (error: Error) => {
      this.options.onLine(
        instanceId,
        "stderr",
        `[SeaShard] 准备进程标准输入错误：${error.message}`,
      );
      this.options.reportError?.(error);
    });
    child.on("error", (error) => {
      this.options.onLine(instanceId, "stderr", `[SeaShard] 准备进程错误：${error.message}`);
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
    this.activePreparations.set(instanceId, active);

    try {
      await waitForSpawn(child);
      if (preparation.closeStdin) child.stdin.end();
      return await outcome;
    } catch (error) {
      child.kill();
      await closed;
      throw error;
    } finally {
      if (this.activePreparations.get(instanceId) === active) {
        this.activePreparations.delete(instanceId);
      }
    }
  }

  private async isPreparationComplete(preparation: ServerPreparationPlan): Promise<boolean> {
    for (const path of preparation.sentinels) {
      if (!(await canAccess(this.options.fileSystem, path))) return false;
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
    const content = await readOptionalText(this.options.fileSystem, argumentFilePath);
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
        if (!(await canAccess(this.options.fileSystem, resolve(workingDirectory, entry))))
          return false;
      }
      return true;
    }

    const jarOption = arguments_.findIndex((argument) => argument === "-jar");
    const jarPath = jarOption < 0 ? undefined : arguments_[jarOption + 1];
    return jarPath ? canAccess(this.options.fileSystem, resolve(workingDirectory, jarPath)) : false;
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.activePreparations.values()].map(async ({ child, closed }) => {
        child.kill();
        await closed;
      }),
    );
  }
}

export async function defaultFetchPreparationArtifact(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download preparation artifact: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
