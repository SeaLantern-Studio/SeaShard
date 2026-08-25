import { packPluginDirectory } from "../plugin-project";

export async function packPlugin(directory: string): Promise<void> {
  const { outputPath, validation } = await packPluginDirectory(directory);
  console.log(
    `Packed ${validation.candidate.manifest.id}@${validation.candidate.manifest.version}`,
  );
  console.log(`Archive: ${outputPath}`);
  console.log(`Digest: ${validation.candidate.digest}`);
}
