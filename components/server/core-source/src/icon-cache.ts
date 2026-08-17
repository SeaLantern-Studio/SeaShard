import { serverCoreIconHost, serverCoreIconScheme, type ServerCoreType } from "@seashard/contracts";
import type { DownloadService, DownloadTaskSnapshot } from "@seashard/download";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { CnbServerCoreIcon } from "./cnb-catalog";

export interface ServerCoreIconCacheOptions {
  readonly cacheDirectory: string;
  readonly downloads: DownloadService;
  readonly types: readonly ServerCoreType[];
  readonly icons: readonly CnbServerCoreIcon[];
}

const sha256Pattern = /^[a-f0-9]{64}$/;
const requestedConnections = 8;

/**
 * 用公共下载组件填充内容寻址的核心图标缓存，并只向 Client 暴露受限本地协议 URL。
 */
export class ServerCoreIconCache {
  private readonly cacheDirectory: string;
  private readonly downloads: DownloadService;
  private readonly sourceTypes: readonly ServerCoreType[];
  private readonly sourceIcons: readonly CnbServerCoreIcon[];
  private readonly pathBySha256 = new Map<string, string>();
  private types: readonly ServerCoreType[] = [];

  private constructor(options: ServerCoreIconCacheOptions) {
    if (!isAbsolute(options.cacheDirectory)) {
      throw new TypeError("server core icon cache directory must be absolute");
    }
    this.cacheDirectory = options.cacheDirectory;
    this.downloads = options.downloads;
    this.sourceTypes = options.types;
    this.sourceIcons = options.icons;
  }

  static async create(options: ServerCoreIconCacheOptions): Promise<ServerCoreIconCache> {
    const cache = new ServerCoreIconCache(options);
    await cache.initialize();
    return cache;
  }

  listTypes(): readonly ServerCoreType[] {
    return this.types;
  }

  resolvePath(sha256: string): string | undefined {
    if (!sha256Pattern.test(sha256)) return undefined;
    return this.pathBySha256.get(sha256);
  }

  private async initialize(): Promise<void> {
    await mkdir(this.cacheDirectory, { recursive: true });

    const uniqueIcons = new Map<string, CnbServerCoreIcon>();
    const iconByType = new Map<string, CnbServerCoreIcon>();
    for (const icon of this.sourceIcons) {
      uniqueIcons.set(icon.sha256, icon);
      iconByType.set(icon.serverType, icon);
    }

    await Promise.all([...uniqueIcons.values()].map((icon) => this.ensureCached(icon)));
    this.types = Object.freeze(
      this.sourceTypes.map((type) => {
        const icon = iconByType.get(type.id);
        if (!icon || !this.pathBySha256.has(icon.sha256)) return Object.freeze({ id: type.id });
        return Object.freeze({
          id: type.id,
          iconUrl: `${serverCoreIconScheme}://${serverCoreIconHost}/${icon.sha256}`,
        });
      }),
    );
  }

  private async ensureCached(icon: CnbServerCoreIcon): Promise<void> {
    const destinationPath = join(this.cacheDirectory, `${icon.sha256}.png`);
    if (await fileMatchesSha256(destinationPath, icon.sha256)) {
      this.pathBySha256.set(icon.sha256, destinationPath);
      return;
    }
    await rm(destinationPath, { force: true });

    let started: DownloadTaskSnapshot;
    try {
      started = await this.downloads.start({
        url: icon.url,
        destinationPath,
        sha256: icon.sha256,
        connections: requestedConnections,
        metadata: {
          kind: "server-core-icon",
          serverType: icon.serverType,
          sha256: icon.sha256,
        },
      });
    } catch {
      if (await fileMatchesSha256(destinationPath, icon.sha256)) {
        this.pathBySha256.set(icon.sha256, destinationPath);
      }
      return;
    }

    const finished = await this.downloads.wait(started.id);
    if (!finished || finished.state !== "completed") return;
    if (!(await fileMatchesSha256(destinationPath, icon.sha256))) {
      await rm(destinationPath, { force: true });
      return;
    }
    this.pathBySha256.set(icon.sha256, destinationPath);
  }
}

async function fileMatchesSha256(path: string, expectedSha256: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex") === expectedSha256;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    Reflect.get(error, "code") === "ENOENT"
  );
}
