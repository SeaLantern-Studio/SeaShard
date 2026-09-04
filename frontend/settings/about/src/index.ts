import type { PluginManifest } from "@seashard/plugin-sdk";
export { aboutUiServiceContract, type AboutUiService } from "./service";

export const aboutUiManifest: PluginManifest = {
  id: "seashard.about-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "about.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      permissions: [],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
