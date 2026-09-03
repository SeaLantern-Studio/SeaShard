import {
  serverPlayerManagerContract,
  serverRuntimeContract,
  type ServerPlayerBanRequest,
  type ServerPlayerCatalog,
  type ServerPlayerIdentity,
  type ServerPlayerSnapshot,
  type ServerRuntimeService,
} from "@seashard/contracts";
import type { JsonValue, PluginManifest, PluginModule } from "@seashard/plugin-sdk";
import {
  serverInstanceManagerContract,
  type ServerInstanceManagerService,
} from "@seashard/server-instance-manager";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const maximumPlayerFileBytes = 2 * 1024 * 1024;

interface MinecraftPlayerRecord {
  readonly uuid: string;
  readonly name: string;
}

interface MinecraftBanRecord extends MinecraftPlayerRecord {
  readonly created: string;
  readonly source: string;
  readonly expires: string;
  readonly reason: string;
}

interface MinecraftOperatorRecord extends MinecraftPlayerRecord {
  readonly level?: number;
  readonly bypassesPlayerLimit?: boolean;
}

export const serverPlayerManagerManifest: PluginManifest = {
  id: "seashard.server-player-manager",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-player-manager.host",
      runtime: "host",
      execution: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [serverInstanceManagerContract, serverRuntimeContract],
    },
  ],
  compatibility: { seaShard: ">=0.0.0 <1.0.0" },
};

export function createServerPlayerManagerModule(): PluginModule {
  return {
    inject: [serverInstanceManagerContract, serverRuntimeContract],
    provides: [serverPlayerManagerContract],
    apply(context) {
      const manager = new ServerPlayerManager(
        context.service<ServerInstanceManagerService>(serverInstanceManagerContract),
        context.service<ServerRuntimeService>(serverRuntimeContract),
      );
      context.provide(serverPlayerManagerContract, {
        list: async (instanceId) => asJsonValue(await manager.list(instanceId)),
        setWhitelistEnabled: async (instanceId, enabled) =>
          asJsonValue(await manager.setWhitelistEnabled(instanceId, enabled)),
        setWhitelisted: async (instanceId, player, whitelisted) =>
          asJsonValue(await manager.setWhitelisted(instanceId, player, whitelisted)),
        setBanned: async (instanceId, player, banned) =>
          asJsonValue(await manager.setBanned(instanceId, player, banned)),
      });
    },
  };
}

/** Minecraft 原生 JSON 是事实源；实例运行时拒绝文件写入，避免服务端退出时覆盖管理结果。 */
export class ServerPlayerManager {
  constructor(
    private readonly instances: ServerInstanceManagerService,
    private readonly runtime: ServerRuntimeService,
  ) {}

  async list(instanceIdValue: unknown): Promise<ServerPlayerCatalog> {
    const instance = await this.findInstance(instanceIdValue);
    const [properties, cached, whitelisted, banned, operators] = await Promise.all([
      readOptionalText(resolve(instance.rootPath, "server.properties")),
      readPlayerRecords(resolve(instance.rootPath, "usercache.json")),
      readPlayerRecords(resolve(instance.rootPath, "whitelist.json")),
      readBanRecords(resolve(instance.rootPath, "banned-players.json")),
      readOperatorRecords(resolve(instance.rootPath, "ops.json")),
    ]);
    const players = new Map<string, ServerPlayerSnapshot>();
    const merge = (record: MinecraftPlayerRecord, patch: Partial<ServerPlayerSnapshot>) => {
      const key = normalizeUuid(record.uuid);
      const current = players.get(key);
      players.set(key, {
        uuid: key,
        name: record.name,
        whitelisted: current?.whitelisted ?? false,
        banned: current?.banned ?? false,
        operator: current?.operator ?? false,
        ...current,
        ...patch,
      });
    };
    for (const player of cached) merge(player, {});
    for (const player of whitelisted) merge(player, { whitelisted: true });
    for (const player of operators) merge(player, { operator: true });
    for (const player of banned) {
      merge(player, {
        banned: true,
        ...(player.reason ? { banReason: player.reason } : {}),
        ...(player.expires && player.expires !== "forever" ? { banExpiresAt: player.expires } : {}),
      });
    }
    return {
      instanceId: instance.id,
      whitelistEnabled: readBooleanProperty(properties, "white-list"),
      players: [...players.values()].sort((left, right) =>
        left.name.localeCompare(right.name, "zh-CN"),
      ),
    };
  }

