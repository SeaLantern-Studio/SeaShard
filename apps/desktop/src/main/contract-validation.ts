import {
  serverCoreIconHost,
  serverCoreIconScheme,
  serverInstanceIconHost,
  serverDownloadConnectionLimits,
  serverJvmArgumentsMaximumLength,
  serverPortLimits,
  serverModSearchLimits,
  serverModLoaders,
  type FileDownloadTaskSnapshot,
  type JavaInstallationSnapshot,
  type JavaInstallationSource,
  type ServerConsoleLine,
  type ServerConfigurationCatalog,
  type ServerConfigurationDocument,
  type ServerConfigurationFile,
  type ServerCoreArtifact,
  type ServerCoreDownloadTaskSnapshot,
  type ServerCoreManagedDownloadResult,
  type ServerInstanceSnapshot,
  type ServerCoreType,
  type ServerRuntimeSnapshot,
  type ServerSettingsSnapshot,
  type ServerModEnvironment,
  type ServerModFilterOption,
  type ServerModFilters,
  type ServerModDownloadResult,
  type ServerModProject,
  type ServerModProjectDetails,
  type ServerModSearchResult,
  type ServerModVersion,
} from "@seashard/contracts";
import { isAbsolute } from "node:path";

function isServerCoreIconUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === `${serverCoreIconScheme}:` &&
      url.hostname === serverCoreIconHost &&
      /^\/[a-f0-9]{64}$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function expectServerCoreTypes(value: unknown): ServerCoreType[] {
  if (!Array.isArray(value)) {
    throw new Error("server core source returned invalid types");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`server core source returned invalid type ${index}`);
    }
    const id = Reflect.get(item, "id");
    const iconUrl = Reflect.get(item, "iconUrl");
    if (typeof id !== "string" || !id || (iconUrl !== undefined && !isServerCoreIconUrl(iconUrl))) {
      throw new Error(`server core source returned invalid type ${index}`);
    }
    return { id, ...(iconUrl ? { iconUrl } : {}) };
  });
}

export function expectServerCoreStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`server core source returned invalid ${label}`);
  }
  return value;
}

export function expectServerCoreArtifacts(value: unknown): ServerCoreArtifact[] {
  if (!Array.isArray(value)) {
    throw new Error("server core source returned invalid artifacts");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`server core source returned invalid artifact ${index}`);
    }
    const artifact = item as Record<string, unknown>;
    const fields = ["serverType", "gameVersion", "fileName", "url", "sha256"] as const;
    if (
      artifact.source !== "cnb" ||
      fields.some((field) => typeof artifact[field] !== "string" || !artifact[field])
    ) {
      throw new Error(`server core source returned invalid artifact ${index}`);
    }
    return artifact as unknown as ServerCoreArtifact;
  });
}

const serverModEnvironments = new Set<ServerModEnvironment>([
  "client_and_server",
  "server_only",
  "server_only_client_optional",
  "dedicated_server_only",
  "client_or_server",
  "client_or_server_prefers_both",
]);

function isServerModIconUrl(value: unknown, projectId: unknown): value is string {
  if (typeof value !== "string" || typeof projectId !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "cdn.modrinth.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname.startsWith(`/data/${encodeURIComponent(projectId)}/`)
    );
  } catch {
    return false;
  }
}

function expectServerModFilterOptions(
  value: unknown,
  label: string,
  maximumItems: number,
): ServerModFilterOption[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`server mod source returned invalid ${label}`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`server mod source returned invalid ${label} ${index}`);
    }
    const id = Reflect.get(item, "id");
    const optionLabel = Reflect.get(item, "label");
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 128 ||
      seen.has(id) ||
      typeof optionLabel !== "string" ||
      !optionLabel ||
      optionLabel.length > 200
    ) {
      throw new Error(`server mod source returned invalid ${label} ${index}`);
    }
    seen.add(id);
    return { id, label: optionLabel };
  });
}

