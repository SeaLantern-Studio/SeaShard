import { runtimeDiagnosticsContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const runtimeDiagnosticsUiManifest: PluginManifest = {
  id: "seashard.runtime-diagnostics-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "runtime-diagnostics.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop"],
      activationScopes: ["global"],
      permissions: [runtimeDiagnosticsContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
