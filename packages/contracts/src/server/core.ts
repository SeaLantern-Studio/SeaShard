/** 服务端核心源面向 Client 的只读 Contract；Host 完整类型由核心源组件关联。 */
export const serverCoreSourceContract = "seashard.server-core-source";
/** Renderer 通过受限本地协议读取已经校验并落盘的核心图标。 */
export const serverCoreIconScheme = "seashard-cache";
export const serverCoreIconHost = "server-core-icon";
/** Renderer 通过受限本地协议读取已复制到实例目录的服务器图标。 */
export const serverInstanceIconHost = "server-instance-icon";
/** Renderer 只通过该协议读取当前激活且摘要匹配的第三方 Client 插件资源。 */
export const clientPluginAssetScheme = "seashard-plugin";
/** Renderer 可安全读取的服务端核心类型；图标地址只指向 Host 本地缓存协议。 */
export interface ServerCoreType {
  id: string;
  iconUrl?: string;
}
const serverCoreTypeNames: Readonly<Record<string, string>> = {
  "arclight-fabric": "Arclight Fabric",
  "arclight-forge": "Arclight Forge",
  "arclight-neoforge": "Arclight NeoForge",
  banner: "Banner",
  bukkit: "Bukkit",
  bungeecord: "BungeeCord",
  catserver: "CatServer",
  fabric: "Fabric",
  folia: "Folia",
  leaf: "Leaf",
  leaves: "Leaves",
  lightfall: "Lightfall",
  mohist: "Mohist",
  neoforge: "NeoForge",
  nukkitx: "NukkitX",
  paper: "Paper",
  pufferfish: "Pufferfish",
  pufferfish_purpur: "Pufferfish Purpur",
  purpur: "Purpur",
  quilt: "Quilt",
  spigot: "Spigot",
  spongeforge: "SpongeForge",
  spongevanilla: "SpongeVanilla",
  travertine: "Travertine",
  vanilla: "原版核心",
  "vanilla-snapshot": "原版快照",
  velocity: "Velocity",
  youer: "Youer",
};

/** 核心目录、实例页和运行页共享同一显示名称，未知类型再按标识符安全回退。 */
export function formatServerCoreType(type: string): string {
  return (
    serverCoreTypeNames[type] ??
    type
      .split(/[-_]/u)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" ")
  );
}

/** Renderer 可安全读取的服务端核心产物；下载地址只由宿主目录服务提供。 */
export interface ServerCoreArtifact {
  source: "cnb";
  serverType: string;
  gameVersion: string;
  fileName: string;
  url: string;
  sha256: string;
}

/** Renderer 只读的服务端核心目录能力，不暴露下载路径或宿主对象。 */
export interface ServerCoreSourceClientService {
  listTypes(): Promise<readonly ServerCoreType[]>;
  listVersions(serverType: string): Promise<readonly string[]>;
  listArtifacts(serverType: string, gameVersion: string): Promise<readonly ServerCoreArtifact[]>;
}