export function expectServerModFilters(value: unknown): ServerModFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server mod source returned invalid filters");
  }
  const filters = value as Record<string, unknown>;
  const sources = expectServerModFilterOptions(filters.sources, "sources", 1);
  if (sources.length !== 1 || sources[0]?.id !== "modrinth") {
    throw new Error("server mod source returned invalid sources");
  }
  return {
    sources,
    tags: expectServerModFilterOptions(filters.tags, "tags", 128),
    versions: expectServerModFilterOptions(filters.versions, "versions", 1_024),
    loaders: expectServerModFilterOptions(filters.loaders, "loaders", 64),
  };
}

export function expectServerModSearchResult(value: unknown): ServerModSearchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server mod source returned an invalid search result");
  }
  const result = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(result.offset) ||
    (result.offset as number) < 0 ||
    !Number.isSafeInteger(result.limit) ||
    (result.limit as number) < 0 ||
    (result.limit as number) > serverModSearchLimits.maximumPageSize ||
    !Number.isSafeInteger(result.total) ||
    (result.total as number) < 0 ||
    !Array.isArray(result.items) ||
    result.items.length > (result.limit as number)
  ) {
    throw new Error("server mod source returned an invalid search result");
  }
  return {
    items: result.items.map(expectServerModProject),
    offset: result.offset as number,
    limit: result.limit as number,
    total: result.total as number,
  };
}
export function expectServerModProjectDetails(value: unknown): ServerModProjectDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server mod source returned invalid project details");
  }
  const details = value as Record<string, unknown>;
  if (
    typeof details.projectId !== "string" ||
    !details.projectId ||
    details.projectId.length > 64 ||
    typeof details.body !== "string" ||
    details.body.length > 200_000 ||
    !Array.isArray(details.versions) ||
    details.versions.length > 2_048
  ) {
    throw new Error("server mod source returned invalid project details");
  }
  const seen = new Set<string>();
  return {
    projectId: details.projectId,
    body: details.body,
    versions: details.versions.map((version, index) => {
      const parsed = expectServerModVersion(version, index, details.projectId as string);
      if (seen.has(parsed.id)) {
        throw new Error(`server mod source returned duplicate version ${index}`);
      }
      seen.add(parsed.id);
      return parsed;
    }),
  };
}

export function expectServerModDownloadResult(value: unknown): ServerModDownloadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server mod source returned an invalid download result");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.projectId !== "string" ||
    !result.projectId ||
    typeof result.versionId !== "string" ||
    !result.versionId ||
    typeof result.fileName !== "string" ||
    !result.fileName.toLowerCase().endsWith(".jar") ||
    !["instance", "directory"].includes(String(result.destination)) ||
    (result.instanceId !== undefined &&
      (typeof result.instanceId !== "string" || !result.instanceId)) ||
    !Number.isSafeInteger(result.downloadedBytes) ||
    (result.downloadedBytes as number) < 0
  ) {
    throw new Error("server mod source returned an invalid download result");
  }
  if (
    (result.destination === "instance" && typeof result.instanceId !== "string") ||
    (result.destination === "directory" && result.instanceId !== undefined)
  ) {
    throw new Error("server mod source returned an invalid download destination");
  }
  return result as unknown as ServerModDownloadResult;
}

function expectServerModVersion(
  value: unknown,
  index: number,
  projectId: string,
): ServerModVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`server mod source returned invalid version ${index}`);
  }
  const version = value as Record<string, unknown>;
  if (
    typeof version.id !== "string" ||
    !version.id ||
    version.id.length > 64 ||
    typeof version.fileName !== "string" ||
    !version.fileName ||
    version.fileName.length > 512 ||
    typeof version.datePublished !== "string" ||
    Number.isNaN(Date.parse(version.datePublished)) ||
    !Number.isSafeInteger(version.downloads) ||
    (version.downloads as number) < 0
  ) {
    throw new Error(`server mod source returned invalid version ${index} for ${projectId}`);
  }
  return {
    id: version.id,
    gameVersions: expectServerModStrings(
      version.gameVersions,
      `version ${index} game versions`,
      512,
    ),
    loaders: expectServerModStrings(version.loaders, `version ${index} loaders`, 64),
    fileName: version.fileName,
    downloads: version.downloads as number,
    datePublished: version.datePublished,
  };
}

