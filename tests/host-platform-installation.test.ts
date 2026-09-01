import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureStandaloneHostAutostart,
  resolveDefaultHostDataRoot,
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
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(join(home, "Downloads"), { recursive: true }),
  );
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
