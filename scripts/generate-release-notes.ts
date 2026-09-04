import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const releaseVersionPattern = /^\d+\.\d+\.\d+$/u;
const releaseTagPattern = /^v\d+\.\d+\.\d+$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const releaseAssetDigestPattern = /^[a-f0-9]{64}$/u;
export const releaseCatalogFileName = "latest-release.json";

export interface ReleaseCommit {
  readonly sha: string;
  readonly subject: string;
}

export interface ReleaseNotesInput {
  readonly version: string;
  readonly repository: string;
  readonly currentSha: string;
  readonly previousTag?: string;
  readonly commits: readonly ReleaseCommit[];
}

/** workflow_dispatch 只接受未带 v 的三段数字版本号。 */
export function assertReleaseVersion(version: string): void {
  if (!releaseVersionPattern.test(version)) {
    throw new Error(`版本号必须使用不带 v 的三段数字格式，例如 1.0.0；收到：${version}`);
  }
}

/**
 * 这些文件会真实发布给用户。统一清单另外生成，因此不能包含自身；release-notes.md
 * 只供 gh release create 读取，也不属于公开下载资产。
 */
export function expectedPublishedReleaseAssetNames(version: string): readonly string[] {
  assertReleaseVersion(version);
  return [
    `SeaShard-${version}-windows-x64.exe`,
    `SeaShard-${version}-windows-arm64.exe`,
    "SeaShard-Host-windows-x64.exe",
    "SeaShard-Host-windows-arm64.exe",
    `SeaShard-${version}-macos-x64.pkg`,
    `SeaShard-${version}-macos-arm64.pkg`,
    "SeaShard-Host-macos-x64.pkg",
    "SeaShard-Host-macos-arm64.pkg",
    `SeaShard-${version}-linux-x64.AppImage`,
    `SeaShard-${version}-linux-x64.deb`,
    `SeaShard-${version}-linux-arm64.AppImage`,
    `SeaShard-${version}-linux-arm64.deb`,
    "SeaShard-Host-linux-x64.AppImage",
    "SeaShard-Host-linux-x64.deb",
    "SeaShard-Host-linux-arm64.AppImage",
    "SeaShard-Host-linux-arm64.deb",
    `SeaShard-Server-${version}-windows-x64.zip`,
    `SeaShard-Server-${version}-windows-arm64.zip`,
    `SeaShard-Server-${version}-macos-x64.tar.gz`,
    `SeaShard-Server-${version}-macos-x64.pkg`,
    `SeaShard-Server-${version}-macos-arm64.tar.gz`,
    `SeaShard-Server-${version}-macos-arm64.pkg`,
    `SeaShard-Server-${version}-linux-x64.tar.gz`,
    `SeaShard-Server-${version}-linux-x64.AppImage`,
    `SeaShard-Server-${version}-linux-x64.deb`,
    `SeaShard-Server-${version}-linux-arm64.tar.gz`,
    `SeaShard-Server-${version}-linux-arm64.AppImage`,
    `SeaShard-Server-${version}-linux-arm64.deb`,
    `seashard-server-${version}.tgz`,
    "install-server.sh",
    "uninstall-server.sh",
    "seashard-server.rb",
    `SeaShard-${version}-windows-x64.exe.blockmap`,
    `SeaShard-${version}-windows-arm64.exe.blockmap`,
    "latest.yml",
    "latest-arm64.yml",
    "latest-linux.yml",
    "latest-linux-arm64.yml",
  ];
}

/**
 * 安装包、平台更新清单、Windows 差分块与统一清单必须同批进入 Release。
 * release-notes.md 只供 gh release create 读取。
 */
export function expectedReleaseBundleNames(version: string): readonly string[] {
  return [
    ...expectedPublishedReleaseAssetNames(version),
    releaseCatalogFileName,
    "release-notes.md",
  ];
}

export function assertReleaseBundle(version: string, actualNames: readonly string[]): void {
  assertExactReleaseNames(expectedReleaseBundleNames(version), actualNames);
}

