import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { queryServerRuntime, stopServerRuntime, type ServerRuntimeHealth } from "./runtime-control";

const windowsTaskName = "SeaShard Server Controller";
const linuxUnitName = "seashard-server.service";
const serviceMetadataVersion = 1;

export interface ServerLaunchCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
}

export interface ServerServiceStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly health?: ServerRuntimeHealth;
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

type CommandRunner = (executable: string, arguments_: readonly string[]) => Promise<CommandResult>;

export interface ServerServiceManagerOptions {
  readonly dataRoot: string;
  readonly launch: ServerLaunchCommand;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly username?: string;
  readonly runCommand?: CommandRunner;
}

/**
 * 只登记当前用户会话中的后台服务。平台适配器拥有各自服务文件，Controller 用户数据不在
 * 清理范围内，因此卸载自启动不会碰触管理员账号、数据库、插件、日志或服务器实例。
 */
export class ServerControllerServiceManager {
  private readonly platform: NodeJS.Platform;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly homeDirectory: string;
  private readonly username: string;
  private readonly runCommand: CommandRunner;

  constructor(private readonly options: ServerServiceManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.username = options.username ?? userInfo().username;
    this.runCommand = options.runCommand ?? runCommand;
    if (this.platform !== "win32" && this.platform !== "linux") {
      throw new Error("Server Controller 后台服务当前只支持 Windows 和 Linux");
    }
  }

  async install(): Promise<void> {
    await mkdir(this.serviceRoot(), { recursive: true });
    if (this.platform === "win32") await this.installWindowsTask();
    else await this.installLinuxUnit();
    await this.writeMetadata();
    if (this.platform === "win32") await this.start();
  }

  async start(): Promise<void> {
    if (this.platform === "win32") {
      await requireSuccess(
        this.runCommand("schtasks.exe", ["/Run", "/TN", windowsTaskName]),
        "启动 Windows 后台任务失败",
      );
      return;
    }
    await requireSuccess(
      this.runCommand("systemctl", ["--user", "start", linuxUnitName]),
      "启动 systemd 用户服务失败",
    );
  }

  async stop(): Promise<void> {
    await stopServerRuntime(this.options.dataRoot).catch(() => false);
    if (this.platform === "win32") {
      await this.runCommand("schtasks.exe", ["/End", "/TN", windowsTaskName]);
      return;
    }
    await this.runCommand("systemctl", ["--user", "stop", linuxUnitName]);
  }

  async restart(): Promise<void> {
    if (this.platform === "win32") {
      await this.stop();
      await this.start();
      return;
    }
    await requireSuccess(
      this.runCommand("systemctl", ["--user", "restart", linuxUnitName]),
      "重启 systemd 用户服务失败",
    );
  }

  async status(): Promise<ServerServiceStatus> {
    const health = await queryServerRuntime(this.options.dataRoot);
    const installed =
      this.platform === "win32"
        ? (await this.runCommand("schtasks.exe", ["/Query", "/TN", windowsTaskName, "/FO", "CSV"]))
            .code === 0
        : (await this.runCommand("systemctl", ["--user", "is-enabled", "--quiet", linuxUnitName]))
            .code === 0;
    return {
      installed,
      running: Boolean(health),
      ...(health ? { health } : {}),
    };
  }

