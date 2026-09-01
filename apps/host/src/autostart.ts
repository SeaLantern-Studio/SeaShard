import type { HostPackageType } from "@seashard/host-control";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

interface HostAutostartOptions {
  readonly dataRoot: string;
  readonly executablePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

/**
 * Host 与 Desktop 必须解析到同一个默认数据根。这里不依赖 Electron app.getPath，保证
 * 独立 Host App、AppImage 和系统包使用相同的服务器实例与控制端点。
 */
export function resolveDefaultHostDataRoot(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const platformPath = platform === "win32" ? win32 : posix;
  if (platform === "win32") {
    return platformPath.join(
      environment.APPDATA ?? platformPath.join(homeDirectory, "AppData", "Roaming"),
      "SeaShard",
      "core",
    );
  }
  if (platform === "darwin") {
    return platformPath.join(homeDirectory, "Library", "Application Support", "SeaShard", "core");
  }
  return platformPath.join(
    environment.XDG_CONFIG_HOME ?? platformPath.join(homeDirectory, ".config"),
    "SeaShard",
    "core",
  );
}

/**
 * 安装类型由 Host 的真实启动制品判断。Controller 只能消费这个结果，不能用自己的
 * 包格式代替 Host 做决定。
 */
export function resolveHostPackageType(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  executablePath = process.execPath,
  resourcesPath = process.resourcesPath,
): HostPackageType | undefined {
  const declared = environment.SEASHARD_HOST_PACKAGE_TYPE;
  if (declared === "appimage" || declared === "deb" || declared === "nsis" || declared === "pkg") {
    return declared;
  }
  if (platform === "win32") {
    return basename(executablePath).toLowerCase() === "seashardhost.exe" ? "nsis" : undefined;
  }
  if (platform === "darwin") {
    return basename(executablePath) === "SeaShardHost" ? "pkg" : undefined;
  }
  if (platform !== "linux") return undefined;
  if (environment.APPIMAGE || environment.SEASHARD_HOST_INSTALLED_EXECUTABLE) return "appimage";
  try {
    return readFileSync(join(resourcesPath, "package-type"), "utf8").trim() === "deb"
      ? "deb"
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * macOS PKG 和 Linux DEB 会在安装阶段登记启动项。直接运行 Host App 或 AppImage 时，
 * 这里补齐当前用户的启动登记；登记失败不应阻止 Host 接管已有服务器。
 */
export async function ensureStandaloneHostAutostart(options: HostAutostartOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const executablePath = options.executablePath ?? process.execPath;

  if (platform === "darwin") {
    const launchAgentPath = join(
      homeDirectory,
      "Library",
      "LaunchAgents",
      "studio.sealantern.seashard.host.plist",
    );
    await mkdir(dirname(launchAgentPath), { recursive: true });
    await writeFile(launchAgentPath, createLaunchAgent(executablePath, options.dataRoot), {
      encoding: "utf8",
      mode: 0o600,
    });
    return;
  }

  if (platform !== "linux") return;

  // Controller 首次安装和 AppImage 独立更新会把 AppImage 内容永久解包到稳定目录，
  // 并通过此变量把真实入口交给 Host。后续 XDG 启动不需要 FUSE。
  const managedExecutable = environment.SEASHARD_HOST_INSTALLED_EXECUTABLE;
  if (managedExecutable) {
    await writeLinuxAutostart(managedExecutable, options.dataRoot, environment, homeDirectory);
    return;
  }

  const appImagePath = environment.APPIMAGE;
  if (!appImagePath) return;

  // AppImage 可能从下载目录或临时挂载点启动；先复制到稳定位置，再登记 XDG 自动启动。
  const installationRoot = join(
    environment.XDG_DATA_HOME ?? join(homeDirectory, ".local", "share"),
    "SeaShard",
    "host",
  );
  const installedExecutable = join(installationRoot, "SeaShardHost.AppImage");
  await mkdir(installationRoot, { recursive: true });
  if (resolve(appImagePath) !== resolve(installedExecutable)) {
    const temporary = `${installedExecutable}.${process.pid}.tmp`;
    await copyFile(appImagePath, temporary, 0);
    await rm(installedExecutable, { force: true });
    await rename(temporary, installedExecutable);
  }
  await chmod(installedExecutable, 0o755);

  await writeLinuxAutostart(installedExecutable, options.dataRoot, environment, homeDirectory);
}

async function writeLinuxAutostart(
  executablePath: string,
  dataRoot: string,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): Promise<void> {
  const autostartPath = join(
    environment.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"),
    "autostart",
    "studio.sealantern.seashard.host.desktop",
  );
  await mkdir(dirname(autostartPath), { recursive: true });
  await writeFile(autostartPath, createDesktopAutostart(executablePath, dataRoot), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function createLaunchAgent(executablePath: string, dataRoot: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>studio.sealantern.seashard.host</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${escapeXml(executablePath)}</string>\n    <string>--data-root=${escapeXml(dataRoot)}</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n</dict>\n</plist>\n`;
}

function createDesktopAutostart(executablePath: string, dataRoot: string): string {
  return `[Desktop Entry]\nType=Application\nName=SeaShard Host\nComment=SeaShard background host runtime\nExec=${quoteDesktopArgument(executablePath)} ${quoteDesktopArgument(`--data-root=${dataRoot}`)}\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`;
}

function quoteDesktopArgument(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$")}"`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
