import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const uninstallScript = join(repositoryRoot, "scripts", "uninstall-server.sh");
const platformSkip = process.platform === "win32" ? "POSIX 卸载脚本仅在 Linux 和 macOS 执行" : false;

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly dataHome: string;
  readonly configHome: string;
  readonly binHome: string;
  readonly runtimeRoot: string;
  readonly runtimeCommand: string;
  readonly launcher: string;
  readonly logFile: string;
  readonly environment: NodeJS.ProcessEnv;
}

async function createFixture(
  context: TestContext,
  options: { readonly ownershipMarker?: boolean; readonly launcher?: boolean } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "seashard-uninstall-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataHome = join(root, "data");
  const configHome = join(root, "config");
  const binHome = join(root, "bin");
  const runtimeRoot = join(dataHome, "SeaShard", "server", "runtime");
  const runtimeCommand = join(runtimeRoot, "seashard-server");
  const launcher = join(binHome, "seashard-server");
  const logFile = join(root, "service.log");
  const toolRoot = join(root, "tools");

  await Promise.all([
    mkdir(runtimeRoot, { recursive: true }),
    mkdir(join(configHome, "SeaShard", "server-controller"), { recursive: true }),
    mkdir(join(configHome, "systemd", "user"), { recursive: true }),
    mkdir(binHome, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(toolRoot, { recursive: true }),
  ]);
  await writeFile(join(configHome, "SeaShard", "server-controller", "persistent.txt"), "keep\n");
  await writeFile(
    runtimeCommand,
    [
      "#!/bin/sh",
      'printf \'override=%s\\n\' "${SEASHARD_SERVER_DATA_DIR-unset}" > "$SEASHARD_UNINSTALL_TEST_LOG"',
      'printf \'arg=%s\\n\' "$@" >> "$SEASHARD_UNINSTALL_TEST_LOG"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(join(toolRoot, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
  if (options.ownershipMarker) {
    await writeFile(join(dataHome, "SeaShard", "server", ".install-source"), "seashard-install-script-v1\n");
  }
  if (options.launcher) await symlink(runtimeCommand, launcher);

  return {
    root,
    home,
    dataHome,
    configHome,
    binHome,
    runtimeRoot,
    runtimeCommand,
    launcher,
    logFile,
    environment: {
      ...process.env,
      PATH: `${toolRoot}${delimiter}${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: configHome,
      XDG_BIN_HOME: binHome,
      SEASHARD_SHARED_DATA_DIR: join(root, "victim", "shared"),
      SEASHARD_SERVER_DATA_DIR: join(root, "victim", "server"),
      SEASHARD_UNINSTALL_TEST_LOG: logFile,
    },
  };
}

function runUninstaller(fixture: Fixture, environment: NodeJS.ProcessEnv = fixture.environment) {
  return spawnSync("sh", [uninstallScript], {
    cwd: fixture.root,
    env: environment,
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

await test("script uninstaller fixes service paths and preserves user data", { skip: platformSkip }, async (t) => {
  const fixture = await createFixture(t, { ownershipMarker: true, launcher: true });
  const result = runUninstaller(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readFile(fixture.logFile, "utf8")).trim().split("\n"), [
    "override=unset",
    "arg=service",
    "arg=uninstall",
    `arg=--shared-data-root=${join(fixture.configHome, "SeaShard")}`,
    `arg=--data-root=${join(fixture.configHome, "SeaShard", "server-controller")}`,
    `arg=--host-data-root=${join(fixture.configHome, "SeaShard", "core")}`,
  ]);
  assert.equal(await exists(fixture.runtimeRoot), false);
  assert.equal(await exists(fixture.launcher), false);
  assert.equal(
    await exists(join(fixture.configHome, "SeaShard", "server-controller", "persistent.txt")),
    true,
  );
});

await test("script uninstaller accepts the exact legacy launcher as ownership proof", { skip: platformSkip }, async (t) => {
  const fixture = await createFixture(t, { launcher: true });
  const result = runUninstaller(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await exists(fixture.runtimeRoot), false);
});

await test("script uninstaller rejects relative data roots before deletion", { skip: platformSkip }, async (t) => {
  const fixture = await createFixture(t, { ownershipMarker: true, launcher: true });
  const sentinel = join(fixture.root, "relative-data", "SeaShard", "server", "sentinel.txt");
  await mkdir(dirname(sentinel), { recursive: true });
  await writeFile(sentinel, "keep\n");
  const result = runUninstaller(fixture, {
    ...fixture.environment,
    XDG_DATA_HOME: "relative-data",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /data home must be an absolute path/u);
  assert.equal(await exists(sentinel), true);
});

await test("script uninstaller rejects a symlinked installation root", { skip: platformSkip }, async (t) => {
  const fixture = await createFixture(t);
  const installationRoot = join(fixture.dataHome, "SeaShard", "server");
  const externalRoot = join(fixture.root, "external-runtime");
  await rm(installationRoot, { recursive: true, force: true });
  await mkdir(externalRoot, { recursive: true });
  await writeFile(join(externalRoot, "sentinel.txt"), "keep\n");
  await symlink(externalRoot, installationRoot);

  const result = runUninstaller(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /installation root crosses a symbolic link/u);
  assert.equal(await exists(join(externalRoot, "sentinel.txt")), true);
});

await test("script uninstaller refuses an unowned runtime", { skip: platformSkip }, async (t) => {
  const fixture = await createFixture(t);
  const result = runUninstaller(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /installation ownership could not be proven/u);
  assert.equal(await exists(fixture.runtimeRoot), true);
});
