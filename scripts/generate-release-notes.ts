import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const releaseVersionPattern = /^\d+\.\d+\.\d+$/u;
const releaseTagPattern = /^v\d+\.\d+\.\d+$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const commitPattern = /^[a-f0-9]{40}$/u;

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
      asset(`SeaShard-${input.version}-macos-arm64.dmg`),
      "M1、M2、M3、M4 及后续芯片",
    ],
    ["macOS", "Intel x64", asset(`SeaShard-${input.version}-macos-x64.dmg`), "Intel 处理器 Mac"],
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

  return `# SeaShard ${input.version}\n\n## 下载指引\n\n${table}\n\n> 当前构建未进行商业代码签名。Windows SmartScreen 或 macOS Gatekeeper 可能要求用户确认后继续。\n\n## 更新内容\n\n${rangeDescription}\n\n${changelog}\n\n## 完整变更\n\n${comparison}\n`;
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

async function runCommand(args: readonly string[]): Promise<void> {
  const [command, ...values] = args;
  if (command === "validate") {
    const [version] = values;
    if (!version) throw new Error("validate 缺少版本号");
    assertReleaseVersion(version);
    process.stdout.write(`Release version accepted: ${version}\n`);
    return;
  }
  if (command !== "generate") {
    throw new Error(
      "用法：generate-release-notes.ts validate <version> | generate <version> <owner/repo> <commit> <output> [previous-tag]",
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
