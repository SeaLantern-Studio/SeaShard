import { buildPluginProject, validatePluginDirectory } from "../plugin-project";

export async function buildPlugin(directory: string): Promise<void> {
  await buildPluginProject(directory);
  const { candidate } = await validatePluginDirectory(directory);
  console.log(
    `Built ${candidate.manifest.id}@${candidate.manifest.version} (${candidate.files.length} files, ${candidate.digest})`,
  );
}
