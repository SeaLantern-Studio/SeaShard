import {
  AgentCredentialVault,
  agentRuntimeManifest,
  createAesAgentCredentialCipher,
  createAgentRuntimeModule,
  legacyAgentCredentialsFileName,
} from "@seashard/agent-runtime";
import type { PluginKernel } from "@seashard/plugin-system";
import { access, unlink } from "node:fs/promises";
import { join } from "node:path";

interface RegisterServerAgentFeaturesOptions {
  readonly kernel: PluginKernel;
  readonly sharedDataRoot: string;
  readonly legacyCredentialDataRoot: string;
}

/**
 * Server 与 Desktop 使用同一 Agent 数据目录和 AES Vault；Server 旧版专有 Vault
 * 仅在首次启动时解密合并，迁移成功后移除旧凭据与旧主密钥。
 */
export async function registerServerAgentFeatures(
  options: RegisterServerAgentFeaturesOptions,
): Promise<void> {
  const cipher = await createAesAgentCredentialCipher(options.sharedDataRoot);
  const credentialVault = new AgentCredentialVault({
    userDataRoot: options.sharedDataRoot,
    cipher,
    reportError: (error) => console.error("Server Agent credential vault failed", error),
  });
  await credentialVault.initialize();
  try {
    await migrateServerAgentCredentials(credentialVault, options.legacyCredentialDataRoot);
  } finally {
    await credentialVault.dispose();
  }
  await options.kernel.registerBuiltIn({
    manifest: agentRuntimeManifest,
    loaders: {
      "agent-runtime.host": {
        load: async () =>
          createAgentRuntimeModule({
            userDataRoot: options.sharedDataRoot,
            providerTypeSource: options.kernel.agentProviderTypes,
            credentialSource: new AgentCredentialVault({
              userDataRoot: options.sharedDataRoot,
              cipher,
              reportError: (error) => console.error("Server Agent credential vault failed", error),
            }),
            toolSource: options.kernel.agentTools,
            resourceSource: options.kernel.agentResources,
            reportError: (error) => console.error("Server Agent Runtime failed", error),
          }),
      },
    },
    bindings: [
      {
        id: "core.agent-runtime",
        entryId: "agent-runtime.host",
        scopeType: "global",
        scopeId: "global",
        enabled: true,
        config: null,
      },
    ],
  });
}

async function migrateServerAgentCredentials(
  target: AgentCredentialVault,
  legacyDataRoot: string,
): Promise<void> {
  const legacyCredentialPath = join(legacyDataRoot, "agent", legacyAgentCredentialsFileName);
  try {
    await access(legacyCredentialPath);
  } catch (error) {
    if (hasFileSystemCode(error, "ENOENT")) return;
    throw error;
  }
  const legacyCipher = await createAesAgentCredentialCipher(legacyDataRoot);
  await target.migrateLegacyCredentials({
    userDataRoot: legacyDataRoot,
    cipher: legacyCipher,
  });
  await unlink(join(legacyDataRoot, "agent", "credentials.key")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
}

function hasFileSystemCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
