import {
  serverCoreIconHost,
  serverCoreIconScheme,
  serverInstanceIconHost,
  serverDownloadConnectionLimits,
  serverJvmArgumentsMaximumLength,
  serverPortLimits,
  serverModSearchLimits,
  serverModLoaders,
  isServerModSource,
  type AgentConfiguredModel,
  type AgentInvocationReference,
  type AgentInvocationSnapshot,
  type AgentMessageSnapshot,
  type AgentModelSelection,
  type AgentSessionSnapshot,
  type AgentSessionSummary,
  type AgentToolCallSnapshot,
  type FileDownloadTaskSnapshot,
  type JavaInstallationSnapshot,
  type JavaInstallationSource,
  type ServerConsoleLine,
  type ServerConfigurationCatalog,
  type ServerConfigurationDocument,
  type ServerConfigurationFile,
  type ServerCoreArtifact,
  type ServerCoreType,
  type ServerCoreDownloadTaskSnapshot,
  type ServerCoreManagedDownloadResult,
  type ServerInstanceContentCounts,
  type ServerInstanceStartupSettings,
  type ServerInstanceSnapshot,
  type ServerInstalledModSnapshot,
  type ServerWorldBackupSnapshot,
  type ServerWorldDatapackSnapshot,
  type ServerWorldStorageSnapshot,
  type ServerRuntimeSnapshot,
  type ServerLaunchCommandPreview,
  type ServerSettingsSnapshot,
  type ServerModEnvironment,
  type ServerModFilterOption,
  type ServerModFilters,
  type ServerModDownloadResult,
  type ServerModProject,
  type ServerResourceSourceMetadata,
  type ServerModSource,
  type ServerModrinthResourceType,
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

function isServerImageDataUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^data:image\/(?:png|gif|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)
  );
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
  "client_only_server_optional",
  "client_only",
]);
const serverModResourceTypes = new Set<ServerModrinthResourceType>([
  "mod",
  "modpack",
  "datapack",
  "world",
]);
const serverResourceSourcePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function isServerModIconUrl(value: unknown, projectId: unknown, source: unknown): value is string {
  if (typeof value !== "string" || typeof projectId !== "string") return false;
  try {
    const url = new URL(value);
    if (
      source === "modrinth" &&
      url.protocol === "https:" &&
      url.hostname === "cdn.modrinth.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname.startsWith(`/data/${encodeURIComponent(projectId)}/`)
    ) {
      return true;
    }
    return (
      source === "curseforge" &&
      url.protocol === "https:" &&
      (url.hostname === "media.forgecdn.net" || url.hostname === "mod.mcimirror.top") &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isServerResourceIconUrl(
  value: unknown,
  projectId: string,
  source: string,
): value is string {
  if (isServerModSource(source)) return isServerModIconUrl(value, projectId, source);
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash
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

function expectOptionalServerModUnavailableReason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 256) {
    throw new Error("server mod source returned invalid unavailable reason");
  }
  return value;
}

export function expectServerModFilters(value: unknown): ServerModFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server mod source returned invalid filters");
  }
  const filters = value as Record<string, unknown>;
  const sources = expectServerModFilterOptions(filters.sources, "sources", 1);
  if (sources.length !== 1 || (sources[0]?.id !== "modrinth" && sources[0]?.id !== "curseforge")) {
    throw new Error("server mod source returned invalid sources");
  }
  const unavailableReason = expectOptionalServerModUnavailableReason(filters.unavailableReason);
  return {
    sources,
    tags: expectServerModFilterOptions(filters.tags, "tags", 128),
    versions: expectServerModFilterOptions(filters.versions, "versions", 1_024),
    loaders: expectServerModFilterOptions(filters.loaders, "loaders", 64),
    ...(unavailableReason ? { unavailableReason } : {}),
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
  const unavailableReason = expectOptionalServerModUnavailableReason(result.unavailableReason);
  return {
    items: result.items.map(expectServerModProject),
    offset: result.offset as number,
    limit: result.limit as number,
    total: result.total as number,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}
export function expectServerModProjectDetails(value: unknown): ServerModProjectDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server resource source returned invalid project details");
  }
  const details = value as Record<string, unknown>;
  if (
    typeof details.resourceType !== "string" ||
    !serverModResourceTypes.has(details.resourceType as ServerModrinthResourceType) ||
    (details.source !== "modrinth" && details.source !== "curseforge") ||
    typeof details.projectId !== "string" ||
    !details.projectId ||
    details.projectId.length > 64 ||
    typeof details.body !== "string" ||
    details.body.length > 200_000 ||
    !Array.isArray(details.versions) ||
    details.versions.length > 2_048 ||
    !details.project
  ) {
    throw new Error("server resource source returned invalid project details");
  }
  const project = expectServerModProject(details.project, 0);
  if (
    project.resourceType !== details.resourceType ||
    project.source !== details.source ||
    project.id !== details.projectId
  ) {
    throw new Error("server resource source returned mismatched project details");
  }
  const seen = new Set<string>();
  return {
    resourceType: details.resourceType as ServerModrinthResourceType,
    source: details.source as ServerModSource,
    projectId: details.projectId,
    project,
    body: details.body,
    versions: details.versions.map((version, index) => {
      const parsed = expectServerModVersion(version, index, details.projectId as string);
      if (seen.has(parsed.id)) {
        throw new Error(`server resource source returned duplicate version ${index}`);
      }
      seen.add(parsed.id);
      return parsed;
    }),
  };
}
export function expectServerModDownloadResult(value: unknown): ServerModDownloadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server resource source returned an invalid download result");
  }
  const result = value as Record<string, unknown>;
  const fileName = typeof result.fileName === "string" ? result.fileName : "";
  const validExtensions =
    result.resourceType === "mod"
      ? [".jar"]
      : result.resourceType === "modpack"
        ? [".mrpack", ".zip"]
        : result.resourceType === "datapack" || result.resourceType === "world"
          ? [".zip"]
          : [];
  if (
    (result.source !== "modrinth" && result.source !== "curseforge") ||
    validExtensions.length === 0 ||
    typeof result.projectId !== "string" ||
    !result.projectId ||
    typeof result.versionId !== "string" ||
    !result.versionId ||
    typeof result.fileName !== "string" ||
    !validExtensions.some((extension) => fileName.toLowerCase().endsWith(extension)) ||
    !["instance", "directory"].includes(String(result.destination)) ||
    (result.instanceId !== undefined &&
      (typeof result.instanceId !== "string" || !result.instanceId)) ||
    !Number.isSafeInteger(result.downloadedBytes) ||
    (result.downloadedBytes as number) < 0
  ) {
    throw new Error("server resource source returned an invalid download result");
  }
  if (
    (result.destination === "instance" && typeof result.instanceId !== "string") ||
    (result.destination === "directory" && result.instanceId !== undefined)
  ) {
    throw new Error("server resource source returned an invalid download destination");
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
    throw new Error(`server resource source returned invalid project ${index}`);
  }
  const project = value as Record<string, unknown>;
  const requiredStrings = ["id", "slug", "title", "description", "author", "dateModified"] as const;
  const environment = expectServerModStrings(
    project.environment,
    `project ${index} environment`,
    16,
  );
  if (
    typeof project.resourceType !== "string" ||
    !serverModResourceTypes.has(project.resourceType as ServerModrinthResourceType) ||
    (project.source !== "modrinth" && project.source !== "curseforge") ||
    requiredStrings.some(
      (field) =>
        typeof project[field] !== "string" ||
        (field !== "description" && !project[field]) ||
        (project[field] as string).length > 1_000,
    ) ||
    (project.iconUrl !== undefined &&
      !isServerModIconUrl(project.iconUrl, project.id, project.source)) ||
    Number.isNaN(Date.parse(project.dateModified as string)) ||
    !Number.isSafeInteger(project.downloads) ||
    (project.downloads as number) < 0 ||
    !Number.isSafeInteger(project.follows) ||
    (project.follows as number) < 0 ||
    environment.length === 0 ||
    environment.some((item) => !serverModEnvironments.has(item as ServerModEnvironment))
  ) {
    throw new Error(`server resource source returned invalid project ${index}`);
  }
  return {
    resourceType: project.resourceType as ServerModrinthResourceType,
    source: project.source as ServerModSource,
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

function expectServerInstanceStartupSettings(
  value: unknown,
  index: number,
): ServerInstanceStartupSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`server instance manager returned invalid startup settings ${index}`);
  }
  const settings = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(settings.minimumMemoryMiB) ||
    (settings.minimumMemoryMiB as number) <= 0 ||
    !Number.isSafeInteger(settings.maximumMemoryMiB) ||
    (settings.maximumMemoryMiB as number) < (settings.minimumMemoryMiB as number) ||
    !Number.isSafeInteger(settings.serverPort) ||
    (settings.serverPort as number) < serverPortLimits.minimum ||
    (settings.serverPort as number) > serverPortLimits.maximum ||
    typeof settings.autoAcceptEula !== "boolean" ||
    typeof settings.jvmArguments !== "string" ||
    settings.jvmArguments.length > serverJvmArgumentsMaximumLength ||
    settings.jvmArguments.includes("\0")
  ) {
    throw new Error(`server instance manager returned invalid startup settings ${index}`);
  }
  return {
    minimumMemoryMiB: settings.minimumMemoryMiB as number,
    maximumMemoryMiB: settings.maximumMemoryMiB as number,
    serverPort: settings.serverPort as number,
    autoAcceptEula: settings.autoAcceptEula,
    jvmArguments: settings.jvmArguments,
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
    const startupSettings =
      instance.startupSettings === undefined
        ? undefined
        : expectServerInstanceStartupSettings(instance.startupSettings, index);
    const snapshot = instance as unknown as ServerInstanceSnapshot;
    const snapshotWithoutResourceSources = Object.fromEntries(
      Object.entries(snapshot).filter(([key]) => key !== "resourceSources"),
    ) as Omit<ServerInstanceSnapshot, "resourceSources">;
    return {
      ...snapshotWithoutResourceSources,
      ...(snapshot.iconPath
        ? {
            iconUrl: `${serverCoreIconScheme}://${serverInstanceIconHost}/${encodeURIComponent(snapshot.id)}`,
          }
        : {}),
      ...(startupSettings ? { startupSettings } : {}),
    };
  });
}

