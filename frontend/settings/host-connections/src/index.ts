import type { PluginManifest } from "@seashard/plugin-sdk";

export const hostConnectionsUiRuntimeId = "core.host-connections.ui";
export const hostConnectionsUiBuiltinKey = "seashard.host-connections-ui/host-connections.client";

export const hostConnectionsUiManifest: PluginManifest = {
  id: "seashard.host-connections-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "host-connections.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop"],
      activationScopes: ["global"],
      permissions: [],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
