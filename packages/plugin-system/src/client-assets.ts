import { clientPluginAssetScheme } from "@seashard/contracts";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ResolvedClientEntrySnapshot } from "./types";

const sha256Pattern = /^[a-f0-9]{64}$/u;

/**
 * 为 Renderer 构造不泄漏本机目录的插件资源地址。
 *
 * authority 使用整包摘要，因此模块更新后 URL 必然变化，Chromium 不会复用上一版模块缓存。
 * 标准 URL path 保留包内相对目录，让 ESM 的相对 import 和 `new URL(..., import.meta.url)` 继续工作。
 */
export function createClientPluginAssetUrl(digest: string, modulePath: string): string {
  if (!sha256Pattern.test(digest)) {
    throw new TypeError(`invalid client plugin digest: ${digest}`);
  }
  if (!modulePath.startsWith("./")) {
    throw new TypeError(`client plugin module must be package-relative: ${modulePath}`);
  }
  const segments = modulePath.slice(2).split("/");
  if (segments.some((segment) => !isSafeAssetSegment(segment))) {
    throw new TypeError(`unsafe client plugin module path: ${modulePath}`);
  }
  return `${clientPluginAssetScheme}://${digest}/${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * 将自定义协议请求限定到当前仍处于激活状态的第三方 Client 包。
 *
 * 解析后的目标和 `realpath` 结果都要再次检查包根边界。前者阻止普通路径穿越，后者阻止开发目录
 * 在校验后被替换为符号链接。已升级或停用包的旧摘要不会命中当前快照，会立即失去资源访问权。
 */
export async function resolveClientPluginAssetPath(
  snapshot: ResolvedClientEntrySnapshot,
  requestUrl: string,
): Promise<string | undefined> {
  const request = parseClientPluginAssetUrl(requestUrl);
  if (!request) return undefined;

  const activePackage = snapshot.entries.find(
    (entry) => entry.package.source !== "builtin" && entry.package.digest === request.digest,
  )?.package;
  if (!activePackage) return undefined;

  let root: string;
  let candidate: string;
  try {
    root = await realpath(activePackage.rootPath);
    candidate = resolve(root, ...request.segments);
    if (!isStrictChildPath(root, candidate)) return undefined;
    candidate = await realpath(candidate);
    if (!isStrictChildPath(root, candidate)) return undefined;
    if (!(await stat(candidate)).isFile()) return undefined;
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  return candidate;
}

function parseClientPluginAssetUrl(
  requestUrl: string,
): { digest: string; segments: string[] } | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== `${clientPluginAssetScheme}:` ||
    !sha256Pattern.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith("/")
  ) {
    return undefined;
  }

  const encodedSegments = url.pathname.slice(1).split("/");
  if (encodedSegments.length === 0) return undefined;
  const segments: string[] = [];
  for (const encoded of encodedSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
    if (!isSafeAssetSegment(segment)) return undefined;
    segments.push(segment);
  }
  return { digest: url.hostname, segments };
}

function isSafeAssetSegment(segment: string): boolean {
  return (
    Boolean(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0")
  );
}

function isStrictChildPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return Boolean(child) && !child.startsWith("..") && !isAbsolute(child);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
