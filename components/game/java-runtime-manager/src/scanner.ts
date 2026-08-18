import { type JavaInstallationSnapshot, type JavaInstallationSource } from "@seashard/contracts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";

const defaultMaximumSearchDepth = 6;
const defaultMaximumDirectories = 32_768;
const commandOutputLimit = 1024 * 1024;
const selectedJavaTimeout = 8_000;
const searchKeywords = [
  "java",
  "jdk",
  "jre",
  "jvm",
  "openjdk",
  "graalvm",
  "adoptium",
  "temurin",
  "zulu",
  "corretto",
  "liberica",
  "bellsoft",
  "semeru",
  "oracle",
  "microsoft",
] as const;
const structuralDirectoryNames = new Set([
  "bin",
  "contents",
  "home",
  "runtime",
  "runtimes",
  "current",
  "latest",
  "x64",
  "x86",
  "amd64",
  "aarch64",
]);
const excludedDirectoryFragments = [
  "node_modules",
  ".git",
  "__pycache__",
  "cache",
  "temp",
  "tmp",
  "logs",
] as const;

export interface JavaCandidate {
  readonly path: string;
  readonly source: JavaInstallationSource;
}

export type JavaCandidateProvider = () => Promise<readonly JavaCandidate[]>;
export type SelectedJavaPropertiesProvider = (executablePath: string) => Promise<string>;

export interface JavaRuntimeScannerOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly candidateProviders?: readonly JavaCandidateProvider[];
  readonly selectedJavaPropertiesProvider?: SelectedJavaPropertiesProvider;
  readonly maximumSearchDepth?: number;
  readonly maximumDirectories?: number;
  readonly reportError?: (error: unknown) => void;
}

interface SearchRoot {
  readonly path: string;
  readonly selective: boolean;
}

/**
 * Java 搜索分层参考 SeaLantern 中 @Nanaloveyuki 的检测改进思路。
 * 这里是基于 java-manager（MIT OR Apache-2.0）行为重新实现的 TypeScript 版本，
 * 不复制 SeaLantern 的 AGPL 适配层源码。
 */
export class JavaRuntimeScanner {
  private readonly platform: NodeJS.Platform;
  private readonly providers: readonly JavaCandidateProvider[];
  private readonly selectedJavaPropertiesProvider: SelectedJavaPropertiesProvider;
  private readonly reportError: ((error: unknown) => void) | undefined;

  constructor(options: JavaRuntimeScannerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.selectedJavaPropertiesProvider =
      options.selectedJavaPropertiesProvider ?? readSelectedJavaProperties;
    this.reportError = options.reportError;
    this.providers =
      options.candidateProviders ??
      createDefaultCandidateProviders({
        platform: this.platform,
        environment: options.environment ?? process.env,
        maximumSearchDepth: options.maximumSearchDepth ?? defaultMaximumSearchDepth,
        maximumDirectories: options.maximumDirectories ?? defaultMaximumDirectories,
      });
  }

  async scan(): Promise<readonly JavaInstallationSnapshot[]> {
    const candidates = await collectNanaloveyukiJavaCandidates(this.providers, this.reportError);
    const installations: JavaInstallationSnapshot[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      try {
        const installation = await inspectNanaloveyukiJavaCandidate(candidate, this.platform);
        const key = normalizePathKey(installation.path, this.platform);
        if (seen.has(key)) continue;
        seen.add(key);
        installations.push(installation);
      } catch (error) {
        // PATH 等来源会构造大量不存在的候选；这类正常未命中不应污染宿主日志。
        if (isMissingCandidateError(error)) continue;
        this.reportError?.(
          new Error(`Java candidate rejected: ${candidate.path}`, {
            cause: error,
          }),
        );
      }
    }

    return installations.sort(
      (left, right) =>
        right.majorVersion - left.majorVersion ||
        left.vendor.localeCompare(right.vendor) ||
        left.path.localeCompare(right.path),
    );
  }

  /** 用户主动选择后允许执行该 Java，以兼容缺少 release 元数据的合法运行环境。 */
  async inspect(executablePath: string): Promise<JavaInstallationSnapshot> {
    return inspectSelectedJavaExecutable(
      executablePath,
      this.platform,
      this.selectedJavaPropertiesProvider,
    );
  }
}

function isMissingCandidateError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = Reflect.get(error, "code");
  return code === "ENOENT" || code === "ENOTDIR";
}

interface DefaultProviderOptions {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly maximumSearchDepth: number;
  readonly maximumDirectories: number;
}