function expectServerModProject(value: unknown, index: number): ServerModProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`server mod source returned invalid project ${index}`);
  }
  const project = value as Record<string, unknown>;
  const requiredStrings = ["id", "slug", "title", "description", "author", "dateModified"] as const;
  const environment = expectServerModStrings(
    project.environment,
    `project ${index} environment`,
    16,
  );
  if (
    project.source !== "modrinth" ||
    requiredStrings.some(
      (field) =>
        typeof project[field] !== "string" ||
        (field !== "description" && !project[field]) ||
        (project[field] as string).length > 1_000,
    ) ||
    (project.iconUrl !== undefined && !isServerModIconUrl(project.iconUrl, project.id)) ||
    Number.isNaN(Date.parse(project.dateModified as string)) ||
    !Number.isSafeInteger(project.downloads) ||
    (project.downloads as number) < 0 ||
    !Number.isSafeInteger(project.follows) ||
    (project.follows as number) < 0 ||
    environment.length === 0 ||
    environment.some((item) => !serverModEnvironments.has(item as ServerModEnvironment))
  ) {
    throw new Error(`server mod source returned invalid project ${index}`);
  }
  return {
    source: "modrinth",
    id: project.id as string,
    slug: project.slug as string,
    title: project.title as string,
    ...(project.iconUrl ? { iconUrl: project.iconUrl as string } : {}),
    description: project.description as string,
    author: project.author as string,
    downloads: project.downloads as number,
    follows: project.follows as number,
    dateModified: project.dateModified as string,
    environment: environment as ServerModEnvironment[],
    categories: expectServerModStrings(project.categories, `project ${index} categories`, 64),
    versions: expectServerModStrings(project.versions, `project ${index} versions`, 512),
  };
}

function expectServerModStrings(value: unknown, label: string, maximumItems: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumItems ||
    value.some((item) => typeof item !== "string" || !item || item.length > 128)
  ) {
    throw new Error(`server mod source returned invalid ${label}`);
  }
  return value;
}

/** 公共下载中心只投影显式标记为用户可见的任务，并剥离 URL 与业务 metadata。 */
export function expectFileDownloadTasks(value: unknown): FileDownloadTaskSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("download service returned invalid file download tasks");
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("download service returned an invalid file download task");
    }
    const task = item as Record<string, unknown>;
    const metadata = task.metadata;
    if (
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      Reflect.get(metadata, "userVisible") !== true
    ) {
      return [];
    }
    return [expectFileDownloadTask(task)];
  });
}

function expectFileDownloadTask(task: Record<string, unknown>): FileDownloadTaskSnapshot {
  const state = task.state;
  const stringFields = ["id", "destinationPath", "createdAt"] as const;
  const numericFields = ["downloadedBytes", "totalBytes", "connections", "progress"] as const;
  if (
    stringFields.some((field) => typeof task[field] !== "string" || !task[field]) ||
    numericFields.some(
      (field) => typeof task[field] !== "number" || !Number.isFinite(task[field]),
    ) ||
    !["queued", "downloading", "completed", "failed", "cancelled"].includes(String(state)) ||
    (task.finishedAt !== undefined && typeof task.finishedAt !== "string") ||
    (task.error !== undefined && typeof task.error !== "string")
  ) {
    throw new Error("download service returned an invalid file download task");
  }
  return {
    id: task.id as string,
    destinationPath: task.destinationPath as string,
    state: state as FileDownloadTaskSnapshot["state"],
    downloadedBytes: task.downloadedBytes as number,
    totalBytes: task.totalBytes as number,
    connections: task.connections as number,
    progress: task.progress as number,
    createdAt: task.createdAt as string,
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt as string }),
    ...(task.error === undefined ? {} : { error: task.error as string }),
  };
}

