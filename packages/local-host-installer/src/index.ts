import { readHostControlDescriptor } from "@seashard/host-control";
import { readHostInstallation, type HostInstallationRecord } from "@seashard/host-installation";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

export interface InstallBundledMacHostOptions {
  readonly dataRoot: string;
  readonly installerPath: string;
  readonly installerType: "application" | "package";
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
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

/**
 * macOS 便携包携带 Host.app，可以在授权后直接放入 /Applications；npm 包则下载正式
 * Host PKG。两条路径最终都运行同一个 Host，并由 Host 自己登记 PKG 类型和 LaunchAgent。
 */
export async function installBundledMacHost(options: InstallBundledMacHostOptions): Promise<void> {
  const environment = options.environment ?? process.env;
  if (options.installerType === "package") {
    const defaultDataRoot = join(
      options.homeDirectory ?? homedir(),
      "Library",
      "Application Support",
      "SeaShard",
      "core",
    );
    if (resolve(options.dataRoot) !== resolve(defaultDataRoot)) {
      throw new Error("macOS Host PKG 只支持默认数据目录；自定义目录请使用随 Server 携带的 Host");
    }
    await runPrivilegedMacShellCommand(
      ["/usr/sbin/installer", "-pkg", options.installerPath, "-target", "/"]
        .map(quotePosixShellArgument)
        .join(" "),
      environment,
    );
    return;
  }

  const installedApplication = "/Applications/SeaShardHost.app";
  await runPrivilegedMacShellCommand(
    [
      `/bin/rm -rf -- ${quotePosixShellArgument(installedApplication)}`,
      `/usr/bin/ditto ${quotePosixShellArgument(options.installerPath)} ${quotePosixShellArgument(installedApplication)}`,
    ].join(" && "),
    environment,
  );
  await launchDetached(
    join(installedApplication, "Contents", "MacOS", "SeaShardHost"),
    [`--data-root=${options.dataRoot}`],
    environment,
  );
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

async function runPrivilegedMacShellCommand(
  command: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (process.getuid?.() === 0) {
    await launchInstallerAndWait("/bin/sh", ["-c", command], environment);
    return;
  }
  await launchInstallerAndWait(
    "/usr/bin/osascript",
    ["-e", `do shell script ${quoteAppleScriptString(command)} with administrator privileges`],
    environment,
  );
}

function launchDetached(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      detached: true,
      env: environment,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function quoteAppleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
