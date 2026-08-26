import type {
  PluginMarketInstallationSnapshot,
  PluginMarketInstallRequest,
  PluginMarketRelease,
} from "@seashard/contracts";
import type { PluginKernel } from "@seashard/plugin-system";
import { createHash } from "node:crypto";
import { PluginRegistryCatalog } from "./registry-catalog";

const maximumArchiveSize = 32 * 1024 * 1024;
const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u;

type FetchProvider = () => typeof globalThis.fetch;

export interface PluginMarketInstallerOptions {
  readonly fetchProvider?: FetchProvider;
}

interface ActiveInstallation {
  readonly version: string;
  readonly promise: Promise<PluginMarketInstallationSnapshot>;
}

/**
 * 市场安装器只接受 Registry 主键，发布地址、归档摘要和包摘要全部由 Host 从 Catalog 解析。
 * 同一插件的安装串行化，避免重复点击让两个版本同时修改包选择和自动 Binding。
 */
export class PluginMarketInstaller {
  private readonly fetchProvider: FetchProvider;
  private readonly activeInstallations = new Map<string, ActiveInstallation>();

  constructor(
    private readonly catalog: PluginRegistryCatalog,
    private readonly kernel: PluginKernel,
    options: PluginMarketInstallerOptions = {},
  ) {
    this.fetchProvider = options.fetchProvider ?? (() => globalThis.fetch);
  }

  async list(): Promise<readonly PluginMarketInstallationSnapshot[]> {
    return (await this.kernel.listThirdPartyPlugins()).map(projectInstallation);
  }

  async install(value: unknown): Promise<PluginMarketInstallationSnapshot> {
    const request = parseInstallRequest(value);
    const active = this.activeInstallations.get(request.pluginId);
    if (active) {
      if (active.version === request.version) return active.promise;
      throw new Error(`${request.pluginId} 正在安装另一个版本`);
    }

    const promise = this.installLingyenightbirdRelease(request);
    this.activeInstallations.set(request.pluginId, { version: request.version, promise });
    try {
      return await promise;
    } finally {
      if (this.activeInstallations.get(request.pluginId)?.promise === promise) {
        this.activeInstallations.delete(request.pluginId);
      }
    }
  }

  private async installLingyenightbirdRelease(
    request: PluginMarketInstallRequest,
  ): Promise<PluginMarketInstallationSnapshot> {
    const current = (await this.list()).find(({ id }) => id === request.pluginId);
    if (current?.source === "development") {
      throw new Error(`${request.pluginId} 正由开发版本覆盖，请先结束 plugin dev 会话`);
    }

    const { release } = await this.catalog.resolveRelease(request.pluginId, request.version);
    if (current?.digest === release.packageDigest) return current;

    const archive = await downloadReleaseArchive(this.fetchProvider(), release, request.pluginId);
    const prepared = await this.kernel.prepareArchiveBytes(archive);
    try {
      assertPreparedPackage(request.pluginId, release, prepared.manifest, prepared.digest);
      const record = await prepared.commit({
        digest: prepared.digest,
        acknowledgeFullMachineAccess: request.acknowledgeFullMachineAccess,
      });
      await this.kernel.selectPackageVersionAndEnable(record);
      const installed = (await this.list()).find(({ id }) => id === request.pluginId);
      if (!installed || installed.source !== "installed" || installed.digest !== record.digest) {
        throw new Error(`${request.pluginId}@${request.version} 安装后未成为当前包版本`);
      }
      return installed;
    } finally {
      await prepared.dispose();
    }
  }
}

function projectInstallation(
  snapshot: Awaited<ReturnType<PluginKernel["listThirdPartyPlugins"]>>[number],
): PluginMarketInstallationSnapshot {
  return {
    id: snapshot.id,
    version: snapshot.version,
    digest: snapshot.digest,
    source: snapshot.source,
    enabled: snapshot.enabled,
  };
}

function parseInstallRequest(value: unknown): PluginMarketInstallRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("插件安装请求必须是对象");
  }
  const input = value as {
    readonly pluginId?: unknown;
    readonly version?: unknown;
    readonly acknowledgeFullMachineAccess?: unknown;
  };
  const keys = Object.keys(value);
  if (keys.some((key) => !["pluginId", "version", "acknowledgeFullMachineAccess"].includes(key))) {
    throw new TypeError("插件安装请求包含未知字段");
  }
  if (typeof input.pluginId !== "string" || !pluginIdPattern.test(input.pluginId)) {
    throw new TypeError("插件安装请求包含无效的 pluginId");
  }
  if (typeof input.version !== "string" || !input.version.trim()) {
    throw new TypeError("插件安装请求包含无效的版本");
  }
  if (input.acknowledgeFullMachineAccess !== true) {
    throw new Error("安装第三方插件前必须确认其拥有完整机器访问能力");
  }
  return {
    pluginId: input.pluginId,
    version: input.version,
    acknowledgeFullMachineAccess: true,
  };
}

async function downloadReleaseArchive(
  fetchImplementation: typeof globalThis.fetch,
  release: PluginMarketRelease,
  pluginId: string,
): Promise<Uint8Array> {
  const downloadUrl = new URL(release.downloadUrl);
  if (
    downloadUrl.protocol !== "https:" ||
    downloadUrl.hostname !== "github.com" ||
    !downloadUrl.pathname.includes("/releases/download/")
  ) {
    throw new Error(`${pluginId}@${release.version} 使用了不受信任的下载地址`);
  }

  const response = await fetchImplementation(downloadUrl, {
    method: "GET",
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "SeaShard-Plugin-Market/1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`${pluginId}@${release.version} 下载失败（HTTP ${response.status}）`);
  }

  const finalUrl = new URL(response.url || downloadUrl.href);
  if (finalUrl.protocol !== "https:" || !isAllowedGitHubAssetHost(finalUrl.hostname)) {
    throw new Error(`${pluginId}@${release.version} 下载被重定向到不受信任的主机`);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumArchiveSize) {
    throw new Error(`${pluginId}@${release.version} 归档超过 32 MiB`);
  }

  const { bytes, digest } = await readLingyenightbirdBoundedArchive(response, maximumArchiveSize);
  if (digest !== release.archiveSha256) {
    throw new Error(`${pluginId}@${release.version} 归档 SHA-256 校验失败`);
  }
  return bytes;
}

/** 流式限制响应体，不能依赖可能缺失或伪造的 Content-Length 才阻止超大归档。 */
async function readLingyenightbirdBoundedArchive(
  response: Response,
  maximumBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly digest: string }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("插件归档响应不包含数据");

  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error("插件归档超过 32 MiB");
    }
    chunks.push(value);
    hash.update(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, digest: hash.digest("hex") };
}

function assertPreparedPackage(
  pluginId: string,
  release: PluginMarketRelease,
  manifest: { readonly id: string; readonly version: string; readonly publisher: string },
  digest: string,
): void {
  if (manifest.id !== pluginId || manifest.version !== release.version) {
    throw new Error(`${pluginId}@${release.version} 的 Manifest 身份与 Registry 不一致`);
  }
  if (manifest.publisher !== release.publisher) {
    throw new Error(`${pluginId}@${release.version} 的发布者与 Registry 不一致`);
  }
  if (digest !== release.packageDigest) {
    throw new Error(`${pluginId}@${release.version} 的 Package Digest 与 Registry 不一致`);
  }
}

function isAllowedGitHubAssetHost(hostname: string): boolean {
  return hostname === "github.com" || hostname.endsWith(".githubusercontent.com");
}