  async uninstall(): Promise<void> {
    await this.stop();
    if (this.platform === "win32") {
      await this.runCommand("schtasks.exe", ["/Delete", "/F", "/TN", windowsTaskName]);
    } else {
      await this.runCommand("systemctl", ["--user", "disable", "--now", linuxUnitName]);
      await rm(this.linuxUnitPath(), { force: true });
      await this.runCommand("systemctl", ["--user", "daemon-reload"]);
    }
    // service/ 只保存启动登记制品；Controller 的持久数据始终位于它的父目录。
    await rm(this.serviceRoot(), { recursive: true, force: true });
  }
  private async installWindowsTask(): Promise<void> {
    const launcherPath = join(this.serviceRoot(), "launch.cmd");
    const taskPath = join(this.serviceRoot(), "task.xml");
    await writeFile(launcherPath, createWindowsLauncher(this.options.launch), {
      encoding: "utf8",
      mode: 0o600,
    });
    const userId = await this.resolveWindowsUserId();
    await writeFile(
      taskPath,
      createWindowsTaskXml({
        launcherPath,
        workingDirectory: this.options.launch.workingDirectory,
        userId,
        commandInterpreter: this.environment.ComSpec ?? "cmd.exe",
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await requireSuccess(
      this.runCommand("schtasks.exe", ["/Create", "/F", "/TN", windowsTaskName, "/XML", taskPath]),
      "安装 Windows 登录任务失败",
    );
  }

  private async installLinuxUnit(): Promise<void> {
    const unitPath = this.linuxUnitPath();
    await mkdir(dirname(unitPath), { recursive: true });
    await writeFile(unitPath, createSystemdUserUnit(this.options.launch), {
      encoding: "utf8",
      mode: 0o600,
    });
    await requireSuccess(
      this.runCommand("systemctl", ["--user", "daemon-reload"]),
      "刷新 systemd 用户服务失败",
    );
    await requireSuccess(
      this.runCommand("systemctl", ["--user", "enable", "--now", linuxUnitName]),
      "启用 systemd 用户服务失败",
    );
  }

  private linuxUnitPath(): string {
    return join(
      this.environment.XDG_CONFIG_HOME ?? join(this.homeDirectory, ".config"),
      "systemd",
      "user",
      linuxUnitName,
    );
  }

  private serviceRoot(): string {
    const path = this.platform === "win32" ? win32 : posix;
    return path.join(this.options.dataRoot, "service");
  }

  private async resolveWindowsUserId(): Promise<string> {
    const result = await this.runCommand("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const sid = result.stdout.match(/"[^"]+","(S-[0-9-]+)"/u)?.[1];
    return sid ?? this.windowsUserId();
  }

  private windowsUserId(): string {
    const domain = this.environment.USERDOMAIN?.trim();
    return domain ? `${domain}\\${this.username}` : this.username;
  }

  private async writeMetadata(): Promise<void> {
    await writeFile(
      join(this.serviceRoot(), "installation.json"),
      `${JSON.stringify(
        {
          schemaVersion: serviceMetadataVersion,
          platform: this.platform,
          installedAt: new Date().toISOString(),
          launch: this.options.launch,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
}

export function createSystemdUserUnit(launch: ServerLaunchCommand): string {
  const command = [launch.executable, ...launch.arguments].map(quoteSystemdArgument).join(" ");
  return `[Unit]\nDescription=SeaShard Server Controller\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${quoteSystemdArgument(launch.workingDirectory)}\nExecStart=${command}\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=20s\nKillSignal=SIGTERM\n\n[Install]\nWantedBy=default.target\n`;
}

export function createWindowsLauncher(launch: ServerLaunchCommand): string {
  const command = [launch.executable, ...launch.arguments].map(quoteCmdArgument).join(" ");
  return `@echo off\r\n${command}\r\nexit /b %errorlevel%\r\n`;
}

export function createWindowsTaskXml(options: {
  readonly launcherPath: string;
  readonly workingDirectory: string;
  readonly userId: string;
  readonly commandInterpreter: string;
}): string {
  const commandArguments = `/d /s /c ""${options.launcherPath}""`;
  return `<?xml version="1.0" encoding="UTF-8"?>\r\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\r\n  <RegistrationInfo><Description>SeaShard Server Controller current-user service</Description></RegistrationInfo>\r\n  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${escapeXml(options.userId)}</UserId></LogonTrigger></Triggers>\r\n  <Principals><Principal id="Author"><UserId>${escapeXml(options.userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\r\n  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure></Settings>\r\n  <Actions Context="Author"><Exec><Command>${escapeXml(options.commandInterpreter)}</Command><Arguments>${escapeXml(commandArguments)}</Arguments><WorkingDirectory>${escapeXml(options.workingDirectory)}</WorkingDirectory></Exec></Actions>\r\n</Task>\r\n`;
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function requireSuccess(result: Promise<CommandResult>, message: string): Promise<void> {
  const completed = await result;
  if (completed.code === 0) return;
  const detail = completed.stderr.trim() || completed.stdout.trim();
  throw new Error(detail ? `${message}：${detail}` : message);
}

function quoteSystemdArgument(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n")}"`;
}

function quoteCmdArgument(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export async function readServiceMetadata(dataRoot: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dataRoot, "service", "installation.json"), "utf8"));
}