  async setWhitelistEnabled(instanceIdValue: unknown, enabledValue: unknown) {
    const instance = await this.findInstance(instanceIdValue);
    const enabled = expectBoolean(enabledValue, "白名单启用状态");
    await this.assertStopped(instance.id, "修改白名单设置");
    const path = resolve(instance.rootPath, "server.properties");
    const current = await readOptionalText(path);
    await writeFile(path, setProperty(current, "white-list", String(enabled)), "utf8");
    return this.list(instance.id);
  }

  async setWhitelisted(instanceIdValue: unknown, playerValue: unknown, whitelistedValue: unknown) {
    const instance = await this.findInstance(instanceIdValue);
    const player = expectPlayerIdentity(playerValue);
    const whitelisted = expectBoolean(whitelistedValue, "白名单成员状态");
    await this.assertStopped(instance.id, "修改白名单成员");
    const path = resolve(instance.rootPath, "whitelist.json");
    const current = await readPlayerRecords(path);
    const next = withoutPlayer(current, player);
    if (whitelisted) next.push(player);
    await writeJsonArray(path, next);
    return this.list(instance.id);
  }

  async setBanned(instanceIdValue: unknown, playerValue: unknown, bannedValue: unknown) {
    const instance = await this.findInstance(instanceIdValue);
    const request = expectBanRequest(playerValue);
    const banned = expectBoolean(bannedValue, "封禁状态");
    await this.assertStopped(instance.id, "修改封禁名单");
    const path = resolve(instance.rootPath, "banned-players.json");
    const current = await readBanRecords(path);
    const next = withoutPlayer(current, request);
    if (banned) {
      next.push({
        uuid: request.uuid,
        name: request.name,
        created: minecraftTimestamp(new Date()),
        source: "SeaShard",
        expires: request.expiresAt ? minecraftTimestamp(new Date(request.expiresAt)) : "forever",
        reason: request.reason?.trim() || "Banned by SeaShard",
      });
    }
    await writeJsonArray(path, next);
    return this.list(instance.id);
  }

  private async findInstance(instanceIdValue: unknown) {
    const instanceId = expectIdentifier(instanceIdValue, "instanceId");
    const instance = (await this.instances.list()).find(({ id }) => id === instanceId);
    if (!instance) throw new Error(`找不到服务器实例：${instanceId}`);
    return instance;
  }

  private async assertStopped(instanceId: string, operation: string): Promise<void> {
    const snapshot = await this.runtime.get(instanceId);
    if (snapshot.state !== "stopped" && snapshot.state !== "failed") {
      throw new Error(`${operation}前必须先停止服务器。`);
    }
  }
}

async function readPlayerRecords(path: string): Promise<MinecraftPlayerRecord[]> {
  return (await readJsonArray(path, "玩家名单")).map((value) => {
    const record = expectRecord(value, "玩家记录");
    return expectPlayerIdentity(record);
  });
}

async function readBanRecords(path: string): Promise<MinecraftBanRecord[]> {
  return (await readJsonArray(path, "封禁名单")).map((value) => {
    const record = expectRecord(value, "封禁记录");
    return {
      ...expectPlayerIdentity(record),
      created: expectOptionalString(record.created) ?? "",
      source: expectOptionalString(record.source) ?? "",
      expires: expectOptionalString(record.expires) ?? "forever",
      reason: expectOptionalString(record.reason) ?? "",
    };
  });
}

