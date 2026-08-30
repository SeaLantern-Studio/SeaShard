import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceRouteHistory,
  rememberWorkspaceRoute,
  resolveWorkspaceRoute,
  workspaceForPath,
} from "../apps/desktop/src/renderer/workspace-layout.ts";

await test("workspace route history preserves the last complete Agent and Server locations", () => {
  const history = createWorkspaceRouteHistory();
  assert.deepEqual(history, {
    agent: "/agent/chat",
    server: "/server/launch",
    launcher: "/",
  });

  assert.equal(
    rememberWorkspaceRoute(
      history,
      "/server/configuration",
      "/server/configuration?file=server.properties#editor",
    ),
    "server",
  );
  assert.equal(rememberWorkspaceRoute(history, "/agent/chat", "/agent/chat#active"), "agent");
  assert.equal(rememberWorkspaceRoute(history, "/settings/about", "/settings/about"), undefined);

  assert.equal(history.server, "/server/configuration?file=server.properties#editor");
  assert.equal(history.agent, "/agent/chat#active");
  assert.equal(workspaceForPath("/serverish/page"), undefined);
  assert.equal(workspaceForPath("/agent/settings/model"), "agent");
});

await test("workspace route history falls back when a retained Client Entry route disappears", () => {
  const history = createWorkspaceRouteHistory();
  history.server = "/server/plugin-page?tab=runtime#details";
  history.agent = "/agent/plugin-page";
  const available = new Set(["/server/launch", "/agent/chat"]);

  assert.equal(
    resolveWorkspaceRoute(history, "server", (path) => available.has(path)),
    "/server/launch",
  );
  assert.equal(history.server, "/server/launch");
  assert.equal(
    resolveWorkspaceRoute(history, "agent", (path) => available.has(path)),
    "/agent/chat",
  );
  assert.equal(history.agent, "/agent/chat");

  history.server = "/server/configuration?file=server.properties#editor";
  available.add("/server/configuration");
  assert.equal(
    resolveWorkspaceRoute(history, "server", (path) => available.has(path)),
    "/server/configuration?file=server.properties#editor",
  );
});
