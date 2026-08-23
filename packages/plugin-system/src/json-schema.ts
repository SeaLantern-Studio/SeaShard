import type { JsonObject, JsonValue } from "@seashard/plugin-sdk";

type JsonSchemaNode = JsonObject | boolean;
type JsonValueValidator = (value: JsonValue, path: string) => string | undefined;

const supportedTypes = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

/**
 * 将资源输入 JSON Schema 编译为同步校验器。
 *
 * Agent 资源只需要 JSON 数据边界，因此这里实现常用结构、组合、枚举和数值约束；
 * 未识别的注解关键字保持无副作用，错误的已支持关键字会在注册阶段直接失败。
 */
export function compileJsonSchemaValidator(
  schema: JsonObject,
  label: string,
): (value: JsonValue) => void {
  const validator = compileNode(schema, new Set<object>(), label);
  return (value) => {
    const issue = validator(value, "$input");
    if (issue) throw new TypeError(`${label}不符合 inputSchema：${issue}`);
  };
}

function compileNode(
  schema: JsonSchemaNode,
  ancestors: ReadonlySet<object>,
  label: string,
): JsonValueValidator {
  if (typeof schema === "boolean") {
    return schema ? () => undefined : (_value, path) => `${path} 被 Schema 拒绝`;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError(`${label} inputSchema 节点必须是对象或布尔值`);
  }
  if (ancestors.has(schema)) throw new TypeError(`${label} inputSchema 不能循环引用`);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(schema);

  const typeValidator = compileTypeValidator(schema.type, label);
  const enumValues = readJsonArray(schema.enum, `${label} inputSchema.enum`);
  const constant = schema.const;
  const allOf = compileSchemaArray(schema.allOf, nextAncestors, `${label} inputSchema.allOf`);
  const anyOf = compileSchemaArray(schema.anyOf, nextAncestors, `${label} inputSchema.anyOf`);
  const oneOf = compileSchemaArray(schema.oneOf, nextAncestors, `${label} inputSchema.oneOf`);
  const notValidator =
    schema.not === undefined
      ? undefined
      : compileNode(
          requireSchemaNode(schema.not, `${label} inputSchema.not`),
          nextAncestors,
          label,
        );
  const objectValidator = compileObjectValidator(schema, nextAncestors, label);
  const arrayValidator = compileArrayValidator(schema, nextAncestors, label);
  const stringValidator = compileStringValidator(schema, label);
  const numberValidator = compileNumberValidator(schema, label);

  return (value, path) => {
    const typeIssue = typeValidator?.(value, path);
    if (typeIssue) return typeIssue;
    if (enumValues && !enumValues.some((candidate) => jsonValuesEqual(candidate, value))) {
      return `${path} 不在 enum 允许值中`;
    }
    if (constant !== undefined && !jsonValuesEqual(constant, value)) {
      return `${path} 不等于 const 指定值`;
    }
    for (const validator of allOf) {
      const issue = validator(value, path);
      if (issue) return issue;
    }
    if (anyOf.length && !anyOf.some((validator) => validator(value, path) === undefined)) {
      return `${path} 不符合 anyOf 中的任何分支`;
    }
    if (oneOf.length) {
      const matched = oneOf.filter((validator) => validator(value, path) === undefined).length;
      if (matched !== 1) return `${path} 必须且只能符合 oneOf 中的一个分支`;
    }
    if (notValidator && notValidator(value, path) === undefined) {
      return `${path} 符合被 not 排除的结构`;
    }
    return (
      objectValidator(value, path) ??
      arrayValidator(value, path) ??
      stringValidator(value, path) ??
      numberValidator(value, path)
    );
  };
}

