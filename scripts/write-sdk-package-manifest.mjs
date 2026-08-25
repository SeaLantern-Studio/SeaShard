import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const packageRoot = resolve(process.cwd(), process.argv[2] ?? ".");
const sourceManifestPath = join(packageRoot, "package.json");
const outputRoot = join(packageRoot, "dist");
const readmePath = join(packageRoot, "README.md");
const licensePath = resolve(packageRoot, "../sdk-license/LICENSE");
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));

validateSourceManifest(sourceManifest, sourceManifestPath);
await Promise.all([
  access(join(outputRoot, "index.js")),
  access(join(outputRoot, "index.d.ts")),
  access(readmePath),
  access(licensePath),
]);

// 发布目录只保留消费者需要的字段，避免把 workspace 链接和仓库构建脚本带入独立产物。
const packageManifest = {
  name: sourceManifest.name,
  version: sourceManifest.version,
  description: sourceManifest.description,
  license: sourceManifest.license,
  keywords: sourceManifest.keywords,
  type: "module",
  sideEffects: false,
  main: "./index.js",
  types: "./index.d.ts",
  exports: {
    ".": {
      types: "./index.d.ts",
      import: "./index.js",
      default: "./index.js",
    },
  },
  files: ["index.js", "index.d.ts", "README.md", "LICENSE"],
  engines: sourceManifest.engines,
  ...(sourceManifest.peerDependencies ? { peerDependencies: sourceManifest.peerDependencies } : {}),
};

await Promise.all([
  writeFile(
    join(outputRoot, "package.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
    "utf8",
  ),
  copyFile(readmePath, join(outputRoot, "README.md")),
  copyFile(licensePath, join(outputRoot, "LICENSE")),
]);

function validateSourceManifest(manifest, manifestPath) {
  if (manifest.private === true) {
    throw new Error(`SDK package cannot be private: ${manifestPath}`);
  }
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`SDK package name or version is missing: ${manifestPath}`);
  }
  if (manifest.publishConfig?.directory !== "dist") {
    throw new Error(`SDK package must publish from dist: ${manifestPath}`);
  }
  if (manifest.license !== "AGPL-3.0-only") {
    throw new Error(`SDK package must use AGPL-3.0-only: ${manifestPath}`);
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (typeof range !== "string" || range.startsWith("workspace:")) {
      throw new Error(`SDK peer dependency must use a release range: ${name}@${String(range)}`);
    }
  }
}
