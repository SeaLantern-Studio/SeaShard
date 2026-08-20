import {
  parseServerPropertiesSource,
  renderServerPropertiesSource,
} from "../frontend/server/configuration/src/client/server-properties.ts";
import assert from "node:assert/strict";
import test from "node:test";

await test("server.properties parser classifies known fields and keeps values after the first equals", () => {
  const entries = parseServerPropertiesSource(
    "# generated\nserver-port=25565\nonline-mode=true\nmotd=hello=world\ncustom-flag=false\n",
  );
  assert.deepEqual(
    entries.map(({ key, value, category, valueType }) => ({ key, value, category, valueType })),
    [
      { key: "server-port", value: "25565", category: "network", valueType: "number" },
      { key: "online-mode", value: "true", category: "player", valueType: "boolean" },
      { key: "motd", value: "hello=world", category: "display", valueType: "text" },
      { key: "custom-flag", value: "false", category: "other", valueType: "boolean" },
    ],
  );
});

await test("visual property rendering changes values without rewriting comments, order, delimiters, or CRLF", () => {
  const original = [
    "# Minecraft server properties",
    "motd = Old Server",
    "max-players: 20",
    "unknown line",
    "",
  ].join("\r\n");
  assert.equal(
    renderServerPropertiesSource(original, {
      motd: "SeaShard = Server",
      "max-players": "32",
    }),
    [
      "# Minecraft server properties",
      "motd = SeaShard = Server",
      "max-players: 32",
      "unknown line",
      "",
    ].join("\r\n"),
  );
});

await test("duplicate property definitions remain source-preserving and receive the same visual value", () => {
  assert.equal(
    renderServerPropertiesSource("pvp=true\n# override\npvp=false\n", { pvp: "true" }),
    "pvp=true\n# override\npvp=true\n",
  );
});
