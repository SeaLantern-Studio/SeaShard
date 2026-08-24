import type { PluginManifest, PluginPackageManifest } from "../packages/plugin-sdk/src/index.ts";

export const databaseWorkerEntry = new URL(
  "../apps/database-worker/dist/index.js",
  import.meta.url,
);

export const validManifest: PluginManifest = {
  id: "example.plugin",
  version: "1.0.0",
  publisher: "example-publisher",
  entries: [
    {
      id: "example.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron"],
      activationScopes: ["global"],
      permissions: ["example.echo"],
    },
  ],
  compatibility: { seaShard: ">=0.0.0 <1.0.0" },
};

export const validPluginPackageManifest: PluginPackageManifest = {
  id: "example.plugin",
  version: "1.0.0",
  publisher: "example-publisher",
  entries: [
    {
      id: "example.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron"],
      uses: {
        "example.echo": ["echo"],
      },
    },
  ],
  compatibility: { seaShard: ">=0.0.0 <1.0.0" },
};
