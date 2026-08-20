import {
  serverModSearchLimits,
  type ServerConfigurationWriteRequest,
  type ServerCoreSaveAsRequest,
  type ServerModInstallRequest,
  type ServerModSaveAsRequest,
  type ServerModSearchIndex,
  type ServerModSearchRequest,
  type ServerStartupDefaultsUpdate,
} from "@seashard/contracts";

export function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

export function expectSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
  return value as number;
}

export function expectServerStartupDefaultsUpdate(value: unknown): ServerStartupDefaultsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("server startup defaults must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.autoAcceptEula !== "boolean") {
    throw new TypeError("auto accept EULA must be a boolean");
  }
  return {
    defaultMinimumMemoryMiB: expectSafeInteger(
      record.defaultMinimumMemoryMiB,
      "default minimum memory",
    ),
    defaultMaximumMemoryMiB: expectSafeInteger(
      record.defaultMaximumMemoryMiB,
      "default maximum memory",
    ),
    defaultServerPort: expectSafeInteger(record.defaultServerPort, "default server port"),
    autoAcceptEula: record.autoAcceptEula,
    defaultJvmArguments: expectString(record.defaultJvmArguments, "default JVM arguments"),
  };
}

export function expectServerCoreSaveAsRequest(value: unknown): ServerCoreSaveAsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("server core save-as request must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    serverType: expectNonEmptyString(record.serverType, "server core type"),
    gameVersion: expectNonEmptyString(record.gameVersion, "game version"),
    artifactFileName: expectNonEmptyString(record.artifactFileName, "artifact file name"),
    destinationFileName: expectNonEmptyString(record.destinationFileName, "destination file name"),
  };
}

const serverModSearchIndexes = new Set<ServerModSearchIndex>([
  "relevance",
  "downloads",
  "follows",
  "newest",
  "updated",
]);
const serverModFilterPattern = /^[a-z0-9][a-z0-9+._-]{0,63}$/u;
const serverModProjectIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

/** 收窄 Renderer 的搜索参数，分页和 Facet 都只能落在公开 Contract 的固定边界内。 */
export function expectServerModSearchRequest(value: unknown): ServerModSearchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("server mod search request must be an object");
  }
  const record = value as Record<string, unknown>;
  const query = expectString(record.query, "server mod search query").trim();
  const tag = expectServerModFilter(record.tag, "server mod tag");
  const gameVersion = expectServerModFilter(record.gameVersion, "server mod game version");
  const loader = expectServerModFilter(record.loader, "server mod loader");
  const offset = expectSafeInteger(record.offset, "server mod search offset");
  const limit = expectSafeInteger(record.limit, "server mod search limit");
  if (record.source !== "modrinth") {
    throw new TypeError("server mod source must be modrinth");
  }
  if (query.length > serverModSearchLimits.maximumQueryLength || query.includes("\0")) {
    throw new TypeError("server mod search query is too long or contains NUL");
  }
  if (!serverModSearchIndexes.has(record.index as ServerModSearchIndex)) {
    throw new TypeError("server mod search index is invalid");
  }
  if (offset < 0) throw new TypeError("server mod search offset must not be negative");
  if (limit < 1 || limit > serverModSearchLimits.maximumPageSize) {
    throw new TypeError(
      `server mod search limit must be between 1 and ${serverModSearchLimits.maximumPageSize}`,
    );
  }
  return {
    source: "modrinth",
    query,
    tag,
    index: record.index as ServerModSearchIndex,
    gameVersion,
    loader,
    offset,
    limit,
  };
}
export function expectServerModProjectId(value: unknown): string {
  const projectId = expectString(value, "server mod project ID").trim();
  if (!serverModProjectIdPattern.test(projectId)) {
    throw new TypeError("server mod project ID is invalid");
  }
  return projectId;
}

export function expectServerModSaveAsRequest(value: unknown): ServerModSaveAsRequest {
  const record = expectRecord(value, "server mod save-as request");
  return {
    projectId: expectServerModProjectId(record.projectId),
    versionId: expectServerModIdentity(record.versionId, "server mod version ID"),
  };
}

export function expectServerModInstallRequest(value: unknown): ServerModInstallRequest {
  const record = expectRecord(value, "server mod install request");
  return {
    ...expectServerModSaveAsRequest(record),
    instanceId: expectServerModIdentity(record.instanceId, "server instance ID", 128),
  };
}

function expectServerModFilter(value: unknown, label: string): string {
  const filter = expectString(value, label).trim();
  if (filter && !serverModFilterPattern.test(filter)) {
    throw new TypeError(`${label} is invalid`);
  }
  return filter;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectServerModIdentity(value: unknown, label: string, maximumLength = 64): string {
  const identity = expectString(value, label).trim();
  if (identity.length > maximumLength || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(identity)) {
    throw new TypeError(`${label} is invalid`);
  }
  return identity;
}

export function expectServerConfigurationWriteRequest(
  value: unknown,
): ServerConfigurationWriteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("server configuration write request must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    instanceId: expectNonEmptyString(record.instanceId, "server instance id"),
    path: expectNonEmptyString(record.path, "server configuration path"),
    content: expectString(record.content, "server configuration content"),
    expectedRevision: expectNonEmptyString(
      record.expectedRevision,
      "server configuration revision",
    ),
  };
}