export function expectServerInstanceContentCounts(value: unknown): ServerInstanceContentCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server instance manager returned invalid content counts");
  }
  const mods = Reflect.get(value, "mods");
  const plugins = Reflect.get(value, "plugins");
  if (
    !Number.isSafeInteger(mods) ||
    (mods as number) < 0 ||
    !Number.isSafeInteger(plugins) ||
    (plugins as number) < 0
  ) {
    throw new Error("server instance manager returned invalid content counts");
  }
  return { mods: mods as number, plugins: plugins as number };
}
export function expectServerInstalledMod(
  value: unknown,
  index: number | string,
): ServerInstalledModSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`server instance manager returned invalid mod ${index}`);
  }
  const mod = value as Record<string, unknown>;
  if (
    typeof mod.instanceId !== "string" ||
    !mod.instanceId ||
    !isSafeRelativeModPath(mod.relativePath) ||
    typeof mod.fileName !== "string" ||
    !mod.fileName ||
    /[\\/]/u.test(mod.fileName) ||
    !/\.jar(?:\.disabled)?$/iu.test(mod.fileName) ||
    !mod.relativePath.endsWith(`/${mod.fileName}`) ||
    typeof mod.name !== "string" ||
    !mod.name ||
    mod.name.length > 256 ||
    mod.name.includes("\0") ||
    (mod.version !== undefined &&
      (typeof mod.version !== "string" ||
        mod.version.length > 256 ||
        mod.version.includes("\0"))) ||
    (mod.description !== undefined &&
      (typeof mod.description !== "string" ||
        mod.description.length > 2_000 ||
        mod.description.includes("\0"))) ||
    typeof mod.addedAt !== "string" ||
    !isIsoTimestamp(mod.addedAt) ||
    typeof mod.disabled !== "boolean" ||
    (mod.iconDataUrl !== undefined &&
      (typeof mod.iconDataUrl !== "string" ||
        mod.iconDataUrl.length > 1_000_000 ||
        !isServerImageDataUrl(mod.iconDataUrl)))
  ) {
    throw new Error(`server instance manager returned invalid mod ${index}`);
  }
  const resourceSource = parseOptionalServerResourceSourceMetadata(mod.resourceSource);
  return {
    instanceId: mod.instanceId,
    relativePath: mod.relativePath,
    fileName: mod.fileName,
    name: mod.name,
    ...(typeof mod.version === "string" && mod.version ? { version: mod.version } : {}),
    ...(typeof mod.description === "string" && mod.description
      ? { description: mod.description }
      : {}),
    ...(typeof mod.iconDataUrl === "string" ? { iconDataUrl: mod.iconDataUrl } : {}),
    addedAt: mod.addedAt,
    disabled: mod.disabled,
    ...(resourceSource ? { resourceSource } : {}),
  };
}

