import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  connectHostControlClient,
  HostControlRpcError,
  startHostControlServer,
} from "../packages/host-control/src/index.ts";
import { DesktopHostConnections } from "../apps/desktop/src/main/desktop-host-connections.ts";
import {
  findHostPrompt,
  shouldShowHostChrome,
} from "../apps/desktop/src/renderer/host-connections.ts";

await test("Host allows concurrent readers and transfers one write controller", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-host-control-"));
  const writes: string[] = [];
  const server = await startHostControlServer({
    dataRoot,
    seaShardVersion: "1.3.0",
    packageType: "deb",
    handlers: {
      async callService(call) {
        if (call.method === "writeValue") {
          const value = call.args[0];
          if (typeof value !== "string") throw new TypeError("writeValue expects a string");
          writes.push(value);
        }
        return call.method === "getValue" ? "visible" : undefined;
      },
      isMutation(call) {
        return call.method === "writeValue";
      },
    },
  });
  const first = await connectHostControlClient({
    dataRoot,
    identity: { sessionId: "desktop-first", label: "Desktop First" },
  });
  const second = await connectHostControlClient({
    dataRoot,
    identity: { sessionId: "desktop-second", label: "Desktop Second" },
  });

  try {
    const firstService = first.service<{
      getValue(): Promise<string>;
      writeValue(value: string): Promise<void>;
    }>("test.control");
    const secondService = second.service<{
      getValue(): Promise<string>;
      writeValue(value: string): Promise<void>;
    }>("test.control");

    assert.equal(first.hasControl, true);
    assert.equal(first.hostVersion, "1.3.0");
    assert.equal(first.hostPackageType, "deb");
    assert.equal(second.hasControl, false);
    assert.equal(await secondService.getValue(), "visible");
    await assert.rejects(
      secondService.writeValue("blocked"),
      (error: unknown) => error instanceof HostControlRpcError && error.code === "CONTROL_REQUIRED",
    );

    const requestedBySecond = await second.requestControl();
    assert.equal(requestedBySecond.pending?.requester.sessionId, second.identity.sessionId);
    await first.confirmControl(requestedBySecond.pending!.requestId);
    assert.equal(second.hasControl, true);
    await secondService.writeValue("second");
    await assert.rejects(
      firstService.writeValue("stale-first"),
      (error: unknown) => error instanceof HostControlRpcError && error.code === "CONTROL_REQUIRED",
    );

    const requestedByFirst = await first.requestControl();
    assert.equal(requestedByFirst.pending?.requester.sessionId, first.identity.sessionId);
    await first.confirmControl(requestedByFirst.pending!.requestId);
    assert.equal(first.hasControl, true);
    await firstService.writeValue("first");
    assert.deepEqual(writes, ["second", "first"]);

    first.dispose();
    await waitFor(() => second.hasControl);
    await secondService.writeValue("reassigned");
    assert.deepEqual(writes, ["second", "first", "reassigned"]);
  } finally {
    first.dispose();
    second.dispose();
    await server.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("Desktop projects Host conflicts as read-only and hides normal local control", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "seashard-desktop-host-"));
  const server = await startHostControlServer({
    dataRoot,
    handlers: {
      async callService() {
        return undefined;
      },
      isMutation() {
        return false;
      },
    },
  });
  const first = await connectHostControlClient({
    dataRoot,
    identity: { sessionId: "desktop-first", label: "Desktop First" },
  });
  const second = await connectHostControlClient({
    dataRoot,
    identity: { sessionId: "desktop-second", label: "Desktop Second" },
  });
  const connections = new DesktopHostConnections({
    controllerSessionId: second.identity.sessionId,
    initialInstallation: "installed",
    initialClient: second,
    connectLocal: () =>
      connectHostControlClient({
        dataRoot,
        identity: second.identity,
      }),
    readLocalInstallation: async () => "installed",
    installLocal: async () => {},
  });
  try {
    const occupied = connections.getSnapshot();
    assert.equal(occupied.hosts[0]?.state, "read-only");
    assert.equal(occupied.hosts[0]?.holder?.sessionId, first.identity.sessionId);
    assert.equal(shouldShowHostChrome(occupied), true);
    assert.equal(findHostPrompt(occupied)?.kind, "occupied");

    const acknowledged = connections.acknowledgeConflict("local");
    assert.equal(findHostPrompt(acknowledged), undefined);

    const requested = await connections.requestControl("local");
    assert.equal(findHostPrompt(requested)?.kind, "outgoing");
    const requestId = requested.hosts[0]?.pending?.requestId;
    assert.ok(requestId);
    const rejected = await connections.rejectControl("local", requestId!);
    assert.equal(rejected.hosts[0]?.state, "read-only");
    assert.equal(rejected.hosts[0]?.pending, undefined);
    assert.equal(findHostPrompt(rejected), undefined);

    const requestedAgain = await connections.requestControl("local");
    const nextRequestId = requestedAgain.hosts[0]?.pending?.requestId;
    assert.ok(nextRequestId);
    const controlled = await connections.confirmControl("local", nextRequestId!);
    assert.equal(controlled.hosts[0]?.state, "control");
    assert.equal(shouldShowHostChrome(controlled), false);
    assert.equal(findHostPrompt(controlled), undefined);

    const disconnected = await connections.disconnect("local");
    assert.equal(disconnected.hosts[0]?.state, "disconnected");
    assert.equal(findHostPrompt(disconnected)?.kind, "unavailable");
  } finally {
    connections.dispose();
    first.dispose();
    await server.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

await test("Desktop guides installation without starting a missing Host", async () => {
  let installGuides = 0;
  const connections = new DesktopHostConnections({
    controllerSessionId: "desktop-missing",
    initialInstallation: "missing",
    initialError: "本机尚未安装 SeaShard Host",
    connectLocal: async () => {
      throw new Error("Host must remain stopped");
    },
    readLocalInstallation: async () => "missing",
    installLocal: async () => {
      installGuides += 1;
    },
  });
  try {
    const missing = connections.getSnapshot();
    assert.equal(missing.hosts[0]?.installation, "missing");
    assert.equal(findHostPrompt(missing)?.kind, "missing");

    const guided = await connections.install("local");
    assert.equal(installGuides, 1);
    assert.equal(findHostPrompt(guided), undefined);
  } finally {
    connections.dispose();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Host control state did not converge");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
