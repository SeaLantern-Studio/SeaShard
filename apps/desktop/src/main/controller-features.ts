import {
  AgentCredentialVault,
  type AgentCredentialCipher,
  agentRuntimeManifest,
  createAesAgentCredentialCipher,
  createAgentRuntimeModule,
} from "@seashard/agent-runtime";
import {
  pluginManagementContract,
  pluginManagementUiRuntimeId,
  pluginMarketInstallContract,
  pluginMarketUiRuntimeId,
} from "@seashard/contracts";
import {
  createPluginManagementModule,
  pluginManagementManifest,
} from "@seashard/plugin-management";
import { createPluginMarketModule, pluginMarketManifest } from "@seashard/plugin-market";
import type { PluginKernel } from "@seashard/plugin-system";
import {
  createRuntimeDiagnosticsModule,
  runtimeDiagnosticsManifest,
} from "@seashard/runtime-diagnostics";
import { safeStorage, shell } from "electron";

interface ControllerFeatureOptions {
  readonly kernel: PluginKernel;
  readonly userDataRoot: string;
  readonly legacyCredentialDataRoot: string;
  readonly startedAt: string;
  readonly isStopping: () => boolean;
}

/** 注册 Controller 持有的完整应用 Runtime、插件生命周期和唯一 Agent Runtime。 */
export async function registerControllerFeatures(options: ControllerFeatureOptions): Promise<void> {
  const { kernel, userDataRoot, legacyCredentialDataRoot, startedAt, isStopping } = options;
  const credentialCipher = await createAesAgentCredentialCipher(userDataRoot);
  await migrateDesktopAgentCredentials(userDataRoot, legacyCredentialDataRoot, credentialCipher);

  // 插件启停影响 Controller 的完整 Runtime 图，只允许固定的内置设置页面调用。
  kernel.restrictServiceCalls(
    pluginManagementContract,
    (execution) =>
      execution.actorType === "client" && execution.runtimeId === pluginManagementUiRuntimeId,
  );
  // 第三方代码安装只接受固定市场页面；Agent 使用同模块注册的显式受确认工具。
  kernel.restrictServiceCalls(
    pluginMarketInstallContract,
    (execution) =>
      execution.actorType === "client" && execution.runtimeId === pluginMarketUiRuntimeId,
  );

  await kernel.registerBuiltIn({
    manifest: pluginManagementManifest,
    loaders: {
      "plugin-management.host": {
        load: async () => createPluginManagementModule(kernel),
      },
    },
    bindings: [controllerBinding("core.plugin-management", "plugin-management.host")],
  });
  await kernel.registerBuiltIn({
    manifest: pluginMarketManifest,
    loaders: {
      "plugin-market.host": {
        load: async () =>
          createPluginMarketModule({
            kernel,
            fetchProvider: () => globalThis.fetch,
          }),
      },
    },
    bindings: [controllerBinding("core.plugin-market", "plugin-market.host")],
  });
  await kernel.registerBuiltIn({
    manifest: agentRuntimeManifest,
    loaders: {
      "agent-runtime.host": {
        load: async () =>
          createAgentRuntimeModule({
            userDataRoot,
            providerTypeSource: kernel.agentProviderTypes,
            credentialSource: new AgentCredentialVault({
              userDataRoot,
              cipher: credentialCipher,
              reportError: (error) => console.error("Desktop Agent credential vault failed", error),
            }),
            toolSource: kernel.agentTools,
            resourceSource: kernel.agentResources,
            openModelConfigurationFile: async (path) => {
              const failure = await shell.openPath(path);
              if (failure) throw new Error(`打开 Agent models.yml 失败：${failure}`);
            },
            reportError: (error) => console.error("Controller Agent Runtime failed", error),
          }),
      },
    },
    bindings: [controllerBinding("core.agent-runtime", "agent-runtime.host")],
  });
  await kernel.registerBuiltIn({
    manifest: runtimeDiagnosticsManifest,
    loaders: {
      "runtime-diagnostics.host": {
        load: async () =>
          createRuntimeDiagnosticsModule({
            host: "electron",
            startedAt,
            readControlSnapshot: () => kernel.runtimeSnapshot(),
            isStopping,
          }),
      },
    },
    bindings: [controllerBinding("core.runtime-diagnostics", "runtime-diagnostics.host")],
  });
}

/**
 * 已发布 Desktop 的 credentials.json 使用 safeStorage；短暂打开共享 AES Vault，
 * 合并共享旧位置与早期开发版本的 Desktop 专有位置，成功后由 Vault 移除旧密文文件。
 */
async function migrateDesktopAgentCredentials(
  sharedDataRoot: string,
  legacyCredentialDataRoot: string,
  targetCipher: AgentCredentialCipher,
): Promise<void> {
  const vault = new AgentCredentialVault({
    userDataRoot: sharedDataRoot,
    cipher: targetCipher,
    reportError: (error) => console.error("Desktop Agent credential migration failed", error),
  });
  const legacyCipher: Pick<AgentCredentialCipher, "decrypt"> = {
    decrypt(value) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("当前系统无法解密旧版 Agent 凭据");
      }
      return safeStorage.decryptString(Buffer.from(value));
    },
  };
  await vault.initialize();
  try {
    await vault.migrateLegacyCredentials({
      userDataRoot: sharedDataRoot,
      cipher: legacyCipher,
    });
    await vault.migrateLegacyCredentials({
      userDataRoot: legacyCredentialDataRoot,
      cipher: legacyCipher,
    });
  } finally {
    await vault.dispose();
  }
}

function controllerBinding(id: string, entryId: string) {
  return {
    id,
    entryId,
    scopeType: "global" as const,
    scopeId: "global",
    enabled: true,
    config: null,
  };
}
