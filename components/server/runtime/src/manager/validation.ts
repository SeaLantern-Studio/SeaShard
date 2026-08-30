import {
  serverJvmArgumentsMaximumLength,
  serverPortLimits,
  type ServerInstanceSnapshot,
  type ServerInstanceStartupSettings,
  type ServerSettingsSnapshot,
} from "@seashard/contracts";

const maximumCommandLength = 32_768;

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

/** 将首次启动读取到的通用默认值转换为实例私有清单使用的稳定字段名。 */
export function createServerInstanceStartupSettings(
  defaults: ServerSettingsSnapshot,
): ServerInstanceStartupSettings {
  return {
    minimumMemoryMiB: defaults.defaultMinimumMemoryMiB,
    maximumMemoryMiB: defaults.defaultMaximumMemoryMiB,
    serverPort: defaults.defaultServerPort,
    autoAcceptEula: defaults.autoAcceptEula,
    jvmArguments: defaults.defaultJvmArguments,
  };
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

export function expectServerInstanceStartupSettings(value: unknown): ServerInstanceStartupSettings {
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

export function expectInstanceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new TypeError("server runtime instance id must be a plain identifier");
  }
  return value;
}

export function expectAfterSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("server console sequence must be a non-negative safe integer");
  }
  return value as number;
}

export function expectCommand(value: unknown): string {
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
