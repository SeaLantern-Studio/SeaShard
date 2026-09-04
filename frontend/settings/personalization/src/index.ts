import type { PluginManifest } from "@seashard/plugin-sdk";
import { uiAppearanceContract } from "@seashard/ui-sdk";

export const personalizationUiManifest: PluginManifest = {
  id: "seashard.personalization-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "personalization.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      permissions: [uiAppearanceContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