export function expectServerCoreDownloadTask(value: unknown): ServerCoreDownloadTaskSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server core source returned an invalid download task");
  }
  const task = value as Record<string, unknown>;
  const artifact = expectServerCoreArtifacts([task.artifact])[0]!;
  const state = task.state;
  const stringFields = ["id", "destinationPath", "createdAt"] as const;
  const numericFields = ["downloadedBytes", "totalBytes", "connections", "progress"] as const;
  if (
    stringFields.some((field) => typeof task[field] !== "string" || !task[field]) ||
    numericFields.some(
      (field) => typeof task[field] !== "number" || !Number.isFinite(task[field]),
    ) ||
    !["queued", "downloading", "completed", "failed", "cancelled"].includes(String(state)) ||
    (task.finishedAt !== undefined && typeof task.finishedAt !== "string") ||
    (task.error !== undefined && typeof task.error !== "string")
  ) {
    throw new Error("server core source returned an invalid download task");
  }
  return { ...task, artifact } as unknown as ServerCoreDownloadTaskSnapshot;
}

export function expectServerCoreDownloadTasks(value: unknown): ServerCoreDownloadTaskSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("server core source returned invalid download tasks");
  }
  return value.map(expectServerCoreDownloadTask);
}

export function expectManagedDownloadResult(value: unknown): ServerCoreManagedDownloadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server instance manager returned an invalid managed download");
  }
  const instanceId = Reflect.get(value, "instanceId");
  const task = Reflect.get(value, "task");
  if (typeof instanceId !== "string" || !instanceId) {
    throw new Error("server instance manager returned an invalid managed download");
  }
  return {
    instanceId,
    task: expectServerCoreDownloadTask(task),
  };
}

export function expectServerInstances(value: unknown): ServerInstanceSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("server instance manager returned invalid instances");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`server instance manager returned invalid instance ${index}`);
    }
    const instance = item as Record<string, unknown>;
    const requiredStrings = [
      "id",
      "name",
      "rootPath",
      "coreJarPath",
      "createdAt",
      "updatedAt",
    ] as const;
    const optionalStrings = [
      "iconPath",
      "serverType",
      "gameVersion",
      "coreArtifactFileName",
      "artifactSha256",
      "lastStartedAt",
    ] as const;
    if (
      requiredStrings.some((field) => typeof instance[field] !== "string" || !instance[field]) ||
      optionalStrings.some(
        (field) => instance[field] !== undefined && typeof instance[field] !== "string",
      ) ||
      (instance.totalRuntimeMs !== undefined &&
        (!Number.isSafeInteger(instance.totalRuntimeMs) ||
          (instance.totalRuntimeMs as number) < 0)) ||
      !["managed", "external"].includes(String(instance.storageMode)) ||
      !["downloaded", "imported"].includes(String(instance.source)) ||
      !(
        instance.modLoader === null ||
        (typeof instance.modLoader === "string" &&
          (serverModLoaders as readonly string[]).includes(instance.modLoader))
      )
    ) {
      throw new Error(`server instance manager returned invalid instance ${index}`);
    }
    const snapshot = instance as unknown as ServerInstanceSnapshot;
    return {
      ...snapshot,
      ...(snapshot.iconPath
        ? {
            iconUrl: `${serverCoreIconScheme}://${serverInstanceIconHost}/${encodeURIComponent(snapshot.id)}`,
          }
        : {}),
    };
  });
}

const serverConfigurationKinds = new Set(["properties", "yaml", "json", "toml", "text"]);

export function expectServerConfigurationFile(
  value: unknown,
  label: string,
): ServerConfigurationFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`server configuration returned invalid ${label}`);
  }
  const file = value as Record<string, unknown>;
  if (
    typeof file.path !== "string" ||
    !file.path ||
    file.path.startsWith("/") ||
    file.path.includes("\\") ||
    file.path.split("/").some((part) => !part || part === "." || part === "..") ||
    typeof file.name !== "string" ||
    !file.name ||
    !serverConfigurationKinds.has(String(file.kind)) ||
    !["server", "other", "plugin"].includes(String(file.scope)) ||
    (file.pluginName !== undefined && (typeof file.pluginName !== "string" || !file.pluginName))
  ) {
    throw new Error(`server configuration returned invalid ${label}`);
  }
  return file as unknown as ServerConfigurationFile;
}

