import {
  isServerModSource,
  serverJvmArgumentsMaximumLength,
  serverPortLimits,
  serverModSearchLimits,
  type AgentModelConfigurationService,
  type AgentModelConnectionMutation,
  type AgentModelSelection,
  type AgentSessionService,
  type ServerConfigurationWriteRequest,
  type ServerCoreSaveAsRequest,
  type ServerModDownloadableResourceType,
  type ServerModInstallRequest,
  type ServerModSaveAsRequest,
  type ServerModSearchIndex,
  type ServerModSource,
  type ServerModrinthResourceType,
  type ServerModSearchRequest,
  type ServerInstanceStartupSettings,
  type ServerStartupDefaultsUpdate,
} from "@seashard/contracts";
import type { JsonObject, JsonValue } from "@seashard/plugin-sdk";

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

export function expectAgentModelConnectionMutationInput(
  value: unknown,
): Parameters<AgentModelConfigurationService["mutateConnection"]>[0] {
  const record = expectRecord(value, "Agent model connection mutation");
  if (!Array.isArray(record.operations)) {
    throw new TypeError("Agent model connection operations must be an array");
  }
  const operations: AgentModelConnectionMutation[] = record.operations.map((operation, index) => {
    const item = expectRecord(operation, `Agent model connection operation ${index}`);
    if (!Array.isArray(item.path) || item.path.some((segment) => typeof segment !== "string")) {
      throw new TypeError(`Agent model connection operation ${index} path must be a string array`);
    }
    const path = item.path as string[];
    if (item.op === "unset") return { op: "unset", path };
    if (item.op !== "set") {
      throw new TypeError(`Agent model connection operation ${index} is invalid`);
    }
    return { op: "set", path, value: item.value as JsonValue };
  });
  return {
    expectedRevision: expectNonEmptyString(record.expectedRevision, "Agent model revision"),
    connectionId: expectNonEmptyString(record.connectionId, "Agent model connection ID"),
    operations,
  };
}

export function expectAgentModelConnectionRemovalInput(
  value: unknown,
): Parameters<AgentModelConfigurationService["removeConnection"]>[0] {
  const record = expectRecord(value, "Agent model connection removal");
  return {
    expectedRevision: expectNonEmptyString(record.expectedRevision, "Agent model revision"),
    connectionId: expectNonEmptyString(record.connectionId, "Agent model connection ID"),
  };
}

export function expectAgentModelConfigurationResetInput(
  value: unknown,
): Parameters<AgentModelConfigurationService["resetConfiguration"]>[0] {
  const record = expectRecord(value, "Agent model configuration reset");
  return {
    expectedRevision: expectNonEmptyString(record.expectedRevision, "Agent model revision"),
  };
}

export function expectAgentModelDiscoveryInput(
  value: unknown,
): Parameters<AgentModelConfigurationService["discoverModels"]>[0] {
  const record = expectRecord(value, "Agent model discovery");
  const settings = expectRecord(record.settings, "Agent provider settings") as JsonObject;
  return {
    providerType: expectNonEmptyString(record.providerType, "Agent provider type"),
    settings,
    ...(record.credentialId === undefined
      ? {}
      : {
          credentialId: expectNonEmptyString(record.credentialId, "Agent credential ID"),
        }),
    ...(record.credentialValue === undefined
      ? {}
      : {
          credentialValue: expectNonEmptyString(record.credentialValue, "Agent credential value"),
        }),
  };
}

export function expectAgentCredentialWriteInput(
  value: unknown,
): Parameters<AgentModelConfigurationService["writeCredential"]>[0] {
  const record = expectRecord(value, "Agent credential write");
  return {
    credentialId: expectNonEmptyString(record.credentialId, "Agent credential ID"),
    value: expectNonEmptyString(record.value, "Agent credential value"),
  };
}

