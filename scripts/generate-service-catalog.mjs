import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputPath = resolve(root, "apps/cli/src/generated/service-catalog.json");
const checkOnly = process.argv.includes("--check");
const configPath = ts.findConfigFile(
  root,
  (fileName) => ts.sys.fileExists(fileName),
  "tsconfig.json",
);
if (!configPath) throw new Error("service catalog generator could not find tsconfig.json");

const configFile = ts.readConfigFile(configPath, (fileName) => ts.sys.readFile(fileName));
if (configFile.error) throw new Error(formatDiagnostic(configFile.error));
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root, {
  noEmit: true,
  skipLibCheck: true,
});
if (parsed.errors.length) {
  throw new Error(parsed.errors.map(formatDiagnostic).join("\n"));
}

const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();
const sourceFiles = program
  .getSourceFiles()
  .filter((sourceFile) => isWorkspaceSource(sourceFile.fileName))
  .filter((sourceFile) => resolve(sourceFile.fileName) !== outputPath)
  .sort((left, right) => workspacePath(left.fileName).localeCompare(workspacePath(right.fileName)));
const workspaceStringValues = new Map();

const manifestIds = new Map();
for (const sourceFile of sourceFiles) {
  const ids = [];
  visit(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (!node.name.text.endsWith("Manifest")) return;
    const object = unwrapObjectLiteral(node.initializer);
    if (!object) return;
    const id = object.properties
      .filter(ts.isPropertyAssignment)
      .find((property) => propertyName(property.name) === "id");
    const value = id ? resolveString(id.initializer) : undefined;
    if (value) ids.push(value);
  });
  if (ids.length > 1) {
    throw new Error(`${workspacePath(sourceFile.fileName)} declares multiple plugin manifests`);
  }
  if (ids[0]) manifestIds.set(resolve(sourceFile.fileName), ids[0]);
}

const owners = new Map();
const providers = new Map();
for (const sourceFile of sourceFiles) {
  const owner = manifestIds.get(resolve(sourceFile.fileName));
  visit(sourceFile, (node) => {
    if (owner && ts.isPropertyAssignment(node) && propertyName(node.name) === "provides") {
      const array = unwrapArrayLiteral(node.initializer);
      if (!array) return;
      for (const element of array.elements) {
        const contract = resolveString(element);
        if (contract) setUniqueOwner(contract, owner, sourceFile);
      }
    }

    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (node.expression.name.text !== "provide" || node.arguments.length < 2) return;
    const contract = resolveString(node.arguments[0]);
    const provider = unwrapObjectLiteral(node.arguments[1]);
    if (!contract || !provider) return;
    const methods = provider.properties
      .flatMap((property) => {
        if (
          ts.isMethodDeclaration(property) ||
          ts.isMethodSignature(property) ||
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)
        ) {
          const name = propertyName(property.name);
          return name ? [name] : [];
        }
        return [];
      })
      .sort((left, right) => left.localeCompare(right));
    const current = providers.get(contract);
    if (current) {
      throw new Error(
        `${workspacePath(sourceFile.fileName)} registers a second static Provider for ${contract}; first seen in ${current.source}`,
      );
    }
    providers.set(contract, { methods, source: workspacePath(sourceFile.fileName) });
  });
}

const definitions = new Map();
for (const sourceFile of sourceFiles) {
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    if (node.expression.text !== "defineServiceContract") return;
    if (node.typeArguments?.length !== 1 || node.arguments.length !== 1) {
      throw new Error(
        `${workspacePointer(sourceFile, node)} defineServiceContract requires one Service type and one Contract value`,
      );
    }
    const contract = resolveString(node.arguments[0]);
    if (!contract) {
      throw new Error(
        `${workspacePointer(sourceFile, node)} Service Contract must resolve to a static string`,
      );
    }
    if (definitions.has(contract)) {
      const previous = definitions.get(contract);
      throw new Error(
        `${workspacePointer(sourceFile, node)} duplicates Service Contract ${contract}; first seen in ${previous.source}`,
      );
    }
    const serviceType = checker.getTypeFromTypeNode(node.typeArguments[0]);
    definitions.set(contract, {
      contract,
      serviceType,
      source: workspacePointer(sourceFile, node),
    });
  });
}

const catalogTypeDeclarations = indexCatalogTypeDeclarations();

