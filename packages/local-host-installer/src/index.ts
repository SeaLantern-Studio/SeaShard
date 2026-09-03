import { readHostControlDescriptor } from "@seashard/host-control";
import { readHostInstallation, type HostInstallationRecord } from "@seashard/host-installation";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const defaultReadyTimeoutMilliseconds = 60_000;
const defaultReadyPollMilliseconds = 100;

export interface EnsureLocalHostInstallationOptions {
  readonly dataRoot: string;
  readonly install: () => Promise<void>;
  readonly readyTimeoutMilliseconds?: number;
  readonly readyPollMilliseconds?: number;
}

export interface LocalHostInstallationResult {
  readonly disposition: "existing" | "installed";
  readonly installation: HostInstallationRecord;
}

export interface InstallBundledLinuxHostOptions {
  readonly dataRoot: string;
  readonly hostImage: string;
  readonly installScript: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface InstallBundledWindowsHostOptions {
  readonly dataRoot: string;
  readonly installerPath: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Controller 产品在启动自己的 Host 安装器前统一经过这里判断。已经存在的独立 Host
 * 原样保留；真正执行安装后同时等待安装记录与控制端点，调用方随后可以直接连接。
 */
export async function ensureLocalHostInstallation(
  options: EnsureLocalHostInstallationOptions,
): Promise<LocalHostInstallationResult> {
  const existing = await readHostInstallation(options.dataRoot);
  if (existing) return { disposition: "existing", installation: existing };

  await options.install();
  const installation = await waitForInstalledHost(
    options.dataRoot,
    options.readyTimeoutMilliseconds ?? defaultReadyTimeoutMilliseconds,
    options.readyPollMilliseconds ?? defaultReadyPollMilliseconds,
  );
  return { disposition: "installed", installation };
}

/** Linux Controller 统一使用用户级 AppImage 安装脚本，保持 Desktop 已验证过的安装行为。 */
export async function installBundledLinuxHost(
  options: InstallBundledLinuxHostOptions,
): Promise<void> {
  const hostImage = await prepareExecutableHostImage(options.hostImage);
  try {
    await launchInstallerAndWait("/bin/sh", [options.installScript, hostImage.path], {
      ...(options.environment ?? process.env),
      SEASHARD_HOST_DATA_DIR: options.dataRoot,
    });
  } finally {
    await hostImage.dispose().catch(() => undefined);
  }
}

/** Windows Controller 统一静默启动独立 Host NSIS，并把当前用户的数据目录传给它。 */
export function installBundledWindowsHost(
  options: InstallBundledWindowsHostOptions,
): Promise<void> {
  return launchInstallerAndWait(options.installerPath, ["/S"], {
    ...(options.environment ?? process.env),
    SEASHARD_HOST_INSTALL_DATA_ROOT: options.dataRoot,
  });
}

async function waitForInstalledHost(
  dataRoot: string,
  timeoutMilliseconds: number,
  pollMilliseconds: number,
): Promise<HostInstallationRecord> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const [installation, descriptor] = await Promise.all([
      readHostInstallation(dataRoot),
      readHostControlDescriptor(dataRoot),
    ]);
    if (installation && descriptor) return installation;
    await delay(pollMilliseconds);
  }
  throw new Error(`SeaShard Host 安装完成后未能启动：${dataRoot}`);
}

interface PreparedHostImage {
  readonly path: string;
  dispose(): Promise<void>;
}

async function prepareExecutableHostImage(path: string): Promise<PreparedHostImage> {
  const metadata = await stat(path);
  if ((metadata.mode & 0o111) !== 0) return { path, dispose: async () => undefined };

  // 外层 AppImage 可能位于只读 SquashFS。仅在执行位缺失时复制到临时目录，避免无意义的
  // 大文件复制；安装脚本会把解包后的真实 Runtime 放到稳定用户目录。
  const temporaryRoot = await mkdtemp(join(tmpdir(), "seashard-host-installer-"));
  const temporaryImage = join(temporaryRoot, "SeaShardHostSetup.AppImage");
  try {
    await copyFile(path, temporaryImage);
    await chmod(temporaryImage, 0o755);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    path: temporaryImage,
    dispose: () => rm(temporaryRoot, { recursive: true, force: true }),
  };
}

function launchInstallerAndWait(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorOutput = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-16_384);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = errorOutput.trim();
      reject(
        new Error(
          detail ||
            (signal
              ? `本机 Host 安装器被信号 ${signal} 中止`
              : `本机 Host 安装器退出码为 ${code ?? "unknown"}`),
        ),
      );
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