export function expectServerInstalledMods(value: unknown): ServerInstalledModSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("server instance manager returned invalid mods");
  }
  return value.map(expectServerInstalledMod);
}

function isSafeRelativeModPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:mods|server\/mods)\/[^/]+\.jar(?:\.disabled)?$/iu.test(value) &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}
export function expectServerWorldStorageSnapshot(value: unknown): ServerWorldStorageSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server instance manager returned invalid world storage");
  }
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.instanceId !== "string" ||
    !snapshot.instanceId ||
    !["unified", "split"].includes(String(snapshot.mode)) ||
    (snapshot.currentId !== undefined && !isSafeRelativeWorldId(snapshot.currentId))
  ) {
    throw new Error("server instance manager returned invalid world storage");
  }
  if (!Array.isArray(snapshot.saves) || !Array.isArray(snapshot.dimensions)) {
    throw new Error("server instance manager returned invalid world storage");
  }
  const saves = snapshot.saves.map((value, index) => expectServerWorldSave(value, index));
  const dimensions = snapshot.dimensions.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`server instance manager returned invalid world dimension ${index}`);
    }
    const group = value as Record<string, unknown>;
    if (
      !isSafeRelativeWorldId(group.id) ||
      typeof group.name !== "string" ||
      !group.name ||
      typeof group.current !== "boolean" ||
      !Array.isArray(group.saves)
    ) {
      throw new Error(`server instance manager returned invalid world dimension ${index}`);
    }
    return {
      id: group.id,
      name: group.name,
      current: group.current,
      saves: group.saves.map((save, saveIndex) =>
        expectServerWorldSave(save, `${index}.${saveIndex}`),
      ),
    };
  });
  return {
    instanceId: snapshot.instanceId,
    mode: snapshot.mode as ServerWorldStorageSnapshot["mode"],
    ...(snapshot.currentId ? { currentId: snapshot.currentId } : {}),
    saves,
    dimensions,
  };
}