function compileTypeValidator(
  value: JsonValue | undefined,
  label: string,
): JsonValueValidator | undefined {
  if (value === undefined) return undefined;
  const types =
    typeof value === "string" ? [value] : readStringArray(value, `${label} inputSchema.type`);
  if (!types.length || types.some((type) => !supportedTypes.has(type))) {
    throw new TypeError(`${label} inputSchema.type 包含不支持的类型`);
  }
  return (input, path) =>
    types.some((type) => matchesType(input, type))
      ? undefined
      : `${path} 类型必须是 ${types.join(" | ")}`;
}

function compileObjectValidator(
  schema: JsonObject,
  ancestors: ReadonlySet<object>,
  label: string,
): JsonValueValidator {
  const propertiesValue = schema.properties;
  const properties = new Map<string, JsonValueValidator>();
  if (propertiesValue !== undefined) {
    const object = requireJsonObject(propertiesValue, `${label} inputSchema.properties`);
    for (const [name, child] of Object.entries(object)) {
      properties.set(
        name,
        compileNode(
          requireSchemaNode(child, `${label} inputSchema.properties.${name}`),
          ancestors,
          label,
        ),
      );
    }
  }
  const required =
    schema.required === undefined
      ? []
      : readStringArray(schema.required, `${label} inputSchema.required`);
  const additional = schema.additionalProperties;
  const additionalValidator =
    additional === undefined || additional === true
      ? undefined
      : additional === false
        ? false
        : compileNode(
            requireSchemaNode(additional, `${label} inputSchema.additionalProperties`),
            ancestors,
            label,
          );
  const minimum = readNonNegativeInteger(
    schema.minProperties,
    `${label} inputSchema.minProperties`,
  );
  const maximum = readNonNegativeInteger(
    schema.maxProperties,
    `${label} inputSchema.maxProperties`,
  );

  return (value, path) => {
    if (!isJsonObject(value)) return undefined;
    const keys = Object.keys(value);
    if (minimum !== undefined && keys.length < minimum) return `${path} 至少需要 ${minimum} 个属性`;
    if (maximum !== undefined && keys.length > maximum) return `${path} 最多允许 ${maximum} 个属性`;
    for (const name of required) {
      if (!Object.hasOwn(value, name)) return `${path}.${name} 是必填字段`;
    }
    for (const [name, child] of Object.entries(value)) {
      const propertyValidator = properties.get(name);
      if (propertyValidator) {
        const issue = propertyValidator(child, `${path}.${name}`);
        if (issue) return issue;
        continue;
      }
      if (additionalValidator === false) return `${path}.${name} 是未知字段`;
      if (additionalValidator) {
        const issue = additionalValidator(child, `${path}.${name}`);
        if (issue) return issue;
      }
    }
    return undefined;
  };
}

function compileArrayValidator(
  schema: JsonObject,
  ancestors: ReadonlySet<object>,
  label: string,
): JsonValueValidator {
  const itemValidator =
    schema.items === undefined
      ? undefined
      : compileNode(
          requireSchemaNode(schema.items, `${label} inputSchema.items`),
          ancestors,
          label,
        );
  const minimum = readNonNegativeInteger(schema.minItems, `${label} inputSchema.minItems`);
  const maximum = readNonNegativeInteger(schema.maxItems, `${label} inputSchema.maxItems`);
  const unique = schema.uniqueItems === true;
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    throw new TypeError(`${label} inputSchema.uniqueItems 必须是布尔值`);
  }

  return (value, path) => {
    if (!Array.isArray(value)) return undefined;
    if (minimum !== undefined && value.length < minimum) return `${path} 至少需要 ${minimum} 项`;
    if (maximum !== undefined && value.length > maximum) return `${path} 最多允许 ${maximum} 项`;
    if (unique) {
      for (let index = 0; index < value.length; index += 1) {
        if (value.slice(0, index).some((entry) => jsonValuesEqual(entry, value[index]!))) {
          return `${path}[${index}] 必须唯一`;
        }
      }
    }
    if (!itemValidator) return undefined;
    for (const [index, item] of value.entries()) {
      const issue = itemValidator(item, `${path}[${index}]`);
      if (issue) return issue;
    }
    return undefined;
  };
}

