import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverWebDashboardUiManifest: PluginManifest = {
  id: "seashard.server-web-dashboard-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-web-dashboard.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["web"],
      activationScopes: ["global"],
      permissions: [],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