export function expectServerConfigurationCatalog(value: unknown): ServerConfigurationCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server configuration returned an invalid catalog");
  }
  const catalog = value as Record<string, unknown>;
  if (
    typeof catalog.instanceId !== "string" ||
    !catalog.instanceId ||
    typeof catalog.configurationRootPath !== "string" ||
    !isAbsolute(catalog.configurationRootPath) ||
    (catalog.serverType !== undefined && typeof catalog.serverType !== "string") ||
    typeof catalog.pluginSupported !== "boolean" ||
    !Array.isArray(catalog.serverFiles) ||
    !Array.isArray(catalog.otherFiles) ||
    !Array.isArray(catalog.plugins)
  ) {
    throw new Error("server configuration returned an invalid catalog");
  }
  const serverFiles = catalog.serverFiles.map((file, index) =>
    expectServerConfigurationFile(file, `server file ${index}`),
  );
  const otherFiles = catalog.otherFiles.map((file, index) =>
    expectServerConfigurationFile(file, `other file ${index}`),
  );
  const plugins = catalog.plugins.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`server configuration returned invalid plugin ${index}`);
    }
    const plugin = value as Record<string, unknown>;
    if (typeof plugin.name !== "string" || !plugin.name || !Array.isArray(plugin.files)) {
      throw new Error(`server configuration returned invalid plugin ${index}`);
    }
    return {
      name: plugin.name,
      files: plugin.files.map((file, fileIndex) =>
        expectServerConfigurationFile(file, `plugin ${index} file ${fileIndex}`),
      ),
    };
  });
  return {
    instanceId: catalog.instanceId,
    configurationRootPath: catalog.configurationRootPath,
    ...(catalog.serverType ? { serverType: catalog.serverType as string } : {}),
    pluginSupported: catalog.pluginSupported,
    serverFiles,
    otherFiles,
    plugins,
  };
}

export function expectServerConfigurationDocument(value: unknown): ServerConfigurationDocument {
  const file = expectServerConfigurationFile(value, "document");
  const document = value as unknown as Record<string, unknown>;
  if (
    typeof document.instanceId !== "string" ||
    !document.instanceId ||
    typeof document.content !== "string" ||
    typeof document.revision !== "string" ||
    !/^[a-f0-9]{64}$/u.test(document.revision) ||
    !["utf-8", "utf-8-bom"].includes(String(document.encoding)) ||
    typeof document.modifiedAt !== "string" ||
    !document.modifiedAt
  ) {
    throw new Error("server configuration returned an invalid document");
  }
  return { ...file, ...document } as ServerConfigurationDocument;
}

const javaInstallationSources = new Set<JavaInstallationSource>([
  "java-home",
  "path",
  "registry",
  "filesystem",
  "manual",
]);

/** 收窄 Host 组件返回值，禁止未经验证的文件系统路径进入 Renderer。 */
export function expectJavaInstallation(
  value: unknown,
  label = "installation",
): JavaInstallationSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`java runtime manager returned invalid ${label}`);
  }
  const installation = value as Record<string, unknown>;
  const requiredStrings = ["id", "path", "javaHome", "version", "vendor", "architecture"] as const;
  if (
    requiredStrings.some(
      (field) => typeof installation[field] !== "string" || !installation[field],
    ) ||
    !isAbsolute(installation.path as string) ||
    !isAbsolute(installation.javaHome as string) ||
    !Number.isSafeInteger(installation.majorVersion) ||
    (installation.majorVersion as number) <= 0 ||
    typeof installation.is64Bit !== "boolean" ||
    typeof installation.disabled !== "boolean" ||
    !javaInstallationSources.has(installation.source as JavaInstallationSource)
  ) {
    throw new Error(`java runtime manager returned invalid ${label}`);
  }
  return installation as unknown as JavaInstallationSnapshot;
}

export function expectJavaInstallations(value: unknown): JavaInstallationSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("java runtime manager returned invalid installations");
  }
  return value.map((item, index) => expectJavaInstallation(item, `installation ${index}`));
}

