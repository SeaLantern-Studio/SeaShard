import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const uninstallScript = join(repositoryRoot, "scripts", "uninstall-seashard.sh");
const platformSkip = process.platform === "win32" ? "POSIX 卸载行为在 Linux CI 中验证" : false;

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly dataHome: string;
  readonly configHome: string;
  readonly binHome: string;
  readonly controllerAppImage: string;
  readonly controllerDataRoot: string;
  readonly hostDataRoot: string;
  readonly hostInstallationRoot: string;
  readonly environment: NodeJS.ProcessEnv;
}

async function createFixture(context: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "seashard-component-uninstall-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataHome = join(root, "data");
  const configHome = join(root, "config");
  const binHome = join(root, "bin");
  const toolRoot = join(root, "tools");
  const controllerAppImage = join(root, "SeaShard.AppImage");
  const controllerDataRoot = join(configHome, "SeaShard", "desktop-controller");
  const hostDataRoot = join(configHome, "SeaShard", "core");
  const hostInstallationRoot = join(dataHome, "SeaShard", "host");

  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(dataHome, { recursive: true }),
    mkdir(configHome, { recursive: true }),
    mkdir(binHome, { recursive: true }),
    mkdir(toolRoot, { recursive: true }),
    mkdir(controllerDataRoot, { recursive: true }),
    mkdir(join(hostDataRoot, "host-installation", "package-types"), { recursive: true }),
    mkdir(join(hostInstallationRoot, "runtime"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(controllerAppImage, "controller-image\n", { mode: 0o755 }),
    writeFile(join(hostDataRoot, "host-installation", "standalone"), ""),
    writeFile(join(hostDataRoot, "host-installation", "package-types", "appimage"), ""),
    writeFile(join(hostDataRoot, "persistent-server-data.txt"), "keep\n"),
    writeFile(join(hostInstallationRoot, "runtime", "AppRun"), "host-runtime\n"),
    writeFile(join(toolRoot, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 }),
  ]);
  await chmod(join(toolRoot, "uname"), 0o755);

  return {
    root,
    home,
    dataHome,
    configHome,
    binHome,
    controllerAppImage,
    controllerDataRoot,
    hostDataRoot,
    hostInstallationRoot,
    environment: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: configHome,
      XDG_BIN_HOME: binHome,
      PATH: `${toolRoot}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

function runUninstaller(fixture: Fixture, arguments_: readonly string[]) {
  return spawnSync("sh", [uninstallScript, ...arguments_], {
    cwd: fixture.root,
    env: fixture.environment,
    encoding: "utf8",
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

await test("component uninstaller scripts pass POSIX shell syntax validation", () => {
  for (const script of [
    uninstallScript,
    join(repositoryRoot, "scripts", "install-macos-uninstaller-app.sh"),
    join(repositoryRoot, "build", "macos-controller-scripts", "postinstall"),
    join(repositoryRoot, "build", "macos-host-scripts", "postinstall"),
  ]) {
    const result = spawnSync("sh", ["-n", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

await test(
  "Linux unified uninstaller supports Host-only followed by Controller-only removal",
  { skip: platformSkip },
  async (t) => {
    const fixture = await createFixture(t);
    const registration = runUninstaller(fixture, [
      "--register-controller",
      "appimage",
      fixture.controllerAppImage,
      fixture.controllerDataRoot,
    ]);
    assert.equal(registration.status, 0, registration.stderr);

    const installedUninstaller = join(
      fixture.dataHome,
      "SeaShard",
      "uninstaller",
      "uninstall-seashard.sh",
    );
    assert.equal(await exists(installedUninstaller), true);
    assert.equal(await exists(join(fixture.binHome, "seashard-uninstall")), true);

    const hostRemoval = runUninstaller(fixture, ["--host"]);
    assert.equal(hostRemoval.status, 0, hostRemoval.stderr);
    assert.match(hostRemoval.stdout, /Host：已卸载/u);
    assert.equal(await exists(fixture.hostInstallationRoot), false);
    assert.equal(await exists(join(fixture.hostDataRoot, "host-installation")), false);
    assert.equal(
      await readFile(join(fixture.hostDataRoot, "persistent-server-data.txt"), "utf8"),
      "keep\n",
    );
    assert.equal(
      await exists(join(fixture.controllerDataRoot, "local-host-auto-install.disabled")),
      true,
    );
    assert.equal(await exists(fixture.controllerAppImage), true);
    assert.equal(await exists(installedUninstaller), true);

    const controllerRemoval = runUninstaller(fixture, ["--controller"]);
    assert.equal(controllerRemoval.status, 0, controllerRemoval.stderr);
    assert.match(controllerRemoval.stdout, /Desktop Controller：已卸载/u);
    assert.equal(await exists(fixture.controllerAppImage), false);
    assert.equal(await exists(join(fixture.dataHome, "SeaShard", "uninstaller")), false);
    assert.equal(await exists(join(fixture.binHome, "seashard-uninstall")), false);
  },
);

await test(
  "Linux Host removal refuses a symlinked data root before deleting Runtime",
  { skip: platformSkip },
  async (t) => {
    const fixture = await createFixture(t);
    const externalDataRoot = join(fixture.root, "external-host-data");
    await mkdir(join(externalDataRoot, "host-installation"), { recursive: true });
    await writeFile(join(externalDataRoot, "host-installation", "standalone"), "");
    await writeFile(join(externalDataRoot, "sentinel.txt"), "keep\n");
    await rm(fixture.hostDataRoot, { recursive: true, force: true });
    await symlink(externalDataRoot, fixture.hostDataRoot);

    const result = runUninstaller(fixture, ["--host"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Host 数据目录经过了符号链接/u);
    assert.equal(await readFile(join(externalDataRoot, "sentinel.txt"), "utf8"), "keep\n");
    assert.equal(await exists(fixture.hostInstallationRoot), true);
  },
);
