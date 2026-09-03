import { serverCoreDownloadContract, serverCoreSourceContract } from "@seashard/contracts";
import type { PluginManifest } from "@seashard/plugin-sdk";

export const serverDownloadServerCoreUiManifest: PluginManifest = {
  id: "seashard.server-download-servercore-ui",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "server-download-servercore.client",
      runtime: "client",
      module: "./dist/client.js",
      targets: ["desktop", "web"],
      activationScopes: ["global"],
      uses: {
        [serverCoreSourceContract]: ["listTypes", "listVersions", "listArtifacts"],
        [serverCoreDownloadContract]: ["startManaged", "listTasks", "saveAs"],
      },
      permissions: [serverCoreSourceContract, serverCoreDownloadContract],
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
    clientProtocol: ">=1 <2",
  },
};