async function readOperatorRecords(path: string): Promise<MinecraftOperatorRecord[]> {
  return (await readJsonArray(path, "管理员名单")).map((value) => {
    const record = expectRecord(value, "管理员记录");
    return {
      ...expectPlayerIdentity(record),
      ...(typeof record.level === "number" ? { level: record.level } : {}),
      ...(typeof record.bypassesPlayerLimit === "boolean"
        ? { bypassesPlayerLimit: record.bypassesPlayerLimit }
        : {}),
    };
  });
}

async function readJsonArray(path: string, label: string): Promise<unknown[]> {
  let text: string;
  try {
    const bytes = await readFile(path);
    if (bytes.length > maximumPlayerFileBytes) throw new Error(`${label}超过 2 MiB 限制。`);
    text = bytes.toString("utf8");
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label}不是有效的 JSON。`);
  }
  if (!Array.isArray(value)) throw new Error(`${label}根节点必须是数组。`);
  return value;
}

async function readOptionalText(path: string): Promise<string> {
  try {
    const bytes = await readFile(path);
    if (bytes.length > maximumPlayerFileBytes)
      throw new Error("server.properties 超过 2 MiB 限制。");
    return bytes.toString("utf8");
  } catch (error) {
    if (isMissingPathError(error)) return "";
    throw error;
  }
}

async function writeJsonArray(path: string, records: readonly object[]): Promise<void> {
  await writeFile(path, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

function withoutPlayer<T extends MinecraftPlayerRecord>(
  records: readonly T[],
  player: MinecraftPlayerRecord,
): T[] {
  const uuid = normalizeUuid(player.uuid);
  const name = player.name.toLocaleLowerCase("en-US");
  return records.filter(
    (record) =>
      normalizeUuid(record.uuid) !== uuid && record.name.toLocaleLowerCase("en-US") !== name,
  );
}

function expectPlayerIdentity(value: unknown): ServerPlayerIdentity {
  const record = expectRecord(value, "玩家身份");
  const name = record.name;
  if (typeof name !== "string" || !/^[A-Za-z0-9_]{1,16}$/u.test(name)) {
    throw new TypeError("玩家名称必须是 1～16 位字母、数字或下划线。");
  }
  return { uuid: normalizeUuid(record.uuid), name };
}

function expectBanRequest(value: unknown): ServerPlayerBanRequest {
  const record = expectRecord(value, "封禁请求");
  const identity = expectPlayerIdentity(record);
  const reason = expectOptionalString(record.reason);
  if (reason && reason.length > 256) throw new TypeError("封禁原因不能超过 256 个字符。");
  const expiresAt = expectOptionalString(record.expiresAt);
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw new TypeError("封禁到期时间必须是有效日期。");
  }
  return {
    ...identity,
    ...(reason ? { reason } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function normalizeUuid(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("玩家 UUID 无效。");
  const compact = value.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/u.test(compact)) throw new TypeError("玩家 UUID 无效。");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function expectOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function expectIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError(`${label} 无效。`);
  }
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值。`);
  return value;
}

function readBooleanProperty(content: string, key: string): boolean {
  let result = false;
  for (const line of content.split(/\r?\n/u)) {
    const match = /^\s*([^#!][^=:\s]*)\s*[=:]\s*(.*?)\s*$/u.exec(line);
    if (match?.[1] === key) result = match[2]?.toLowerCase() === "true";
  }
  return result;
}

function setProperty(content: string, key: string, value: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content ? content.split(/\r?\n/u) : [];
  let replaced = false;
  const next = lines.map((line) => {
    if (!new RegExp(`^\\s*${key}\\s*[=:]`, "u").test(line)) return line;
    replaced = true;
    return `${key}=${value}`;
  });
  if (!replaced) next.push(`${key}=${value}`);
  while (next.at(-1) === "") next.pop();
  return `${next.join(newline)}${newline}`;
}

function minecraftTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new TypeError("封禁到期时间必须是有效日期。");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second} +0000`;
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
