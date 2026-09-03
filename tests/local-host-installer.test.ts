import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hostControlProtocolVersion,
  resolveHostControlLocation,
} from "../packages/host-control/src/index.ts";
import {
  registerStandaloneHost,
  type HostInstallationRecord,
} from "../packages/host-installation/src/index.ts";
import { ensureLocalHostInstallation } from "../packages/local-host-installer/src/index.ts";

await test("existing standalone Host skips the bundled installer", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-local-host-installer-"));
  try {
    await registerStandaloneHost(dataRoot, "deb");
    let installCalls = 0;
    const result = await ensureLocalHostInstallation({
      dataRoot,
      install: async () => {
        installCalls += 1;
      },
    });
    assert.equal(installCalls, 0);
    assert.deepEqual(result, {
      disposition: "existing",
      installation: standaloneInstallation("deb"),
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("new bundled installation waits for the Host control descriptor", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-local-host-installer-"));
  try {
    const result = await ensureLocalHostInstallation({
      dataRoot,
      readyTimeoutMilliseconds: 500,
      readyPollMilliseconds: 1,
      install: async () => {
        await registerStandaloneHost(dataRoot, "nsis");
        const location = await resolveHostControlLocation(dataRoot);
        await writeFile(
          location.descriptorPath,
          JSON.stringify({
            protocolVersion: hostControlProtocolVersion,
            socketPath: location.socketPath,
            descriptorPath: location.descriptorPath,
            token: "a".repeat(64),
            pid: process.pid,
            startedAt: new Date().toISOString(),
            seaShardVersion: "0.0.0",
            packageType: "nsis",
          }),
        );
      },
    });
    assert.deepEqual(result, {
      disposition: "installed",
      installation: standaloneInstallation("nsis"),
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

function standaloneInstallation(packageType: "deb" | "nsis"): HostInstallationRecord {
  return {
    schemaVersion: 1,
    kind: "standalone",
    packageType,
    owners: [],
  };
}