function compileStringValidator(schema: JsonObject, label: string): JsonValueValidator {
  const minimum = readNonNegativeInteger(schema.minLength, `${label} inputSchema.minLength`);
  const maximum = readNonNegativeInteger(schema.maxLength, `${label} inputSchema.maxLength`);
  const pattern =
    schema.pattern === undefined
      ? undefined
      : new RegExp(requireString(schema.pattern, `${label} inputSchema.pattern`), "u");
  return (value, path) => {
    if (typeof value !== "string") return undefined;
    const length = Array.from(value).length;
    if (minimum !== undefined && length < minimum) return `${path} 长度不能小于 ${minimum}`;
    if (maximum !== undefined && length > maximum) return `${path} 长度不能大于 ${maximum}`;
    if (pattern && !pattern.test(value)) return `${path} 不符合 pattern`;
    return undefined;
  };
}

function compileNumberValidator(schema: JsonObject, label: string): JsonValueValidator {
  const minimum = readFiniteNumber(schema.minimum, `${label} inputSchema.minimum`);
  const maximum = readFiniteNumber(schema.maximum, `${label} inputSchema.maximum`);
  const exclusiveMinimum = readFiniteNumber(
    schema.exclusiveMinimum,
    `${label} inputSchema.exclusiveMinimum`,
  );
  const exclusiveMaximum = readFiniteNumber(
    schema.exclusiveMaximum,
    `${label} inputSchema.exclusiveMaximum`,
  );
  const multipleOf = readFiniteNumber(schema.multipleOf, `${label} inputSchema.multipleOf`);
  if (multipleOf !== undefined && multipleOf <= 0) {
    throw new TypeError(`${label} inputSchema.multipleOf 必须大于 0`);
  }
  return (value, path) => {
    if (typeof value !== "number") return undefined;
    if (minimum !== undefined && value < minimum) return `${path} 不能小于 ${minimum}`;
    if (maximum !== undefined && value > maximum) return `${path} 不能大于 ${maximum}`;
    if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
      return `${path} 必须大于 ${exclusiveMinimum}`;
    }
    if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) {
      return `${path} 必须小于 ${exclusiveMaximum}`;
    }
    if (multipleOf !== undefined && !Number.isInteger(value / multipleOf)) {
      return `${path} 必须是 ${multipleOf} 的倍数`;
    }
    return undefined;
  };
}

function compileSchemaArray(
  value: JsonValue | undefined,
  ancestors: ReadonlySet<object>,
  label: string,
): readonly JsonValueValidator[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length) throw new TypeError(`${label} 必须是非空数组`);
  return value.map((schema, index) =>
    compileNode(requireSchemaNode(schema, `${label}[${index}]`), ancestors, label),
  );
}

function matchesType(value: JsonValue, type: string): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number";
    case "object":
      return isJsonObject(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function requireSchemaNode(value: JsonValue, label: string): JsonSchemaNode {
  if (typeof value === "boolean" || isJsonObject(value)) return value;
  throw new TypeError(`${label} 必须是对象或布尔值`);
}

function requireJsonObject(value: JsonValue, label: string): JsonObject {
  if (isJsonObject(value)) return value;
  throw new TypeError(`${label} 必须是对象`);
}

function readJsonArray(
  value: JsonValue | undefined,
  label: string,
): readonly JsonValue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} 必须是数组`);
  return value;
}

function readStringArray(value: JsonValue, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${label} 必须是字符串数组`);
  }
  return value as string[];
}

function requireString(value: JsonValue, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} 必须是字符串`);
  return value;
}

function readNonNegativeInteger(value: JsonValue | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} 必须是非负整数`);
  }
  return value;
}

function readFiniteNumber(value: JsonValue | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} 必须是有限数字`);
  }
  return value;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => jsonValuesEqual(entry, right[index]!))
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key]!, right[key]!))
    );
  }
  return false;
}
