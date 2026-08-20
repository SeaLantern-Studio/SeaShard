import type {
  ServerConfigurationWriteRequest,
  ServerCoreSaveAsRequest,
  ServerStartupDefaultsUpdate,
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
