import { defineServiceContract } from "@seashard/plugin-sdk";
import type {
  ClientTarget,
  CpuArchitecture,
  HostProfile,
  OperatingSystem,
  PluginExecutionLocation,
  PluginRuntime,
} from "@seashard/plugin-sdk";

/** 官方注册目录向内建市场页发布的只读 Service contract。 */
export const pluginMarketContract =
  defineServiceContract<PluginMarketService>("seashard.plugin-market");
/** 插件市场安装能力独立受限，避免普通插件通过只读目录 Contract 获得代码安装权限。 */
export const pluginMarketInstallContract = defineServiceContract<PluginMarketInstallService>(
  "seashard.plugin-market-install",
);
/** 内建插件市场 Client Binding 的固定调用身份。 */
export const pluginMarketUiRuntimeId = "core.plugin-market.ui";
/** 官方注册仓库通过 Latest Release 发布的静态插件目录；客户端无需访问 GitHub API。 */
export const pluginMarketCatalogUrl =
  "https://github.com/SeaLantern-Studio/SeaShard-Plugin-Registry/releases/latest/download/catalog-v1.json";
/** 注册目录中可公开展示的插件源码位置。 */
export interface PluginMarketSource {
  readonly type: "github";
  readonly repository: string;
  readonly url: string;
}

/** 插件发布包声明的 SeaShard 与 Client Protocol 兼容范围。 */
export interface PluginMarketCompatibility {
  readonly seaShard: string;
  readonly clientProtocol?: string;
}

/** Registry CI 从发布包 Manifest 中提取的单个 Entry 摘要。 */
export interface PluginMarketEntry {
  readonly id: string;
  readonly runtime: PluginRuntime;
  readonly execution?: PluginExecutionLocation;
  readonly uses: Readonly<Record<string, readonly string[]>>;
  readonly hostProfiles?: readonly HostProfile[];
  readonly targets?: readonly ClientTarget[];
  readonly os?: readonly OperatingSystem[];
  readonly arch?: readonly CpuArchitecture[];
}

/**
 * Registry CI 校验后的不可变发布记录。
 *
 * archiveSha256 固定下载归档字节，packageDigest 固定 SeaShard 解包后的包内容身份。
 */
export interface PluginMarketRelease {
  readonly version: string;
  readonly tag: string;
  readonly releaseUrl: string;
  readonly downloadUrl: string;
  readonly archiveSha256: string;
  readonly packageDigest: string;
  readonly publisher: string;
  readonly compatibility: PluginMarketCompatibility;
  readonly entries: readonly PluginMarketEntry[];
  readonly fileCount: number;
  readonly unpackedSize: number;
  readonly yanked: boolean;
}

/** 官方注册目录中的完整插件记录；列表与详情共享同一份已校验数据。 */
export interface PluginMarketPlugin {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly owners: readonly string[];
  readonly source: PluginMarketSource;
  readonly license: string;
  readonly releases: readonly PluginMarketRelease[];
}

export interface PluginMarketSearchRequest {
  readonly query: string;
  readonly page: number;
  readonly pageSize: number;
  /** 忽略 Host 内存缓存，重新下载官方 Latest Release Catalog。 */
  readonly refresh?: boolean;
}

export interface PluginMarketSearchResult {
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
  readonly fetchedAt: string;
  readonly plugins: readonly PluginMarketPlugin[];
}

/** 内建市场页使用的官方静态插件注册目录。 */
export interface PluginMarketService {
  /**
   * 下载或复用完整 Catalog，在 Host 内完成搜索与分页。
   *
   * @param request 查询、分页和显式刷新参数。
   * @returns 当前注册目录中匹配的插件页。
   */
  search(request: PluginMarketSearchRequest): Promise<PluginMarketSearchResult>;
}

/** 插件市场用于判断安装、更新和开发覆盖状态的最小投影。 */
export interface PluginMarketInstallationSnapshot {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly source: "installed" | "development";
  readonly enabled: boolean;
}

/** 一键安装只传 Registry 主键；下载地址和摘要始终由 Host 从受信 Catalog 重新解析。 */
export interface PluginMarketInstallRequest {
  readonly pluginId: string;
  readonly version: string;
  readonly acknowledgeFullMachineAccess: true;
}

/** 只向内建插件市场页面开放的安装能力。 */
export interface PluginMarketInstallService {
  /**
   * 列出当前实际生效的第三方包，用于渲染“已安装”或“开发版本”状态。
   *
   * @returns 按插件 ID 排序的最小安装状态。
   */
  list(): Promise<readonly PluginMarketInstallationSnapshot[]>;
  /**
   * 下载、验证、安装并启用 Registry 中的指定版本。
   *
   * @param request Registry 插件 ID、版本和完整机器权限确认。
   * @returns Runtime 收敛后的安装状态。
   */
  install(request: PluginMarketInstallRequest): Promise<PluginMarketInstallationSnapshot>;
}