function isServerResourceSource(value: unknown): value is string {
  return typeof value === "string" && serverResourceSourcePattern.test(value);
}
function parseOptionalServerResourceSourceMetadata(
  value: unknown,
): ServerResourceSourceMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const metadata = value as Record<string, unknown>;
  const source = metadata.source;
  const id = metadata.id;
  if (
    !isServerResourceSource(source) ||
    typeof id !== "string" ||
    !id ||
    id.length > 256 ||
    id.includes("\0")
  ) {
    return undefined;
  }
  const version =
    typeof metadata.version === "string" &&
    metadata.version.length <= 256 &&
    !metadata.version.includes("\0")
      ? metadata.version
      : undefined;
  const iconUrl =
    metadata.iconUrl !== undefined && isServerResourceIconUrl(metadata.iconUrl, id, source)
      ? metadata.iconUrl
      : undefined;
  return {
    source,
    id,
    ...(version ? { version } : {}),
    ...(iconUrl ? { iconUrl } : {}),
  };
}

function expectServerWorldSave(value: unknown, index: number | string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`server instance manager returned invalid world save ${index}`);
  }
  const save = value as Record<string, unknown>;
  if (
    !isSafeRelativeWorldId(save.id) ||
    !isSafeRelativeWorldId(save.groupId) ||
    typeof save.name !== "string" ||
    !save.name ||
    !["overworld", "nether", "end"].includes(String(save.dimension)) ||
    typeof save.current !== "boolean" ||
    (save.createdAt !== undefined && !isIsoTimestamp(save.createdAt)) ||
    (save.updatedAt !== undefined && !isIsoTimestamp(save.updatedAt)) ||
    (save.iconDataUrl !== undefined && !isServerImageDataUrl(save.iconDataUrl))
  ) {
    throw new Error(`server instance manager returned invalid world save ${index}`);
  }
  const resourceSource = parseOptionalServerResourceSourceMetadata(save.resourceSource);
  return {
    id: save.id,
    groupId: save.groupId,
    name: save.name,
    dimension: save.dimension as "overworld" | "nether" | "end",
    current: save.current,
    ...(typeof save.createdAt === "string" ? { createdAt: save.createdAt } : {}),
    ...(resourceSource ? { resourceSource } : {}),
    ...(typeof save.updatedAt === "string" ? { updatedAt: save.updatedAt } : {}),
    ...(save.iconDataUrl ? { iconDataUrl: save.iconDataUrl } : {}),
  };
}