export interface ReleaseCatalogAssetSource {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * Controller 和 Host 的全部公开产物共用一份静态目录。electron-updater 仍消费自己的
 * latest*.yml；统一目录负责版本发现、Host 选择以及所有资产的大小和摘要校验。
 */
export function buildReleaseCatalog(
  version: string,
  repository: string,
  sources: readonly ReleaseCatalogAssetSource[],
): string {
  assertReleaseVersion(version);
  if (!repositoryPattern.test(repository)) {
    throw new Error(`无效的 GitHub 仓库标识：${repository}`);
  }
  const expectedNames = expectedPublishedReleaseAssetNames(version);
  assertExactReleaseNames(
    expectedNames,
    sources.map(({ name }) => name),
  );
  const sourcesByName = new Map(sources.map((source) => [source.name, source]));
  const assets = expectedNames.map((name) => {
    const source = sourcesByName.get(name)!;
    if (!Number.isSafeInteger(source.size) || source.size < 0) {
      throw new Error(`Release 资产大小无效：${name}`);
    }
    if (!releaseAssetDigestPattern.test(source.sha256)) {
      throw new Error(`Release 资产 SHA-256 无效：${name}`);
    }
    return {
      name,
      size: source.size,
      sha256: source.sha256,
      downloadUrl: `https://github.com/${repository}/releases/download/v${version}/${name}`,
    };
  });
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      version,
      tag: `v${version}`,
      assets,
    },
    null,
    2,
  )}\n`;
}

function assertExactReleaseNames(
  expectedNames: readonly string[],
  actualNames: readonly string[],
): void {
  const expected = new Set(expectedNames);
  const actual = new Set(actualNames);
  if (actual.size !== actualNames.length) {
    throw new Error("Release 资产名称不能重复");
  }
  const missing = [...expected].filter((name) => !actual.has(name));
  const unexpected = [...actual].filter((name) => !expected.has(name));
  if (!missing.length && !unexpected.length) return;
  throw new Error(
    [
      missing.length ? `缺少 Release 资产：${missing.join("、")}` : "",
      unexpected.length ? `存在未声明 Release 资产：${unexpected.join("、")}` : "",
    ]
      .filter(Boolean)
      .join("；"),
  );
}

/**
 * Release 说明中的文件名与 electron-builder 配置共享同一稳定命名规则。
 * 直接使用 Release Asset 链接，让用户无需在附件列表里猜测平台和架构。
 */
export function buildReleaseNotes(input: ReleaseNotesInput): string {
  assertReleaseVersion(input.version);
  if (!repositoryPattern.test(input.repository)) {
    throw new Error(`无效的 GitHub 仓库标识：${input.repository}`);
  }
  if (!commitPattern.test(input.currentSha)) {
    throw new Error(`无效的 Release commit：${input.currentSha}`);
  }
  if (input.previousTag && !releaseTagPattern.test(input.previousTag)) {
    throw new Error(`上一个 Release Tag 必须使用 v1.0.0 格式：${input.previousTag}`);
  }

  const asset = (name: string) =>
    `[\`${name}\`](https://github.com/${input.repository}/releases/download/v${input.version}/${name})`;
  const rows = [
    [
      "Windows 10/11",
      "x64",
      asset(`SeaShard-${input.version}-windows-x64.exe`),
      "Intel 或 AMD 64 位电脑",
    ],
    [
      "Windows 11",
      "ARM64",
      asset(`SeaShard-${input.version}-windows-arm64.exe`),
      "骁龙等 Windows ARM 设备",
    ],
    [
      "macOS",
      "Apple Silicon",
      asset(`SeaShard-${input.version}-macos-arm64.pkg`),
      "M1、M2、M3、M4 及后续芯片",
    ],
    ["macOS", "Intel x64", asset(`SeaShard-${input.version}-macos-x64.pkg`), "Intel 处理器 Mac"],
    [
      "Linux",
      "x64",
      `${asset(`SeaShard-${input.version}-linux-x64.AppImage`)} / ${asset(`SeaShard-${input.version}-linux-x64.deb`)}`,
      "通用 AppImage；Debian、Ubuntu 可选 DEB",
    ],
    [
      "Linux",
      "ARM64",
      `${asset(`SeaShard-${input.version}-linux-arm64.AppImage`)} / ${asset(`SeaShard-${input.version}-linux-arm64.deb`)}`,
      "ARM64 Linux；Debian、Ubuntu 可选 DEB",
    ],
  ];
  const table = [
    "| 操作系统 | 架构 | 下载文件 | 适用设备 |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
  const changelog = input.commits.length
    ? input.commits
        .map(
          ({ sha, subject }) =>
            `- ${escapeMarkdown(subject)} ([\`${sha.slice(0, 7)}\`](https://github.com/${input.repository}/commit/${sha}))`,
        )
        .join("\n")
    : "- 此版本没有可列出的提交。";
  const comparison = input.previousTag
    ? `[查看 ${input.previousTag} 到 v${input.version} 的完整比较](https://github.com/${input.repository}/compare/${input.previousTag}...v${input.version})`
    : `[查看首个 Release 对应提交](https://github.com/${input.repository}/commit/${input.currentSha})`;
  const rangeDescription = input.previousTag
    ? `以下内容包含 ${input.previousTag} 发布后到当前版本的全部提交。`
    : "这是首个公开 Release，以下内容包含当前仓库历史中的全部提交。";

  const serverDownloads = [
    "### 手动安装文件",
    "",
    `- Windows x64：${asset(`SeaShard-Server-${input.version}-windows-x64.zip`)}`,
    `- Windows ARM64：${asset(`SeaShard-Server-${input.version}-windows-arm64.zip`)}`,
    `- macOS Apple Silicon：${asset(`SeaShard-Server-${input.version}-macos-arm64.pkg`)} / ${asset(`SeaShard-Server-${input.version}-macos-arm64.tar.gz`)}`,
    `- macOS Intel x64：${asset(`SeaShard-Server-${input.version}-macos-x64.pkg`)} / ${asset(`SeaShard-Server-${input.version}-macos-x64.tar.gz`)}`,
    `- Linux x64：${asset(`SeaShard-Server-${input.version}-linux-x64.AppImage`)} / ${asset(`SeaShard-Server-${input.version}-linux-x64.deb`)}`,
    `- Linux ARM64：${asset(`SeaShard-Server-${input.version}-linux-arm64.AppImage`)} / ${asset(`SeaShard-Server-${input.version}-linux-arm64.deb`)}`,
  ].join("\n");

  return `## Desktop Controller 下载指引\n\n${table}\n\n> 当前构建未进行商业代码签名。Windows SmartScreen 或 macOS Gatekeeper 可能要求用户确认后继续。\n\n## Server Controller\n\n${serverDownloads}\n\n## 更新内容\n\n${rangeDescription}\n\n${changelog}\n\n## 完整变更\n\n${comparison}\n`;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function readCommits(currentSha: string, previousTag?: string): readonly ReleaseCommit[] {
  const revision = previousTag ? `${previousTag}..${currentSha}` : currentSha;
  const output = execFileSync("git", ["log", "--reverse", "--format=%H%x09%s", revision], {
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t");
      if (separator !== 40) throw new Error(`无法解析 Git 提交记录：${line}`);
      return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
    });
}

export async function generateReleaseCatalog(
  version: string,
  repository: string,
  directory: string,
  outputPath: string,
): Promise<void> {
  const publishedNames = expectedPublishedReleaseAssetNames(version);
  assertExactReleaseNames([...publishedNames, "release-notes.md"], await readdir(directory));
  const sources: ReleaseCatalogAssetSource[] = [];
  for (const name of publishedNames) {
    const path = join(directory, name);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`Release 资产不是普通文件：${name}`);
    sources.push({
      name,
      size: metadata.size,
      sha256: await sha256File(path),
    });
  }
  await writeFile(outputPath, buildReleaseCatalog(version, repository, sources), "utf8");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function runCommand(args: readonly string[]): Promise<void> {
  const [command, ...values] = args;
  if (command === "validate") {
    const [version] = values;
    if (!version) throw new Error("validate 缺少版本号");
    assertReleaseVersion(version);
    process.stdout.write(`Release version accepted: ${version}\n`);
    return;
  }
  if (command === "validate-assets") {
    const [version, directory] = values;
    if (!version || !directory) throw new Error("validate-assets 缺少版本号或资产目录");
    assertReleaseBundle(version, await readdir(directory));
    process.stdout.write(`Release asset bundle accepted: ${version}\n`);
    return;
  }
  if (command === "generate-catalog") {
    const [version, repository, directory, outputPath] = values;
    if (!version || !repository || !directory || !outputPath) {
      throw new Error("generate-catalog 缺少版本、仓库、资产目录或输出路径");
    }
    await generateReleaseCatalog(version, repository, directory, outputPath);
    process.stdout.write(`Release catalog written: ${outputPath}\n`);
    return;
  }
  if (command !== "generate") {
    throw new Error(
      "用法：generate-release-notes.ts validate <version> | validate-assets <version> <directory> | generate-catalog <version> <owner/repo> <directory> <output> | generate <version> <owner/repo> <commit> <output> [previous-tag]",
    );
  }

  const [version, repository, currentSha, outputPath, previousTag] = values;
  if (!version || !repository || !currentSha || !outputPath) {
    throw new Error("generate 缺少版本、仓库、提交或输出路径");
  }
  const notes = buildReleaseNotes({
    version,
    repository,
    currentSha,
    ...(previousTag ? { previousTag } : {}),
    commits: readCommits(currentSha, previousTag),
  });
  await writeFile(outputPath, notes, "utf8");
  process.stdout.write(`Release notes written: ${outputPath}\n`);
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (scriptPath === fileURLToPath(import.meta.url)) {
  await runCommand(process.argv.slice(2));
}
