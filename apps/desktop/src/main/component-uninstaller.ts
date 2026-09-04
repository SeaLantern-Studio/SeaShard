import { spawn } from "node:child_process";
import { join } from "node:path";

export interface RegisterLinuxComponentUninstallerOptions {
  readonly resourcesPath: string;
  readonly controllerDataRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Linux 没有能同时覆盖 DEB 与 AppImage 的系统卸载入口。发行版 Desktop 在真实用户会话中
 * 登记统一卸载器，让它能够准确记录 AppImage 原路径，并在 Host 单独卸载后阻止自动重装。
 */
export async function registerLinuxComponentUninstaller(
  options: RegisterLinuxComponentUninstallerOptions,
): Promise<void> {
  const environment = options.environment ?? process.env;
  const appImagePath = environment.APPIMAGE;
  const packageType = appImagePath ? "appimage" : "deb";
  const script = join(options.resourcesPath, "uninstaller", "uninstall-seashard.sh");
  const arguments_ = [
    script,
    "--register-controller",
    packageType,
    appImagePath ?? "",
    options.controllerDataRoot,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn("/bin/sh", arguments_, {
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
      reject(
        new Error(
          errorOutput.trim() ||
            (signal
              ? `SeaShard 卸载器登记进程被信号 ${signal} 中止`
              : `SeaShard 卸载器登记进程退出码为 ${code ?? "unknown"}`),
        ),
      );
    });
  });
}
