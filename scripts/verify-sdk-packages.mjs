import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), "seashard-sdk-"));
const consumerRoot = join(sandbox, "consumer");
const tarballRoot = join(consumerRoot, "tarballs");
const packageNames = [
  ["plugin-sdk", "@seashard/plugin-sdk"],
  ["contracts", "@seashard/contracts"],
  ["ui-sdk", "@seashard/ui-sdk"],
];

try {
  await mkdir(tarballRoot, { recursive: true });
  for (const [directory] of packageNames) {
    await runPnpm(["pack", "--pack-destination", tarballRoot], join(root, "packages", directory));
  }

  const tarballs = (await readdir(tarballRoot)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== packageNames.length) {
    throw new Error(`expected ${packageNames.length} SDK tarballs, received ${tarballs.length}`);
  }

  const dependencies = Object.fromEntries(
    packageNames.map(([, packageName]) => {
      const archivePrefix = packageName.replace("@", "").replace("/", "-");
      const archive = tarballs.find((name) => name.startsWith(`${archivePrefix}-`));
      if (!archive) throw new Error(`missing tarball for ${packageName}`);
      return [packageName, `file:./tarballs/${archive}`];
    }),
  );

  await writeConsumerFixture(dependencies);
  await runPnpm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--config.auto-install-peers=false",
      "--config.strict-peer-dependencies=false",
    ],
    consumerRoot,
  );
  await verifyInstalledPackages();
  await runCommand(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    consumerRoot,
  );
  await runCommand(process.execPath, ["runtime.mjs"], consumerRoot);
  console.log("SEASHARD_SDK_VERIFY_OK packages=3");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

async function writeConsumerFixture(dependencies) {
  const manifest = {
    name: "seashard-sdk-verification",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: {
      ...dependencies,
      vue: "file:./vue-stub",
    },
  };
  const tsconfig = {
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      lib: ["ES2023", "DOM", "DOM.Iterable"],
    },
    include: ["consumer.ts"],
  };
  const consumerSource = `import {
  type PluginModule,
  type PluginPackageManifest,
} from "@seashard/plugin-sdk";
import {
  runtimeDiagnosticsContract,
  type RuntimeDiagnosticsService,
} from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";

const manifest = {
  id: "example.sdk-verification",
  version: "0.1.0",
  publisher: "SeaShard",
  compatibility: {
    seaShard: "^0.1.0",
  },
  entries: [
    {
      id: "host",
      runtime: "host",
      module: "dist/host.js",
      uses: {
        [runtimeDiagnosticsContract]: ["getSnapshot"],
      },
    },
  ],
} satisfies PluginPackageManifest;

const hostModule: PluginModule = {
  apply(context) {
    const diagnostics = context.service<RuntimeDiagnosticsService>(runtimeDiagnosticsContract);
    void diagnostics.getSnapshot();
  },
};

const clientModule = defineClientUiModule({
  apply(context) {
    void context.entry.pluginId;
  },
});

void manifest;
void hostModule;
void clientModule;
`;
  // 使用本地最小 Vue 包满足 UI SDK 的 peer，验证过程保持完全离线。
  const vueManifest = {
    name: "vue",
    version: "3.5.41",
    type: "module",
    types: "./index.d.ts",
    exports: {
      ".": {
        types: "./index.d.ts",
        default: "./index.js",
      },
    },
  };
  const vueTypes = `export interface Component {}
export interface Ref<T = unknown> {
  value: T;
}
`;
  const runtimeSource = `import { isAgentActivityPresentationIcon } from "@seashard/plugin-sdk";
import { runtimeDiagnosticsContract } from "@seashard/contracts";
import { defineClientUiModule } from "@seashard/ui-sdk";

if (runtimeDiagnosticsContract !== "seashard.runtime-diagnostics") {
  throw new Error("contracts runtime export is invalid");
}
if (!isAgentActivityPresentationIcon("wrench") || isAgentActivityPresentationIcon("unknown")) {
  throw new Error("plugin SDK runtime helper is invalid");
}
const module = defineClientUiModule({ apply() {} });
if (typeof module.apply !== "function") {
  throw new Error("UI SDK runtime export is invalid");
}
console.log("SEASHARD_SDK_RUNTIME_OK");
`;

  const vueRoot = join(consumerRoot, "vue-stub");
  await mkdir(vueRoot, { recursive: true });
  await Promise.all([
    writeFile(join(consumerRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(consumerRoot, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`),
    writeFile(join(consumerRoot, "consumer.ts"), consumerSource),
    writeFile(join(vueRoot, "package.json"), `${JSON.stringify(vueManifest, null, 2)}\n`),
    writeFile(join(vueRoot, "index.d.ts"), vueTypes),
    writeFile(join(vueRoot, "index.js"), "export {};\n"),
    writeFile(join(consumerRoot, "runtime.mjs"), runtimeSource),
  ]);
}

async function verifyInstalledPackages() {
  for (const [, packageName] of packageNames) {
    const packageRoot = join(consumerRoot, "node_modules", ...packageName.split("/"));
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const serialized = JSON.stringify(manifest);
    if (
      manifest.private === true ||
      serialized.includes("workspace:") ||
      serialized.includes("src/index.ts")
    ) {
      throw new Error(`packed manifest leaks repository-only metadata: ${packageName}`);
    }
    if (manifest.license !== "AGPL-3.0-only") {
      throw new Error(`packed license is invalid: ${packageName}`);
    }
    if (
      manifest.exports?.["."]?.types !== "./index.d.ts" ||
      manifest.exports?.["."]?.import !== "./index.js"
    ) {
      throw new Error(`packed exports are invalid: ${packageName}`);
    }
    await Promise.all([
      access(join(packageRoot, "index.js")),
      access(join(packageRoot, "index.d.ts")),
      access(join(packageRoot, "README.md")),
      access(join(packageRoot, "LICENSE")),
    ]);
  }
}

async function runPnpm(arguments_, cwd) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return runCommand(process.execPath, [npmExecPath, ...arguments_], cwd);
  }
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return runCommand(command, arguments_, cwd);
}

async function runCommand(command, arguments_, cwd) {
  const child = spawn(command, arguments_, {
    cwd,
    env: { ...process.env, CI: "1" },
    stdio: "inherit",
  });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed with code ${String(exit.code)} and signal ${String(exit.signal)}`,
    );
  }
}