export function expectServerSettingsSnapshot(value: unknown): ServerSettingsSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server settings returned an invalid snapshot");
  }
  const resourceDownloadDirectory = Reflect.get(value, "resourceDownloadDirectory");
  const defaultDownloadConnections = Reflect.get(value, "defaultDownloadConnections");
  const defaultMinimumMemoryMiB = Reflect.get(value, "defaultMinimumMemoryMiB");
  const defaultMaximumMemoryMiB = Reflect.get(value, "defaultMaximumMemoryMiB");
  const defaultServerPort = Reflect.get(value, "defaultServerPort");
  const autoAcceptEula = Reflect.get(value, "autoAcceptEula");
  const defaultJvmArguments = Reflect.get(value, "defaultJvmArguments");
  if (
    typeof resourceDownloadDirectory !== "string" ||
    !Number.isSafeInteger(defaultDownloadConnections) ||
    (defaultDownloadConnections as number) < serverDownloadConnectionLimits.minimum ||
    (defaultDownloadConnections as number) > serverDownloadConnectionLimits.maximum ||
    !Number.isSafeInteger(defaultMinimumMemoryMiB) ||
    (defaultMinimumMemoryMiB as number) <= 0 ||
    !Number.isSafeInteger(defaultMaximumMemoryMiB) ||
    (defaultMaximumMemoryMiB as number) < (defaultMinimumMemoryMiB as number) ||
    !Number.isSafeInteger(defaultServerPort) ||
    (defaultServerPort as number) < serverPortLimits.minimum ||
    (defaultServerPort as number) > serverPortLimits.maximum ||
    typeof autoAcceptEula !== "boolean" ||
    typeof defaultJvmArguments !== "string" ||
    defaultJvmArguments.length > serverJvmArgumentsMaximumLength ||
    defaultJvmArguments.includes("\0")
  ) {
    throw new Error("server settings returned an invalid snapshot");
  }
  return {
    resourceDownloadDirectory,
    defaultDownloadConnections: defaultDownloadConnections as number,
    defaultMinimumMemoryMiB: defaultMinimumMemoryMiB as number,
    defaultMaximumMemoryMiB: defaultMaximumMemoryMiB as number,
    defaultServerPort: defaultServerPort as number,
    autoAcceptEula,
    defaultJvmArguments,
  };
}

export function expectServerRuntimeSnapshot(value: unknown): ServerRuntimeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server runtime returned an invalid snapshot");
  }
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.instanceId !== "string" ||
    !snapshot.instanceId ||
    !["stopped", "starting", "running", "stopping", "failed"].includes(String(snapshot.state)) ||
    (snapshot.pid !== undefined &&
      (!Number.isSafeInteger(snapshot.pid) || (snapshot.pid as number) <= 0)) ||
    (snapshot.startedAt !== undefined && typeof snapshot.startedAt !== "string") ||
    (snapshot.stoppedAt !== undefined && typeof snapshot.stoppedAt !== "string") ||
    (snapshot.exitCode !== undefined && !Number.isSafeInteger(snapshot.exitCode)) ||
    (snapshot.error !== undefined && typeof snapshot.error !== "string")
  ) {
    throw new Error("server runtime returned an invalid snapshot");
  }
  return snapshot as unknown as ServerRuntimeSnapshot;
}

export function expectServerConsoleLine(value: unknown): ServerConsoleLine {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server runtime returned an invalid console line");
  }
  const line = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(line.sequence) ||
    (line.sequence as number) <= 0 ||
    typeof line.instanceId !== "string" ||
    !line.instanceId ||
    !["stdout", "stderr", "input", "system"].includes(String(line.stream)) ||
    typeof line.text !== "string" ||
    typeof line.timestamp !== "string" ||
    !line.timestamp
  ) {
    throw new Error("server runtime returned an invalid console line");
  }
  return line as unknown as ServerConsoleLine;
}

export function expectServerConsoleLines(value: unknown): ServerConsoleLine[] {
  if (!Array.isArray(value)) {
    throw new Error("server runtime returned invalid console lines");
  }
  return value.map(expectServerConsoleLine);
}