export function expectServerWorldBackup(value: unknown): ServerWorldBackupSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server instance manager returned invalid world backup");
  }
  const backup = value as Record<string, unknown>;
  if (
    typeof backup.instanceId !== "string" ||
    !backup.instanceId ||
    !isSafeRelativeWorldId(backup.worldId) ||
    typeof backup.worldDirectoryName !== "string" ||
    !backup.worldDirectoryName ||
    /[\\/]/u.test(backup.worldDirectoryName) ||
    typeof backup.fileName !== "string" ||
    !backup.fileName.toLowerCase().endsWith(".zip") ||
    /[\\/]/u.test(backup.fileName) ||
    typeof backup.createdAt !== "string" ||
    !isIsoTimestamp(backup.createdAt) ||
    !Number.isSafeInteger(backup.sizeBytes) ||
    (backup.sizeBytes as number) < 0
  ) {
    throw new Error("server instance manager returned invalid world backup");
  }
  return {
    instanceId: backup.instanceId,
    worldId: backup.worldId,
    worldDirectoryName: backup.worldDirectoryName,
    fileName: backup.fileName,
    createdAt: backup.createdAt,
    sizeBytes: backup.sizeBytes as number,
  };
}

export function expectServerWorldBackups(value: unknown): ServerWorldBackupSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("server instance manager returned invalid world backups");
  }
  return value.map(expectServerWorldBackup);
}

export function expectServerWorldDatapack(value: unknown): ServerWorldDatapackSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server instance manager returned invalid world datapack");
  }
  const datapack = value as Record<string, unknown>;
  if (
    typeof datapack.instanceId !== "string" ||
    !datapack.instanceId ||
    !isSafeRelativeWorldId(datapack.worldId) ||
    typeof datapack.fileName !== "string" ||
    !datapack.fileName ||
    /[\\/]/u.test(datapack.fileName) ||
    !["archive", "directory"].includes(String(datapack.kind)) ||
    typeof datapack.disabled !== "boolean" ||
    (datapack.description !== undefined &&
      (typeof datapack.description !== "string" ||
        datapack.description.length > 2_000 ||
        datapack.description.includes("\0"))) ||
    (datapack.iconDataUrl !== undefined && !isServerImageDataUrl(datapack.iconDataUrl)) ||
    typeof datapack.updatedAt !== "string" ||
    !isIsoTimestamp(datapack.updatedAt)
  ) {
    throw new Error("server instance manager returned invalid world datapack");
  }
  const resourceSource = parseOptionalServerResourceSourceMetadata(datapack.resourceSource);
  return {
    instanceId: datapack.instanceId,
    worldId: datapack.worldId,
    ...(resourceSource ? { resourceSource } : {}),
    fileName: datapack.fileName,
    kind: datapack.kind as ServerWorldDatapackSnapshot["kind"],
    disabled: datapack.disabled,
    ...(typeof datapack.description === "string" && datapack.description
      ? { description: datapack.description }
      : {}),
    ...(typeof datapack.iconDataUrl === "string" ? { iconDataUrl: datapack.iconDataUrl } : {}),
    updatedAt: datapack.updatedAt,
  };
}