const violations = [];
const services = [];
for (const definition of [...definitions.values()].sort((left, right) =>
  left.contract.localeCompare(right.contract),
)) {
  const symbol = definition.serviceType.aliasSymbol ?? definition.serviceType.getSymbol();
  const description = symbol ? documentation(symbol) : "";
  if (!description) violations.push(`${definition.contract}: Service type has no JSDoc`);

  const owner = owners.get(definition.contract);
  if (!owner)
    violations.push(`${definition.contract}: no internal PluginModule provides this Contract`);
  const provider = providers.get(definition.contract);
  if (!provider)
    violations.push(`${definition.contract}: no static ctx.provide() registration was found`);

  const signatureSeeds = [];
  const methods = [];
  for (const member of definition.serviceType.getProperties()) {
    const declaration = preferredDeclaration(member);
    if (!declaration) continue;
    const memberType = checker.getTypeOfSymbolAtLocation(member, declaration);
    const signatures = memberType.getCallSignatures();
    if (signatures.length === 0) continue;
    if (signatures.length > 1) {
      violations.push(
        `${definition.contract}.${member.name}: overloaded Service methods are not supported`,
      );
      continue;
    }
    const signature = signatures[0];
    const methodDescription = documentation(member);
    if (!methodDescription) {
      violations.push(`${definition.contract}.${member.name}: method has no JSDoc description`);
    }
    const tags = jsDocTags(declaration);
    const parameters = signature.getParameters().map((parameter) => {
      const parameterDeclaration =
        parameter.valueDeclaration ?? parameter.declarations?.[0] ?? declaration;
      const parameterType = checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration);
      signatureSeeds.push(
        checker.typeToString(
          parameterType,
          parameterDeclaration,
          ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
        ),
      );
      const parameterDescription = tags.parameters.get(parameter.name) ?? "";
      if (!parameterDescription) {
        violations.push(`${definition.contract}.${member.name}: missing @param ${parameter.name}`);
      }
      return {
        name: parameter.name,
        type: checker.typeToString(
          parameterType,
          parameterDeclaration,
          ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
        ),
        description: parameterDescription,
      };
    });
    const returnType = signature.getReturnType();
    signatureSeeds.push(
      checker.typeToString(
        returnType,
        declaration,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
      ),
    );
    const returnTypeText = checker.typeToString(
      returnType,
      declaration,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
    );
    if (!isVoidReturn(returnTypeText) && !tags.returns) {
      violations.push(`${definition.contract}.${member.name}: missing @returns`);
    }
    const signatureText = checker.signatureToString(
      signature,
      declaration,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
    );
    methods.push({
      name: member.name,
      signature: `${member.name}${signatureText}`,
      description: methodDescription,
      parameters,
      returns: {
        type: returnTypeText,
        description: tags.returns,
      },
      throws: tags.throws,
    });
  }

  const catalogMethods = methods
    .map((method) => method.name)
    .sort((left, right) => left.localeCompare(right));
  if (provider) {
    const missing = catalogMethods.filter((method) => !provider.methods.includes(method));
    const extra = provider.methods.filter((method) => !catalogMethods.includes(method));
    if (missing.length) {
      violations.push(
        `${definition.contract}: Provider misses catalog methods ${missing.join(", ")}`,
      );
    }
    if (extra.length) {
      violations.push(
        `${definition.contract}: Provider publishes undocumented methods ${extra.join(", ")}`,
      );
    }
  }

  services.push({
    contract: definition.contract,
    owner: owner ?? "unknown",
    description,
    source: definition.source,
    methods,
    types: referencedTypeClosure(signatureSeeds, symbol?.getName()),
  });
}

for (const [contract, provider] of providers) {
  if (!definitions.has(contract) && contract.startsWith("seashard.")) {
    violations.push(
      `${contract}: ${provider.source} publishes an internal Service without defineServiceContract<T>()`,
    );
  }
}

if (violations.length) {
  throw new Error(
    `service catalog generation failed with ${violations.length} violation(s):\n${violations
      .map((violation) => `- ${violation}`)
      .join("\n")}`,
  );
}

const output = `${JSON.stringify({ version: 1, services }, null, 2)}\n`;
if (checkOnly) {
  let current;
  try {
    current = await readFile(outputPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error("generated Service Catalog is missing; run pnpm generate:service-catalog");
    }
    throw error;
  }
  if (current !== output) {
    throw new Error("generated Service Catalog is stale; run pnpm generate:service-catalog");
  }
  console.log(`Service Catalog is current (${services.length} services)`);
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, "utf8");
  console.log(`Generated ${workspacePath(outputPath)} (${services.length} services)`);
}

function visit(node, callback) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function isWorkspaceSource(fileName) {
  const path = workspacePath(fileName);
  return (
    !path.startsWith("..") &&
    !path.includes("/node_modules/") &&
    !path.includes("/dist/") &&
    /^(apps|components|frontend|packages)\//u.test(path) &&
    /\.[cm]?tsx?$/u.test(path)
  );
}

function workspacePath(fileName) {
  return relative(root, resolve(fileName)).split(sep).join("/");
}

function workspacePointer(sourceFile, node) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `${workspacePath(sourceFile.fileName)}:${line}`;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function unwrapObjectLiteral(node) {
  const current = unwrapExpression(node);
  return current && ts.isObjectLiteralExpression(current) ? current : undefined;
}

function unwrapArrayLiteral(node) {
  const current = unwrapExpression(node);
  return current && ts.isArrayLiteralExpression(current) ? current : undefined;
}

