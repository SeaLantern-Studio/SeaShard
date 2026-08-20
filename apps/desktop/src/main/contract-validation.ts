import {
  serverCoreIconHost,
  serverCoreIconScheme,
  serverInstanceIconHost,
  serverDownloadConnectionLimits,
  serverJvmArgumentsMaximumLength,
  serverPortLimits,
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
      !["downloaded", "imported"].includes(String(instance.source))
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
