import electron from "electron";
import { zipSync } from "fflate";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = fileURLToPath(new URL("../apps/desktop/dist/main/index.js", import.meta.url));
const pluginSource = fileURLToPath(new URL("../fixtures/plugins/smoke", import.meta.url));
const dataRoot = await mkdtemp(join(tmpdir(), "seashard-smoke-"));
const userDataRoot = join(dataRoot, "electron-user-data");
const archivePath = join(dataRoot, "smoke.seashard-plugin");
await writePluginArchive(archivePath);
await mkdir(userDataRoot, { recursive: true });

try {
  await runElectron("install", { SEASHARD_SMOKE_PLUGIN_ARCHIVE: archivePath });
  await runElectron("recovery", {});
  verifyPersistedState(join(dataRoot, "seashard.sqlite3"));
  await verifyAgentModels(join(userDataRoot, "agent", "models.yml"));
  console.log("SEASHARD_SMOKE_OK");
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}

async function writePluginArchive(target) {
  const manifest = await readFile(join(pluginSource, "plugin.json"));
  const hostModule = await readFile(join(pluginSource, "dist/host.js"));
  const archive = zipSync(
    {
      "plugin.json": manifest,
      "dist/host.js": hostModule,
    },
    { level: 9 },
  );
  await writeFile(target, archive);
}

async function runElectron(label, extraEnvironment) {
  let output = "";
  const child = spawn(electron, [entry], {
    cwd: root,
    env: {
      ...process.env,
      ...extraEnvironment,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      SEASHARD_DATA_DIR: dataRoot,
      SEASHARD_SMOKE: "1",
      SEASHARD_SMOKE_USER_DATA_DIR: userDataRoot,
      SEASHARD_SMOKE_EXPECT_PLUGIN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timer = setTimeout(() => child.kill(), 30_000);
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
  }

  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);

  const required = [
    "SEASHARD_PLUGIN_SMOKE_ECHO core-smoke:probe",
    "SEASHARD_PLUGIN_SMOKE_RELOADED",
    "SEASHARD_PLUGIN_SMOKE_STORAGE",
    "SEASHARD_PLUGIN_SMOKE_RESOURCE before=core-smoke:probe:detail after=core-smoke:reload:plain",
    "SEASHARD_SMOKE_READY components=12",
    "SEASHARD_SMOKE_SERVER_INSTANCES count=0",
    "SEASHARD_SMOKE_AGENT_SERVER_RESOURCE count=0",
    "SEASHARD_PLUGIN_HOST_ACTIVE runtime=smoke.external-plugin",
    "SEASHARD_PLUGIN_HOST_DISPOSED runtime=smoke.external-plugin",
    "SEASHARD_SMOKE_CONTROLLER_DISPOSED",
    "SEASHARD_HOST_STOPPED",
  ];
  if (label === "install") required.push("SEASHARD_PLUGIN_SMOKE_TRUST_REJECTED");
  const missing = required.filter((marker) => !output.includes(marker));
  if (exit.code !== 0 || missing.length) {
    throw new Error(
      `Electron ${label} smoke failed with code ${exit.code}, signal ${exit.signal}, missing ${missing.join(", ")}.\n${output}`,
    );
  }
}

async function verifyAgentModels(modelsPath) {
  const source = await readFile(modelsPath, "utf8");
  if (!source.includes("providers: {}")) {
    throw new Error(`unexpected Agent model configuration: ${modelsPath}`);
  }
  console.log("SEASHARD_SMOKE_AGENT_MODELS_OK");
}

function verifyPersistedState(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const packages = database.prepare("SELECT COUNT(*) AS count FROM plugin_current").get();
    const bindings = database.prepare("SELECT COUNT(*) AS count FROM plugin_bindings").get();
    const packageCount = Number(packages.count);
    const bindingCount = Number(bindings.count);
    // Host 只持久化下载与 Java 两个设备能力；服务器领域组件和 Desktop Shell 均在 Controller。
    if (packageCount !== 2 || bindingCount !== 2) {
      throw new Error(
        `unexpected persisted state: packages=${packageCount}, bindings=${bindingCount}`,
      );
    }
    console.log(`SEASHARD_SMOKE_PERSISTED packages=${packageCount} bindings=${bindingCount}`);
  } finally {
    database.close();
  }
}
