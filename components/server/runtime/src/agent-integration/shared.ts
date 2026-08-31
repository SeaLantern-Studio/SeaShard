import type {
  ServerConsoleLine,
  ServerInstanceSnapshot,
  ServerRuntimeSnapshot,
} from "@seashard/contracts";
import type { Awaitable, JsonObject, JsonValue } from "@seashard/plugin-sdk";
import type {
  ServerRuntimeCommandReceipt,
  ServerRuntimeReadyReceipt,
  ServerRuntimeStartReceipt,
  ServerRuntimeStoppedReceipt,
  ServerRuntimeStopReceipt,
  ServerRuntimeWaitOptions,
} from "../manager";

export const maximumAgentLineLength = 4_096;

export interface ServerRuntimeAgentRegistrationOptions {
  listInstances(): Promise<readonly ServerInstanceSnapshot[]>;
  getRuntime(instanceId: string): Awaitable<ServerRuntimeSnapshot>;
  getLogs(instanceId: string): Awaitable<readonly ServerConsoleLine[]>;
  start(instanceId: string): Promise<ServerRuntimeStartReceipt>;
  stop(instanceId: string): Promise<ServerRuntimeStopReceipt>;
  sendCommand(instanceId: string, command: string): Promise<ServerRuntimeCommandReceipt>;
  waitUntilReady(
    instanceId: string,
    options: ServerRuntimeWaitOptions,
  ): Promise<ServerRuntimeReadyReceipt>;
  waitUntilStopped(
    instanceId: string,
    options: ServerRuntimeWaitOptions,
  ): Promise<ServerRuntimeStoppedReceipt>;
}

export const jsonOutputProperty: JsonObject = {
  type: "boolean",
  default: false,
  description: "是否返回结构化 JSON；省略时返回便于直接阅读的英文文本。",
};

export const instanceIdProperty: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 257,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$",
  description: "服务器实例 ID；可先读取 server://instances 获取。",
};

export async function findInstance(
  options: ServerRuntimeAgentRegistrationOptions,
  instanceId: string,
): Promise<ServerInstanceSnapshot> {
  const instance = (await options.listInstances()).find((candidate) => candidate.id === instanceId);
  if (!instance) throw new Error(`server instance ${instanceId} was not found`);
  return instance;
}

export function expectObject(
  value: JsonValue,
  label: string,
  allowedKeys: readonly string[],
): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} input 必须是对象`);
  }
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unknownKey) throw new TypeError(`${label} 不支持参数 ${unknownKey}`);
  return value;
}

export function expectInstanceId(value: JsonValue | undefined): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$/u.test(value)
  ) {
    throw new TypeError("server runtime instance id must be a valid identifier");
  }
  return value;
}

export function readOptionalBoolean(
  value: JsonValue | undefined,
  label: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${label} 必须是布尔值`);
  return value;
}

export function truncateConsoleText(value: string): string {
  return value.length <= maximumAgentLineLength
    ? value
    : `${value.slice(0, maximumAgentLineLength - 1)}…`;
}

export function formatInstanceIdentity(value: JsonObject): string[] {
  return [
    `Server name: ${expectOutputString(value.name, "name")}`,
    `Instance ID: ${expectOutputString(value.instanceId, "instanceId")}`,
  ];
}

export function appendOptionalLine(
  lines: string[],
  label: string,
  value: JsonValue | undefined,
): void {
  if (typeof value === "string") lines.push(`${label}: ${value}`);
}

export function expectOutputString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new TypeError(`Agent 输出缺少 ${label}`);
  return value;
}

export function expectOutputNumber(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number") throw new TypeError(`Agent 输出缺少 ${label}`);
  return value;
}
