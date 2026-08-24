import type {
  ActivationScope,
  ClientTarget,
  CpuArchitecture,
  HostProfile,
  OperatingSystem,
  PluginEntryManifest,
  PluginManifest,
} from "@seashard/plugin-sdk";

import { satisfies, valid, validRange } from "semver";

const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const entryIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const permissionPattern = /^[a-z0-9](?:[a-z0-9.*:-]{0,126}[a-z0-9*])?$/;
const contractPattern = /^[a-z0-9](?:[a-z0-9.:-]{0,126}[a-z0-9])?$/;
const methodPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const hostProfiles = ["electron", "node", "docker"] as const satisfies readonly HostProfile[];
const clientTargets = ["desktop", "web", "mobile"] as const satisfies readonly ClientTarget[];
const activationScopeValues = [
  "global",
  "workspace",
  "server",
  "agent",
  "client-session",
] as const satisfies readonly ActivationScope[];
const operatingSystems = [
  "win32",
  "darwin",
  "linux",
  "aix",
  "freebsd",
  "openbsd",
  "sunos",
] as const satisfies readonly OperatingSystem[];
const architectures = [
  "x64",
  "arm64",
  "ia32",
  "arm",
  "riscv64",
  "ppc64",
  "s390x",
] as const satisfies readonly CpuArchitecture[];

type ManifestParseMode = "package" | "internal";

export class PluginManifestError extends TypeError {
  readonly name = "PluginManifestError";