export function expectServerWorldDatapacks(value: unknown): ServerWorldDatapackSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("server instance manager returned invalid world datapacks");
  }
  return value.map(expectServerWorldDatapack);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSafeRelativeWorldId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
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

export function expectServerLaunchCommandPreview(value: unknown): ServerLaunchCommandPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server runtime returned an invalid launch command preview");
  }
  const preview = value as Record<string, unknown>;
  if (
    typeof preview.instanceId !== "string" ||
    !preview.instanceId ||
    typeof preview.command !== "string" ||
    !preview.command ||
    preview.command.length > 100_000 ||
    preview.command.includes("\0")
  ) {
    throw new Error("server runtime returned an invalid launch command preview");
  }
  return {
    instanceId: preview.instanceId,
    command: preview.command,
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

export function expectAgentModels(value: unknown): AgentConfiguredModel[] {
  if (!Array.isArray(value)) throw new Error("Agent Runtime returned invalid models");
  return value.map((model, index) => {
    const record = expectAgentRecord(model, `model ${index}`);
    const selection = expectAgentModelSelection(record, `model ${index}`);
    if (
      typeof record.name !== "string" ||
      !record.name ||
      ![
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
        "google-generative-ai",
      ].includes(String(record.api))
    ) {
      throw new Error(`Agent Runtime returned invalid model ${index}`);
    }
    return { ...selection, name: record.name, api: record.api as AgentConfiguredModel["api"] };
  });
}

export function expectAgentSessions(value: unknown): AgentSessionSummary[] {
  if (!Array.isArray(value)) throw new Error("Agent Runtime returned invalid sessions");
  return value.map((session, index) => expectAgentSessionSummary(session, `session ${index}`));
}

export function expectAgentSession(value: unknown): AgentSessionSnapshot {
  const summary = expectAgentSessionSummary(value, "session");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.messages)) throw new Error("Agent Runtime returned invalid messages");
  if (!Array.isArray(record.toolCalls)) {
    throw new Error("Agent Runtime returned invalid tool calls");
  }
  const messages = record.messages.map((message, index): AgentMessageSnapshot => {
    const item = expectAgentRecord(message, `message ${index}`);
    if (
      typeof item.id !== "string" ||
      !item.id ||
      typeof item.invocationId !== "string" ||
      !item.invocationId ||
      (item.role !== "user" && item.role !== "assistant") ||
      typeof item.content !== "string" ||
      typeof item.timestamp !== "string" ||
      !isIsoTimestamp(item.timestamp)
    ) {
      throw new Error(`Agent Runtime returned invalid message ${index}`);
    }
    return {
      id: item.id,
      invocationId: item.invocationId,
      role: item.role,
      content: item.content,
      timestamp: item.timestamp,
    };
  });
  const toolCalls = record.toolCalls.map((call, index) =>
    expectAgentToolCall(call, `tool call ${index}`),
  );
  return { ...summary, messages, toolCalls };
}

export function expectAgentInvocationReference(value: unknown): AgentInvocationReference {
  const record = expectAgentRecord(value, "invocation reference");
  if (
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    typeof record.invocationId !== "string" ||
    !record.invocationId
  ) {
    throw new Error("Agent Runtime returned invalid invocation reference");
  }
  return { sessionId: record.sessionId, invocationId: record.invocationId };
}