export function expectAgentCredentialRemovalInput(
  value: unknown,
): Parameters<AgentModelConfigurationService["removeCredential"]>[0] {
  const record = expectRecord(value, "Agent credential removal");
  return {
    credentialId: expectNonEmptyString(record.credentialId, "Agent credential ID"),
  };
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
export function expectServerInstanceStartupSettings(value: unknown): ServerInstanceStartupSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("server instance startup settings must be an object");
  }
  const record = value as Record<string, unknown>;
  const minimumMemoryMiB = expectSafeInteger(
    record.minimumMemoryMiB,
    "server instance minimum memory",
  );
  const maximumMemoryMiB = expectSafeInteger(
    record.maximumMemoryMiB,
    "server instance maximum memory",
  );
  const serverPort = expectSafeInteger(record.serverPort, "server instance port");
  if (minimumMemoryMiB <= 0 || maximumMemoryMiB < minimumMemoryMiB) {
    throw new TypeError("server instance memory range is invalid");
  }
  if (serverPort < serverPortLimits.minimum || serverPort > serverPortLimits.maximum) {
    throw new TypeError("server instance port is outside the allowed range");
  }
  if (typeof record.autoAcceptEula !== "boolean") {
    throw new TypeError("server instance auto accept EULA must be a boolean");
  }
  const jvmArguments = expectString(record.jvmArguments, "server instance JVM arguments");
  if (jvmArguments.length > serverJvmArgumentsMaximumLength || jvmArguments.includes("\0")) {
    throw new TypeError("server instance JVM arguments are invalid");
  }
  return {
    minimumMemoryMiB,
    maximumMemoryMiB,
    serverPort,
    autoAcceptEula: record.autoAcceptEula,
    jvmArguments,
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
const serverModResourceTypes = new Set<ServerModrinthResourceType>([
  "mod",
  "modpack",
  "datapack",
  "world",
]);
const serverModFilterPattern = /^[a-z0-9][a-z0-9+._-]{0,63}$/u;
const serverModProjectIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

/** 收窄 Renderer 的搜索参数，分页和 Facet 都只能落在公开 Contract 的固定边界内。 */
export function expectServerModSearchRequest(value: unknown): ServerModSearchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("server resource search request must be an object");
  }
  const record = value as Record<string, unknown>;
  const resourceType = expectServerModResourceType(record.resourceType);
  const query = expectString(record.query, "server resource search query").trim();
  const tag = expectServerModFilter(record.tag, "server resource tag");
  const gameVersion = expectServerModFilter(record.gameVersion, "server resource game version");
  const loader = expectServerModFilter(record.loader, "server resource loader");
  const offset = expectSafeInteger(record.offset, "server resource search offset");
  const limit = expectSafeInteger(record.limit, "server resource search limit");
  const source = expectServerModSource(record.source);
  if (resourceType === "datapack" && loader) {
    throw new TypeError("server datapack search must not specify a loader");
  }
  if (query.length > serverModSearchLimits.maximumQueryLength || query.includes("\0")) {
    throw new TypeError("server resource search query is too long or contains NUL");
  }
  if (!serverModSearchIndexes.has(record.index as ServerModSearchIndex)) {
    throw new TypeError("server resource search index is invalid");
  }
  if (offset < 0) throw new TypeError("server resource search offset must not be negative");
  if (limit < 1 || limit > serverModSearchLimits.maximumPageSize) {
    throw new TypeError(
      `server resource search limit must be between 1 and ${serverModSearchLimits.maximumPageSize}`,
    );
  }
  return {
    resourceType,
    source,
    query,
    tag,
    index: record.index as ServerModSearchIndex,
    gameVersion,
    loader,
    offset,
    limit,
  };
}

export function expectServerModResourceType(value: unknown): ServerModrinthResourceType {
  if (
    typeof value !== "string" ||
    !serverModResourceTypes.has(value as ServerModrinthResourceType)
  ) {
    throw new TypeError("server resource type is invalid");
  }
  return value as ServerModrinthResourceType;
}

