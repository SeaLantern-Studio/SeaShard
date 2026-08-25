import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runHostOperation } from "../host-control";
import { validatePluginDirectory } from "../plugin-project";

export async function installPlugin(source: string): Promise<void> {
  const sourcePath = resolve(source);
  const sourceStatus = await stat(sourcePath);
  const sourceKind = sourceStatus.isDirectory() ? "directory" : "archive";
  if (sourceKind === "directory") await validatePluginDirectory(sourcePath);
  const result = await runHostOperation("install", {
    sourcePath,
    source: sourceKind,
  });
  console.log(`Installed and enabled ${result.pluginId}@${result.version}`);
  console.log(`Source: ${result.source}`);
  console.log(`Digest: ${result.digest}`);
}