function resolveString(node, seen = new Set()) {
  const current = unwrapExpression(node);
  if (!current) return undefined;
  if (
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === "defineServiceContract" &&
    current.arguments.length === 1
  ) {
    return resolveString(current.arguments[0], seen);
  }
  if (ts.isStringLiteralLike(current)) return current.text;
  if (!ts.isIdentifier(current)) return undefined;
  const symbol = checker.getSymbolAtLocation(current);
  const target =
    symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  // 干净安装尚无 SDK dist 时，TypeScript 可能无法把工作区包别名解析到值声明；
  // 直接保留 import { source as local } 的 source 名称，回到工作区源码查找唯一静态值。
  const importedName = symbol?.declarations
    ?.filter(ts.isImportSpecifier)
    .map((declaration) => declaration.propertyName?.text)
    .find(Boolean);
  const declaration =
    target?.valueDeclaration ?? target?.declarations?.find(ts.isVariableDeclaration);
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
    if (seen.has(declaration)) return undefined;
    seen.add(declaration);
    return resolveString(declaration.initializer, seen);
  }
  for (const name of new Set([target?.getName(), importedName, current.text])) {
    if (!name) continue;
    const value = resolveWorkspaceNamedString(name, seen);
    if (value) return value;
  }
  return undefined;
}

/**
 * 工作区依赖可能通过已经构建的 SDK dist 解析，.d.ts 不保留 const 初始化器。
 * 生成器在这种情况下回到工作区源码中的同名导出，仍以源码为 Catalog 单一事实来源。
 */
function resolveWorkspaceNamedString(name, seen) {
  if (workspaceStringValues.has(name)) return workspaceStringValues.get(name);
  const values = new Set();
  for (const sourceFile of sourceFiles) {
    visit(sourceFile, (node) => {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        node.name.text !== name ||
        !node.initializer ||
        seen.has(node)
      ) {
        return;
      }
      const branch = new Set(seen);
      branch.add(node);
      const value = resolveString(node.initializer, branch);
      if (value) values.add(value);
    });
  }
  const value = values.size === 1 ? values.values().next().value : undefined;
  workspaceStringValues.set(name, value);
  return value;
}

function propertyName(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function setUniqueOwner(contract, owner, sourceFile) {
  const current = owners.get(contract);
  if (current && current !== owner) {
    throw new Error(
      `${workspacePath(sourceFile.fileName)} maps ${contract} to ${owner}, already owned by ${current}`,
    );
  }
  owners.set(contract, owner);
}

function preferredDeclaration(symbol) {
  return (
    symbol.declarations?.find(
      (declaration) =>
        ts.isMethodSignature(declaration) ||
        ts.isMethodDeclaration(declaration) ||
        ts.isPropertySignature(declaration),
    ) ??
    symbol.valueDeclaration ??
    symbol.declarations?.[0]
  );
}

function documentation(symbol) {
  return ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
}

function jsDocTags(declaration) {
  const parameters = new Map();
  let returns = "";
  const throws = [];
  for (const tag of ts.getJSDocTags(declaration)) {
    const name = tag.tagName.text;
    const text = commentText(tag.comment);
    if (name === "param" && "name" in tag && tag.name) {
      parameters.set(tag.name.getText(), text);
    } else if (name === "returns" || name === "return") {
      returns = text;
    } else if (name === "throws" || name === "throw") {
      if (text) throws.push(text);
    }
  }
  return { parameters, returns, throws };
}

function commentText(comment) {
  if (typeof comment === "string") return comment.trim();
  if (!comment) return "";
  return comment
    .map((part) => (typeof part === "string" ? part : (part.text ?? part.getText())))
    .join("")
    .trim();
}

function isVoidReturn(type) {
  return type === "void" || type === "Promise<void>";
}

function indexCatalogTypeDeclarations() {
  const declarations = new Map();
  const ambiguous = new Set();
  for (const sourceFile of sourceFiles) {
    visit(sourceFile, (node) => {
      if (!isCatalogTypeDeclaration(node) || !node.name || !ts.isIdentifier(node.name)) return;
      const name = node.name.text;
      if (ambiguous.has(name)) return;
      if (declarations.has(name)) {
        declarations.delete(name);
        ambiguous.add(name);
        return;
      }
      const symbol = checker.getSymbolAtLocation(node.name);
      declarations.set(name, {
        name,
        description: symbol ? documentation(symbol) : "",
        declaration: node.getFullText(sourceFile).trim(),
        source: workspacePointer(sourceFile, node),
      });
    });
  }
  return declarations;
}

function referencedTypeClosure(seeds, serviceTypeName) {
  const included = new Map();
  let frontier = [...seeds];
  while (frontier.length) {
    const next = [];
    for (const [name, declaration] of catalogTypeDeclarations) {
      if (name === serviceTypeName || included.has(name)) continue;
      const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "u");
      if (!frontier.some((text) => pattern.test(text))) continue;
      included.set(name, declaration);
      next.push(declaration.declaration);
    }
    frontier = next;
  }
  return [...included.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isCatalogTypeDeclaration(declaration) {
  return (
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isClassDeclaration(declaration)
  );
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}
