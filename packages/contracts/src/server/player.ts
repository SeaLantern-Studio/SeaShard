import { defineServiceContract } from "@seashard/plugin-sdk";

export const serverPlayerManagerContract = defineServiceContract<ServerPlayerManagerService>(
  "seashard.server-player-manager",
);

export interface ServerPlayerIdentity {
  readonly uuid: string;
  readonly name: string;
}

export interface ServerPlayerSnapshot extends ServerPlayerIdentity {
  readonly whitelisted: boolean;
  readonly banned: boolean;
  readonly operator: boolean;
  readonly lastSeenAt?: string;
  readonly banReason?: string;
  readonly banExpiresAt?: string;
}

export interface ServerPlayerCatalog {
  readonly instanceId: string;
  readonly whitelistEnabled: boolean;
  readonly players: readonly ServerPlayerSnapshot[];
}

export interface ServerPlayerBanRequest extends ServerPlayerIdentity {
  readonly reason?: string;
  readonly expiresAt?: string;
}

/** 玩家名单从 Minecraft 自己的 JSON 文件读取；写操作仅在实例停止时执行。 */
export interface ServerPlayerManagerService {
  /**
   * 读取 Minecraft 玩家名单与白名单开关。
   *
   * @param instanceId 已登记实例 ID。
   * @returns 合并白名单、封禁和管理员文件后的玩家目录。
   */
  list(instanceId: string): Promise<ServerPlayerCatalog>;
  /**
   * 修改 server.properties 中的白名单开关。
   *
   * @param instanceId 已登记实例 ID。
   * @param enabled 是否启用白名单。
   * @returns 写入后的完整玩家目录。
   */
  setWhitelistEnabled(instanceId: string, enabled: boolean): Promise<ServerPlayerCatalog>;
  /**
   * 添加或移除一条白名单记录。
   *
   * @param instanceId 已登记实例 ID。
   * @param player 玩家 UUID 与名称。
   * @param whitelisted true 表示加入，false 表示移除。
   * @returns 写入后的完整玩家目录。
   */
  setWhitelisted(
    instanceId: string,
    player: ServerPlayerIdentity,
    whitelisted: boolean,
  ): Promise<ServerPlayerCatalog>;
  /**
   * 添加或移除一条玩家封禁记录。
   *
   * @param instanceId 已登记实例 ID。
   * @param player 玩家身份以及可选的封禁原因和期限。
   * @param banned true 表示封禁，false 表示解封。
   * @returns 写入后的完整玩家目录。
   */
  setBanned(
    instanceId: string,
    player: ServerPlayerBanRequest,
    banned: boolean,
  ): Promise<ServerPlayerCatalog>;
}