export function expectAgentInvocation(value: unknown): AgentInvocationSnapshot {
  const record = expectAgentRecord(value, "invocation");
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    !["running", "completed", "cancelled", "failed"].includes(String(record.state)) ||
    typeof record.startedAt !== "string" ||
    !isIsoTimestamp(record.startedAt) ||
    typeof record.text !== "string" ||
    !Array.isArray(record.toolCalls) ||
    (record.finishedAt !== undefined && !isIsoTimestamp(record.finishedAt)) ||
    (record.error !== undefined && typeof record.error !== "string")
  ) {
    throw new Error("Agent Runtime returned invalid invocation");
  }
  return {
    id: record.id,
    sessionId: record.sessionId,
    state: record.state as AgentInvocationSnapshot["state"],
    model: expectAgentModelSelection(record.model, "invocation model"),
    startedAt: record.startedAt,
    text: record.text,
    toolCalls: record.toolCalls.map((call, index) =>
      expectAgentToolCall(call, `invocation tool call ${index}`),
    ),
    ...(typeof record.finishedAt === "string" ? { finishedAt: record.finishedAt } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

function expectAgentToolCall(value: unknown, label: string): AgentToolCallSnapshot {
  const record = expectAgentRecord(value, label);
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.invocationId !== "string" ||
    !record.invocationId ||
    typeof record.toolName !== "string" ||
    !record.toolName ||
    typeof record.title !== "string" ||
    !record.title ||
    !["running", "completed", "cancelled", "failed"].includes(String(record.state)) ||
    typeof record.startedAt !== "string" ||
    !isIsoTimestamp(record.startedAt) ||
    (record.finishedAt !== undefined && !isIsoTimestamp(record.finishedAt)) ||
    (record.error !== undefined && typeof record.error !== "string")
  ) {
    throw new Error(`Agent Runtime returned invalid ${label}`);
  }
  return {
    id: record.id,
    invocationId: record.invocationId,
    toolName: record.toolName,
    title: record.title,
    state: record.state as AgentToolCallSnapshot["state"],
    input: expectAgentJsonValue(record.input, `${label} input`),
    ...(record.output === undefined
      ? {}
      : { output: expectAgentJsonValue(record.output, `${label} output`) }),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    startedAt: record.startedAt,
    ...(typeof record.finishedAt === "string" ? { finishedAt: record.finishedAt } : {}),
  };
}

function expectAgentJsonValue(value: unknown, label: string): AgentToolCallSnapshot["input"] {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => expectAgentJsonValue(entry, `${label}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        expectAgentJsonValue(entry, `${label}.${key}`),
      ]),
    );
  }
  throw new Error(`Agent Runtime returned invalid ${label}`);
}

function expectAgentSessionSummary(value: unknown, label: string): AgentSessionSummary {
  const record = expectAgentRecord(value, label);
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.title !== "string" ||
    !record.title ||
    typeof record.createdAt !== "string" ||
    !isIsoTimestamp(record.createdAt) ||
    typeof record.updatedAt !== "string" ||
    !isIsoTimestamp(record.updatedAt)
  ) {
    throw new Error(`Agent Runtime returned invalid ${label}`);
  }
  return {
    id: record.id,
    title: record.title,
    model: expectAgentModelSelection(record.model, `${label} model`),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function expectAgentModelSelection(value: unknown, label: string): AgentModelSelection {
  const record = expectAgentRecord(value, label);
  if (
    typeof record.connectionId !== "string" ||
    !record.connectionId ||
    typeof record.modelId !== "string" ||
    !record.modelId
  ) {
    throw new Error(`Agent Runtime returned invalid ${label}`);
  }
  return { connectionId: record.connectionId, modelId: record.modelId };
}

function expectAgentRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent Runtime returned invalid ${label}`);
  }
  return value as Record<string, unknown>;
}
