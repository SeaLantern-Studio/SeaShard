import { validatePluginDirectory } from "../plugin-project";

export async function validatePlugin(directory: string): Promise<void> {
  const { root, candidate } = await validatePluginDirectory(directory);
  console.log(`Valid ${candidate.manifest.id}@${candidate.manifest.version}`);
  console.log(`Root: ${root}`);
  console.log(`Digest: ${candidate.digest}`);
  console.log(`Entries: ${candidate.manifest.entries.length}`);
  console.log(`Files: ${candidate.files.length}`);
}
