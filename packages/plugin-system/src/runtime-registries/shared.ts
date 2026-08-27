import type { JsonObject, JsonValue } from "@seashard/plugin-sdk";

export function allowsPermission(permissions: readonly string[], capability: string): boolean {
  return permissions.some(
    (permission) =>
      permission === "*" ||
      permission === capability ||
      (permission.endsWith(".*") && capability.startsWith(permission.slice(0, -1))),
  );
}

export function validateContract(value: string): void {
  if (!/^[a-z0-9][a-z0-9.*:-]*$/.test(value)) {
    throw new TypeError(`invalid contract identifier: ${value}`);
  }
}

export function normalizeAgentJsonObject(value: unknown, label: string): JsonObject {
  const normalized = normalizeAgentJsonValue(value, label);
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new TypeError(`${label} 必须是对象`);
  }
  return normalized;
}

export function normalizeAgentJsonValue(
  value: unknown,
  label: string,
  ancestors: ReadonlySet<object> = new Set(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") throw new TypeError(`${label}必须是 JSON 值`);
  if (ancestors.has(value)) throw new TypeError(`${label}不能循环引用`);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeAgentJsonValue(entry, `${label}[${index}]`, nextAncestors),
    );
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label}必须是普通 JSON 对象`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      normalizeAgentJsonValue(entry, `${label}.${key}`, nextAncestors),
    ]),
  );
}

export function requireAgentResourceText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Agent 资源${label}不能为空`);
  }
  return value.trim();
}