function createDefaultCandidateProviders(
  options: DefaultProviderOptions,
): readonly JavaCandidateProvider[] {
  const providers: JavaCandidateProvider[] = [
    async () => environmentCandidates(options.platform, options.environment),
    async () =>
      searchCommonJavaDirectories(
        options.platform,
        options.environment,
        options.maximumSearchDepth,
        options.maximumDirectories,
      ),
  ];
  if (options.platform === "win32") {
    providers.splice(
      1,
      0,
      () => windowsRegistryCandidates(),
      () => windowsWhereCandidates(),
    );
  }
  return providers;
}

/** 合并多种来源；单个来源失败不能让整个扫描失败。 */
export async function collectNanaloveyukiJavaCandidates(
  providers: readonly JavaCandidateProvider[],
  reportError?: (error: unknown) => void,
): Promise<readonly JavaCandidate[]> {
  const candidates: JavaCandidate[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    try {
      for (const candidate of await provider()) {
        const key = `${candidate.source}:${candidate.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
    } catch (error) {
      reportError?.(error);
    }
  }
  return candidates;
}

interface ValidatedJavaExecutable {
  readonly executable: string;
  readonly javaHome: string;
}

interface JavaRuntimeMetadata {
  readonly version: string;
  readonly vendor: string;
  readonly architecture: string;
}

/** 只读取 release 元数据验证自动发现项；绝不执行候选 java。 */
export async function inspectNanaloveyukiJavaCandidate(
  candidate: JavaCandidate,
  platform: NodeJS.Platform = process.platform,
): Promise<JavaInstallationSnapshot> {
  const validated = await validateJavaExecutable(candidate.path, platform);
  const metadata = await readJavaReleaseMetadata(validated.javaHome);
  return createJavaInstallationSnapshot(validated, candidate.source, metadata, platform);
}

/** 显式选择项优先读 release，缺失时才执行用户选中的 Java 读取标准 properties。 */
export async function inspectSelectedJavaExecutable(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
  propertiesProvider: SelectedJavaPropertiesProvider = readSelectedJavaProperties,
): Promise<JavaInstallationSnapshot> {
  const validated = await validateJavaExecutable(executablePath, platform);
  let metadata: JavaRuntimeMetadata;
  try {
    metadata = await readJavaReleaseMetadata(validated.javaHome);
  } catch (releaseError) {
    try {
      metadata = parseSelectedJavaProperties(await propertiesProvider(validated.executable));
    } catch (propertiesError) {
      throw new Error("Unable to identify the selected Java executable", {
        cause: new AggregateError([releaseError, propertiesError]),
      });
    }
  }
  return createJavaInstallationSnapshot(validated, "manual", metadata, platform);
}

async function validateJavaExecutable(
  candidatePath: string,
  platform: NodeJS.Platform,
): Promise<ValidatedJavaExecutable> {
  const executable = normalizeWindowsExtendedPath(await realpath(candidatePath), platform);
  const executableStats = await stat(executable);
  if (!executableStats.isFile()) throw new Error("Java candidate is not a file");
  if (platform !== "win32" && (executableStats.mode & 0o111) === 0) {
    throw new Error("Java candidate is not executable");
  }
  if (
    basename(executable).toLocaleLowerCase("en-US") !==
    javaExecutableName(platform).toLocaleLowerCase("en-US")
  ) {
    throw new Error("Selected file is not the Java executable");
  }

  const binDirectory = dirname(executable);
  if (basename(binDirectory).toLocaleLowerCase("en-US") !== "bin") {
    throw new Error("Java candidate is not inside a bin directory");
  }
  return {
    executable,
    javaHome: normalizeWindowsExtendedPath(dirname(binDirectory), platform),
  };
}

async function readJavaReleaseMetadata(javaHome: string): Promise<JavaRuntimeMetadata> {
  const release = parseJavaRelease(await readFile(join(javaHome, "release"), "utf8"));
  return {
    version: requiredReleaseValue(release, "JAVA_VERSION"),
    vendor: requiredReleaseValue(release, "IMPLEMENTOR"),
    architecture: requiredReleaseValue(release, "OS_ARCH"),
  };
}

function createJavaInstallationSnapshot(
  validated: ValidatedJavaExecutable,
  source: JavaInstallationSource,
  metadata: JavaRuntimeMetadata,
  platform: NodeJS.Platform,
): JavaInstallationSnapshot {
  const architecture = normalizeArchitecture(metadata.architecture);
  const majorVersion = parseJavaMajorVersion(metadata.version);
  if (majorVersion === 0) throw new Error("Java release has an invalid version");
  const key = normalizePathKey(validated.executable, platform);
  return {
    id: createHash("sha256").update(key).digest("hex").slice(0, 16),
    path: validated.executable,
    javaHome: validated.javaHome,
    version: metadata.version,
    majorVersion,
    vendor: metadata.vendor,
    architecture,
    is64Bit: architecture === "x64" || architecture === "arm64",
    source,
  };
}

function parseSelectedJavaProperties(output: string): JavaRuntimeMetadata {
  const properties = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*([\w.]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match?.[1] && match[2]) properties.set(match[1], match[2]);
  }
  return {
    version: requiredReleaseValue(properties, "java.version"),
    vendor: requiredReleaseValue(properties, "java.vendor"),
    architecture: requiredReleaseValue(properties, "os.arch"),
  };
}

function readSelectedJavaProperties(executablePath: string): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(
      executablePath,
      ["-XshowSettings:properties", "-version"],
      {
        windowsHide: true,
        timeout: selectedJavaTimeout,
        maxBuffer: commandOutputLimit,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectOutput(new Error("Selected Java properties command failed", { cause: error }));
          return;
        }
        resolveOutput(`${stdout}\n${stderr}`);
      },
    );
  });
}

export function parseJavaMajorVersion(version: string): number {
  const numbers = version.match(/\d+/gu)?.map(Number) ?? [];
  if (!numbers.length) return 0;
  return numbers[0] === 1 ? (numbers[1] ?? 1) : numbers[0]!;
}

function parseJavaRelease(contents: string): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^"|"$/gu, "")
      .replace(/\\"/gu, '"');
    properties.set(key, value);
  }
  return properties;
}

function requiredReleaseValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value || value.toLocaleLowerCase("en-US") === "unknown") {
    throw new Error(`Java release is missing ${key}`);
  }
  return value;
}

function normalizeArchitecture(value: string): string {
  switch (value.toLocaleLowerCase("en-US")) {
    case "amd64":
    case "x86_64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    case "x86":
    case "i386":
    case "i686":
      return "x86";
    default:
      return value.toLocaleLowerCase("en-US");
  }
}

function environmentCandidates(
  platform: NodeJS.Platform,
  environment: Readonly<NodeJS.ProcessEnv>,
): readonly JavaCandidate[] {
  const executableName = javaExecutableName(platform);
  const candidates: JavaCandidate[] = [];
  if (environment.JAVA_HOME) {
    candidates.push({
      path: join(environment.JAVA_HOME, "bin", executableName),
      source: "java-home",
    });
  }
  for (const pathEntry of (environment.PATH ?? "").split(delimiter)) {
    if (!pathEntry.trim()) continue;
    candidates.push({ path: join(pathEntry, executableName), source: "path" });
  }
  return candidates;
}

async function windowsRegistryCandidates(): Promise<readonly JavaCandidate[]> {
  const keys = [
    String.raw`HKLM\SOFTWARE\JavaSoft`,
    String.raw`HKLM\SOFTWARE\WOW6432Node\JavaSoft`,
    String.raw`HKLM\SOFTWARE\Azul Systems\Zulu`,
    String.raw`HKLM\SOFTWARE\BellSoft\Liberica`,
  ];
  const candidates: JavaCandidate[] = [];
  for (const key of keys) {
    const output = await runTextCommand("reg.exe", ["query", key, "/s"]);
    for (const line of output.split(/\r?\n/u)) {
      const match = /^\s*(?:JavaHome|InstallationPath)\s+REG_\w+\s+(.+?)\s*$/iu.exec(line);
      if (!match?.[1]) continue;
      candidates.push({
        path: join(match[1].replace(/^"|"$/gu, ""), "bin", "java.exe"),
        source: "registry",
      });
    }
  }
  return candidates;
}

async function windowsWhereCandidates(): Promise<readonly JavaCandidate[]> {
  const output = await runTextCommand("where.exe", ["java"]);
  return output
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => ({ path, source: "path" as const }));
}

function runTextCommand(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput) => {
    execFile(
      file,
      [...args],
      {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: commandOutputLimit,
        encoding: "utf8",
      },
      (error, stdout) => resolveOutput(error ? "" : stdout),
    );
  });
}

async function searchCommonJavaDirectories(
  platform: NodeJS.Platform,
  environment: Readonly<NodeJS.ProcessEnv>,
  maximumDepth: number,
  maximumDirectories: number,
): Promise<readonly JavaCandidate[]> {
  const candidates: JavaCandidate[] = [];
  let remainingDirectories = maximumDirectories;
  for (const root of commonSearchRoots(platform, environment)) {
    if (remainingDirectories <= 0) break;
    const result = await walkJavaRoot(root, platform, maximumDepth, remainingDirectories);
    candidates.push(...result.candidates);
    remainingDirectories -= result.visitedDirectories;
  }
  return candidates;
}

function commonSearchRoots(
  platform: NodeJS.Platform,
  environment: Readonly<NodeJS.ProcessEnv>,
): readonly SearchRoot[] {
  const roots: SearchRoot[] = [];
  const add = (path: string | undefined, selective = false): void => {
    if (path) roots.push({ path: resolve(path), selective });
  };

  if (platform === "win32") {
    add(environment.APPDATA && join(environment.APPDATA, ".minecraft", "runtime"));
    add(
      environment.LOCALAPPDATA &&
        join(
          environment.LOCALAPPDATA,
          "Packages",
          "Microsoft.4297127D64EC6_8wekyb3d8bbwe",
          "LocalCache",
          "Local",
          "runtime",
        ),
    );
    add(environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, "Programs"), true);
    add(environment.USERPROFILE && join(environment.USERPROFILE, ".jdks"));
    add(environment.USERPROFILE && join(environment.USERPROFILE, ".gradle", "jdks"));
    add(environment.USERPROFILE && join(environment.USERPROFILE, ".minecraft", "runtime"));
    add(environment.USERPROFILE && join(environment.USERPROFILE, "scoop", "apps"), true);
    add(environment.ProgramFiles, true);
    add(environment["ProgramFiles(x86)"], true);
    add(environment.ProgramW6432, true);
    add(environment.SystemDrive && join(environment.SystemDrive, "Java"));
  } else if (platform === "darwin") {
    add("/Library/Java/JavaVirtualMachines");
    add(environment.HOME && join(environment.HOME, "Library", "Java", "JavaVirtualMachines"));
    add(environment.HOME && join(environment.HOME, ".sdkman", "candidates", "java"));
  } else {
    add("/usr/lib/jvm");
    add("/usr/java");
    add("/opt", true);
    add("/usr/local", true);
    add(environment.HOME && join(environment.HOME, ".sdkman", "candidates", "java"));
    add(environment.HOME && join(environment.HOME, ".minecraft", "runtime"));
  }

  const unique = new Map<string, SearchRoot>();
  for (const root of roots) unique.set(normalizePathKey(root.path, platform), root);
  return [...unique.values()];
}

async function walkJavaRoot(
  root: SearchRoot,
  platform: NodeJS.Platform,
  maximumDepth: number,
  maximumDirectories: number,
): Promise<{ readonly candidates: readonly JavaCandidate[]; readonly visitedDirectories: number }> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root.path, depth: 0 }];
  const candidates: JavaCandidate[] = [];
  let cursor = 0;
  let visitedDirectories = 0;
  const executableName = javaExecutableName(platform).toLocaleLowerCase("en-US");

  while (cursor < queue.length && visitedDirectories < maximumDirectories) {
    const current = queue[cursor++]!;
    if (current.depth > maximumDepth) continue;
    visitedDirectories += 1;
    let entries: Dirent[];
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isFile() && entry.name.toLocaleLowerCase("en-US") === executableName) {
        candidates.push({ path, source: "filesystem" });
        continue;
      }
      if (!entry.isDirectory() || current.depth === maximumDepth) continue;
      if (shouldSkipDirectory(entry.name)) continue;
      if (root.selective && !shouldExploreNanaloveyukiDirectory(entry.name)) continue;
      queue.push({ path, depth: current.depth + 1 });
    }
  }

  return { candidates, visitedDirectories };
}

function shouldSkipDirectory(name: string): boolean {
  const lower = name.toLocaleLowerCase("en-US");
  return excludedDirectoryFragments.some((fragment) => lower.includes(fragment));
}

export function shouldExploreNanaloveyukiDirectory(name: string): boolean {
  const lower = name.toLocaleLowerCase("en-US");
  if (structuralDirectoryNames.has(lower)) return true;
  if (searchKeywords.some((keyword) => lower.includes(keyword))) return true;
  return /^(?=.*\d)[\d._-]{1,32}$/u.test(lower);
}

function javaExecutableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "java.exe" : "java";
}

function normalizeWindowsExtendedPath(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.replace(/^\\\\\?\\/u, "") || path : path;
}

function normalizePathKey(path: string, platform: NodeJS.Platform): string {
  const normalized = normalizeWindowsExtendedPath(resolve(path), platform);
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}
