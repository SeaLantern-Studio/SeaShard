import {
  serverJvmArgumentsMaximumLength,
  serverPortLimits,
  type ServerInstanceStartupSettings,
} from "@seashard/contracts";

/** 同一套边界同时保护 IPC 输入和可移植清单读取，避免非法参数进入启动链路。 */
export function parseServerInstanceStartupSettings(
  value: unknown,
  label = "server instance startup settings",
): ServerInstanceStartupSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const minimumMemoryMiB = expectPositiveSafeInteger(
    record.minimumMemoryMiB,
    `${label} minimum memory`,
  );
  const maximumMemoryMiB = expectPositiveSafeInteger(
    record.maximumMemoryMiB,
    `${label} maximum memory`,
  );
  if (minimumMemoryMiB > maximumMemoryMiB) {
    throw new TypeError(`${label} minimum memory must not exceed maximum memory`);
  }
  const serverPort = expectPositiveSafeInteger(record.serverPort, `${label} server port`);
  if (serverPort < serverPortLimits.minimum || serverPort > serverPortLimits.maximum) {
    throw new TypeError(
      `${label} server port must be between ${serverPortLimits.minimum} and ${serverPortLimits.maximum}`,
    );
  }
  if (typeof record.autoAcceptEula !== "boolean") {
    throw new TypeError(`${label} auto accept EULA must be a boolean`);
  }
  if (
    typeof record.jvmArguments !== "string" ||
    record.jvmArguments.length > serverJvmArgumentsMaximumLength ||
    record.jvmArguments.includes("\0")
  ) {
    throw new TypeError(`${label} JVM arguments are invalid`);
  }
  return {
    minimumMemoryMiB,
    maximumMemoryMiB,
    serverPort,
    autoAcceptEula: record.autoAcceptEula,
    jvmArguments: record.jvmArguments,
  };
}

function expectPositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}
