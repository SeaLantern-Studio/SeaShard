import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureStandaloneHostAutostart,
  resolveDefaultHostDataRoot,
  resolveHostPackageType,
} from "../apps/host/src/autostart.ts";

await test("Host default data root matches Desktop conventions on every packaged platform", () => {
  assert.equal(
    resolveDefaultHostDataRoot(
      "win32",
      { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
      "ignored",
    ),
    "C:\\Users\\test\\AppData\\Roaming/SeaShard/core".replaceAll("/", "\\"),
  );
  assert.equal(
    resolveDefaultHostDataRoot("darwin", {}, "/Users/test"),
    "/Users/test/Library/Application Support/SeaShard/core",
  );
  assert.equal(
    resolveDefaultHostDataRoot("linux", { XDG_CONFIG_HOME: "/home/test/config" }, "/home/test"),
    "/home/test/config/SeaShard/core",
  );
  assert.equal(
    resolveDefaultHostDataRoot("linux", {}, "/home/test"),
    "/home/test/.config/SeaShard/core",
  );
});

await test("Host detects its own package type without consulting Controller packaging", async (t) => {
  const resources = await mkdtemp(join(tmpdir(), "seashard-host-package-type-"));
  t.after(() => rm(resources, { recursive: true, force: true }));
  await writeFile(join(resources, "package-type"), "deb\n", "utf8");

  assert.equal(
    resolveHostPackageType("linux", {}, "/opt/SeaShard Host/seashard-host", resources),
    "deb",
  );
  assert.equal(
    resolveHostPackageType(
      "linux",
      { APPIMAGE: "/home/test/SeaShard-Host.AppImage" },
      "/tmp/.mount_host/seashard-host",
      resources,
    ),
    "appimage",
  );
  assert.equal(
    resolveHostPackageType(
      "linux",
      { SEASHARD_HOST_INSTALLED_EXECUTABLE: "/home/test/.local/share/SeaShard/host/AppRun" },
      "/home/test/.local/share/SeaShard/host/AppRun",
      "/missing",
    ),
    "appimage",
  );
  assert.equal(resolveHostPackageType("win32", {}, "C:\\SeaShard\\SeaShardHost.exe"), "nsis");
  assert.equal(
    resolveHostPackageType(
      "darwin",
      {},
      "/Applications/SeaShard Host.app/Contents/MacOS/SeaShardHost",
    ),
    "pkg",
  );
});

await test("macOS Host writes a per-user LaunchAgent without touching instance data", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "seashard-host-macos-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataRoot = join(home, "Library", "Application Support", "SeaShard", "core");

  await ensureStandaloneHostAutostart({
    platform: "darwin",
    environment: {},
    homeDirectory: home,
    executablePath: "/Applications/SeaShard Host.app/Contents/MacOS/SeaShardHost",
    dataRoot,
  });

  const plist = await readFile(
    join(home, "Library", "LaunchAgents", "studio.sealantern.seashard.host.plist"),
    "utf8",
  );
  assert.match(plist, /SeaShardHost/u);
  assert.match(plist, /--data-root=/u);
  assert.match(plist, /<key>KeepAlive<\/key>/u);
});

await test("Linux Host stabilizes an AppImage path before writing XDG autostart", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "seashard-host-linux-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const downloaded = join(home, "Downloads", "SeaShard-Host.AppImage");
  await mkdir(join(home, "Downloads"), { recursive: true });
  await writeFile(downloaded, "host-image", "utf8");
  await chmod(downloaded, 0o755);
  const dataRoot = join(home, ".config", "SeaShard", "core");

  await ensureStandaloneHostAutostart({
    platform: "linux",
    environment: { APPIMAGE: downloaded },
    homeDirectory: home,
    executablePath: downloaded,
    dataRoot,
  });

  const installed = join(home, ".local", "share", "SeaShard", "host", "SeaShardHost.AppImage");
  assert.equal(await readFile(installed, "utf8"), "host-image");
  const desktop = await readFile(
    join(home, ".config", "autostart", "studio.sealantern.seashard.host.desktop"),
    "utf8",
  );
  assert.ok(desktop.includes(installed.replaceAll("\\", "\\\\")));
  assert.match(desktop, /NoDisplay=true/u);
});

await test("Linux Host autostart uses a permanently installed extracted Runtime", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "seashard-host-linux-installed-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const installed = join(home, ".local", "share", "SeaShard", "host", "runtime", "AppRun");
  const dataRoot = join(home, ".config", "SeaShard", "core");

  await ensureStandaloneHostAutostart({
    platform: "linux",
    environment: { SEASHARD_HOST_INSTALLED_EXECUTABLE: installed },
    homeDirectory: home,
    executablePath: installed,
    dataRoot,
  });

  const desktop = await readFile(
    join(home, ".config", "autostart", "studio.sealantern.seashard.host.desktop"),
    "utf8",
  );
  assert.ok(desktop.includes(installed.replaceAll("\\", "\\\\")));
  assert.doesNotMatch(desktop, /SeaShardHost\.AppImage/u);
});
