import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readHostInstallation,
  registerBundledHostOwner,
  registerStandaloneHost,
  releaseBundledHostOwner,
} from "../packages/host-installation/src/index.ts";

await test("standalone Host ownership survives bundled product reuse", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-host-installation-"));
  try {
    await registerStandaloneHost(dataRoot);
    assert.deepEqual(await registerBundledHostOwner(dataRoot, "desktop"), {
      schemaVersion: 1,
      kind: "standalone",
      owners: [],
    });
    assert.equal((await releaseBundledHostOwner(dataRoot, "desktop")).removeHost, false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("bundled Host is removable only after its final owner releases it", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-host-installation-"));
  try {
    await registerBundledHostOwner(dataRoot, "desktop");
    await registerBundledHostOwner(dataRoot, "server");
    const desktopReleased = await releaseBundledHostOwner(dataRoot, "desktop");
    assert.equal(desktopReleased.removeHost, false);
    assert.deepEqual(desktopReleased.installation.owners, ["server"]);

    const serverReleased = await releaseBundledHostOwner(dataRoot, "server");
    assert.equal(serverReleased.removeHost, true);
    assert.deepEqual(await readHostInstallation(dataRoot), {
      schemaVersion: 1,
      kind: "bundled",
      owners: [],
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("installer marker removal overrides stale bundled ownership JSON", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-host-installation-"));
  try {
    await registerBundledHostOwner(dataRoot, "desktop");
    await rm(join(dataRoot, "host-installation", "owners", "desktop"));
    assert.deepEqual(await readHostInstallation(dataRoot), {
      schemaVersion: 1,
      kind: "bundled",
      owners: [],
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("legacy JSON-only installation records remain readable", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-host-installation-"));
  try {
    await writeFile(
      join(dataRoot, "host-installation.json"),
      JSON.stringify({ schemaVersion: 1, kind: "bundled", owners: ["desktop"] }),
    );
    assert.deepEqual(await readHostInstallation(dataRoot), {
      schemaVersion: 1,
      kind: "bundled",
      owners: ["desktop"],
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