  constructor(readonly issues: readonly string[]) {
    super(`invalid plugin manifest:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  }
}

/** 解析第三方插件包清单；公开格式不接受 Scope 与内部权限字段。 */
export function parsePluginManifest(input: unknown, seaShardVersion: string): PluginManifest {
  return parseManifest(input, seaShardVersion, "package");
}

/** 解析宿主持有的内建或已规范化清单，保留现有 Scope 元数据。 */
export function parseInternalPluginManifest(
  input: unknown,
  seaShardVersion: string,
): PluginManifest {
  return parseManifest(input, seaShardVersion, "internal");
}

function parseManifest(
  input: unknown,
  seaShardVersion: string,
  mode: ManifestParseMode,
): PluginManifest {
  const issues: string[] = [];
  const root = objectAt(input, "manifest", issues);
  rejectUnknown(
    root,
    ["id", "version", "publisher", "atomic", "entries", "compatibility"],
    "manifest",
    issues,
  );

  const id = patternedString(root.id, "manifest.id", pluginIdPattern, issues);
  const version = stringAt(root.version, "manifest.version", issues);
  if (version && !valid(version)) issues.push("manifest.version must be a valid semantic version");
  const publisher = patternedString(root.publisher, "manifest.publisher", pluginIdPattern, issues);
  const atomic = optionalBoolean(root.atomic, "manifest.atomic", issues);
  const compatibility = parseCompatibility(root.compatibility, seaShardVersion, issues);
  const entriesInput = arrayAt(root.entries, "manifest.entries", issues);
  const entries = entriesInput.map((entry, index) => parseEntry(entry, index, mode, issues));

  if (entries.length === 0) issues.push("manifest.entries must contain at least one entry");
  assertUnique(
    entries.map((entry) => entry.id),
    "manifest.entries[].id",
    issues,
  );

  if (issues.length) throw new PluginManifestError(issues);
  return {
    id,
    version,
    publisher,
    ...(atomic === undefined ? {} : { atomic }),
    entries,
    compatibility,
  };
}

function parseCompatibility(
  input: unknown,
  seaShardVersion: string,
  issues: string[],
): PluginManifest["compatibility"] {
  const value = objectAt(input, "manifest.compatibility", issues);
  rejectUnknown(value, ["seaShard", "clientProtocol"], "manifest.compatibility", issues);
  const seaShard = stringAt(value.seaShard, "manifest.compatibility.seaShard", issues);
  const clientProtocol = optionalString(
    value.clientProtocol,
    "manifest.compatibility.clientProtocol",
    issues,
  );

  if (seaShard && !validRange(seaShard)) {
    issues.push("manifest.compatibility.seaShard must be a valid semantic-version range");
  } else if (seaShard && valid(seaShardVersion) && !satisfies(seaShardVersion, seaShard)) {
    issues.push(
      `manifest.compatibility.seaShard ${seaShard} does not include SeaShard ${seaShardVersion}`,
    );
  }

  return { seaShard, ...(clientProtocol === undefined ? {} : { clientProtocol }) };
}

function parseEntry(
  input: unknown,
  index: number,
  mode: ManifestParseMode,
  issues: string[],
): PluginEntryManifest {
  const path = `manifest.entries[${index}]`;
  const value = objectAt(input, path, issues);
  const publicFields = ["id", "runtime", "module", "hostProfiles", "targets", "uses", "os", "arch"];
  rejectUnknown(
    value,
    mode === "internal" ? [...publicFields, "activationScopes", "permissions"] : publicFields,
    path,
    issues,
  );

  const id = patternedString(value.id, `${path}.id`, entryIdPattern, issues);
  const runtime = enumAt(value.runtime, `${path}.runtime`, ["host", "client"] as const, issues);
  const module = stringAt(value.module, `${path}.module`, issues);
  if (module && !isSafeModulePath(module)) {
    issues.push(`${path}.module must be a relative ESM .js or .mjs path without traversal`);
  }

  const uses =
    value.uses === undefined && mode === "internal"
      ? undefined
      : contractUsesAt(value.uses, `${path}.uses`, issues);
  const scopes =
    mode === "package"
      ? (["global"] as const)
      : (optionalEnumArray(
          value.activationScopes,
          `${path}.activationScopes`,
          activationScopeValues,
          issues,
        ) ?? ["global"]);
  const permissions =
    mode === "package"
      ? Object.keys(uses ?? {})
      : (optionalPatternArray(
          value.permissions,
          `${path}.permissions`,
          permissionPattern,
          issues,
        ) ?? []);
  const entry: PluginEntryManifest = {
    id,
    runtime,
    module,
    ...(uses === undefined ? {} : { uses }),
    activationScopes: [...scopes],
    permissions,
  };

  if (runtime === "host") {
    entry.hostProfiles = enumArrayAt(
      value.hostProfiles,
      `${path}.hostProfiles`,
      hostProfiles,
      issues,
    );
    if (value.targets !== undefined)
      issues.push(`${path}.targets is only valid for client entries`);
  } else {
    entry.targets = enumArrayAt(value.targets, `${path}.targets`, clientTargets, issues);
    if (value.hostProfiles !== undefined) {
      issues.push(`${path}.hostProfiles is only valid for host entries`);
    }
  }

  const os = optionalEnumArray(value.os, `${path}.os`, operatingSystems, issues);
  const arch = optionalEnumArray(value.arch, `${path}.arch`, architectures, issues);
  if (os) entry.os = os;
  if (arch) entry.arch = arch;
  return entry;
}

function isSafeModulePath(value: string): boolean {
  if (!value.startsWith("./") || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) return false;
  return value.endsWith(".js") || value.endsWith(".mjs");
}

function objectAt(input: unknown, path: string, issues: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    issues.push(`${path} must be an object`);
    return {};
  }
  return input as Record<string, unknown>;
}

function arrayAt(input: unknown, path: string, issues: string[]): unknown[] {
  if (!Array.isArray(input)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  return input;
}

function stringAt(input: unknown, path: string, issues: string[]): string {
  if (typeof input !== "string" || input.length === 0) {
    issues.push(`${path} must be a non-empty string`);
    return "";
  }
  return input;
}

function optionalString(input: unknown, path: string, issues: string[]): string | undefined {
  if (input === undefined) return undefined;
  return stringAt(input, path, issues);
}

function patternedString(input: unknown, path: string, pattern: RegExp, issues: string[]): string {
  const value = stringAt(input, path, issues);
  if (value && !pattern.test(value)) issues.push(`${path} has an invalid identifier`);
  return value;
}

function optionalBoolean(input: unknown, path: string, issues: string[]): boolean | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "boolean") {
    issues.push(`${path} must be a boolean`);
    return undefined;
  }
  return input;
}

function enumAt<const T extends string>(
  input: unknown,
  path: string,
  values: readonly T[],
  issues: string[],
): T {
  if (typeof input !== "string" || !values.includes(input as T)) {
    issues.push(`${path} must be one of: ${values.join(", ")}`);
    return values[0];
  }
  return input as T;
}

function enumArrayAt<const T extends string>(
  input: unknown,
  path: string,
  values: readonly T[],
  issues: string[],
): T[] {
  const array = arrayAt(input, path, issues);
  const result = array.map((item, index) => enumAt(item, `${path}[${index}]`, values, issues));
  if (result.length === 0) issues.push(`${path} must contain at least one value`);
  assertUnique(result, path, issues);
  return result;
}

function optionalEnumArray<const T extends string>(
  input: unknown,
  path: string,
  values: readonly T[],
  issues: string[],
): T[] | undefined {
  if (input === undefined) return undefined;
  return enumArrayAt(input, path, values, issues);
}

function optionalPatternArray(
  input: unknown,
  path: string,
  pattern: RegExp,
  issues: string[],
): string[] | undefined {
  if (input === undefined) return undefined;
  const result = arrayAt(input, path, issues).map((item, index) =>
    patternedString(item, `${path}[${index}]`, pattern, issues),
  );
  assertUnique(result, path, issues);
  return result;
}

function contractUsesAt(input: unknown, path: string, issues: string[]): Record<string, string[]> {
  const value = objectAt(input, path, issues);
  const uses: Record<string, string[]> = {};
  for (const [contract, rawMethods] of Object.entries(value)) {
    if (!contractPattern.test(contract)) {
      issues.push(`${path}.${contract} has an invalid contract identifier`);
    }
    const methods = arrayAt(rawMethods, `${path}.${contract}`, issues).map((method, index) =>
      patternedString(method, `${path}.${contract}[${index}]`, methodPattern, issues),
    );
    if (methods.length === 0) {
      issues.push(`${path}.${contract} must contain at least one method`);
    }
    assertUnique(methods, `${path}.${contract}`, issues);
    if (contractPattern.test(contract)) uses[contract] = methods;
  }
  return uses;
}

function assertUnique(values: readonly string[], path: string, issues: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) issues.push(`${path} contains duplicate value ${value}`);
    seen.add(value);
  }
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key} is not supported`);
  }
}