export function expectServerModSource(value: unknown): ServerModSource {
  if (!isServerModSource(value)) {
    throw new TypeError("server resource source is invalid");
  }
  return value;
}
export function expectServerModProjectId(value: unknown): string {
  const projectId = expectString(value, "server mod project ID").trim();
  if (!serverModProjectIdPattern.test(projectId)) {
    throw new TypeError("server mod project ID is invalid");
  }
  return projectId;
}
export function expectServerModSaveAsRequest(value: unknown): ServerModSaveAsRequest {
  const record = expectRecord(value, "server resource save-as request");
  return {
    source: expectServerModSource(record.source),
    resourceType: expectDownloadableServerModResourceType(record.resourceType),
    projectId: expectServerModProjectId(record.projectId),
    versionId: expectServerModIdentity(record.versionId, "server resource version ID"),
  };
}

export function expectServerModInstallRequest(value: unknown): ServerModInstallRequest {
  const record = expectRecord(value, "server resource install request");
  const resourceType = expectInstallableServerModResourceType(record.resourceType);
  const worldId = record.worldId === undefined ? undefined : expectServerWorldId(record.worldId);
  if (resourceType === "datapack" && worldId === undefined) {
    throw new TypeError("server datapack install requires a target world");
  }
  return {
    source: expectServerModSource(record.source),
    resourceType,
    projectId: expectServerModProjectId(record.projectId),
    versionId: expectServerModIdentity(record.versionId, "server resource version ID"),
    instanceId: expectServerModIdentity(record.instanceId, "server instance ID", 128),
    ...(worldId === undefined ? {} : { worldId }),
  };
}

function expectDownloadableServerModResourceType(
  value: unknown,
): ServerModDownloadableResourceType {
  return expectServerModResourceType(value);
}

function expectInstallableServerModResourceType(value: unknown): "mod" | "datapack" | "world" {
  const resourceType = expectServerModResourceType(value);
  if (resourceType !== "mod" && resourceType !== "datapack" && resourceType !== "world") {
    throw new TypeError("server resource install type must be mod, datapack, or world");
  }
  return resourceType;
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
function expectServerWorldId(value: unknown): string {
  const worldId = expectString(value, "server world ID");
  if (
    worldId.length > 1_024 ||
    worldId.includes("\\") ||
    worldId.startsWith("/") ||
    worldId.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError("server world ID is invalid");
  }
  return worldId;
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

export function expectAgentStartSessionInput(
  value: unknown,
): Parameters<AgentSessionService["startSession"]>[0] {
  const record = expectRecord(value, "Agent start session request");
  return {
    initialMessage: {
      text: expectNonEmptyString(
        expectRecord(record.initialMessage, "Agent initial message").text,
        "Agent initial message text",
      ),
    },
    mode: expectAgentConversationMode(record.mode),
    ...(record.model === undefined ? {} : { model: expectAgentModelSelection(record.model) }),
  };
}

export function expectAgentSendMessageInput(
  value: unknown,
): Parameters<AgentSessionService["sendMessage"]>[0] {
  const record = expectRecord(value, "Agent send message request");
  return {
    sessionId: expectNonEmptyString(record.sessionId, "Agent session ID"),
    message: {
      text: expectNonEmptyString(
        expectRecord(record.message, "Agent message").text,
        "Agent message text",
      ),
    },
    mode: expectAgentConversationMode(record.mode),
    ...(record.model === undefined ? {} : { model: expectAgentModelSelection(record.model) }),
  };
}

function expectAgentModelSelection(value: unknown): AgentModelSelection {
  const record = expectRecord(value, "Agent model selection");
  return {
    connectionId: expectNonEmptyString(record.connectionId, "Agent connection ID"),
    modelId: expectNonEmptyString(record.modelId, "Agent model ID"),
  };
}

function expectAgentConversationMode(value: unknown): "chat" | "agent" {
  if (value !== "chat" && value !== "agent") {
    throw new TypeError("Agent mode must be chat or agent");
  }
  return value;
}
