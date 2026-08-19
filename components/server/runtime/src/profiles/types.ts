import type { ServerInstanceSnapshot, ServerRuntimeSupportedType } from "@seashard/contracts";

export interface JavaVersionRequirement {
  readonly major: number;
  readonly exact: boolean;
  readonly description: string;
}

export interface FileHashManifestPlan {
  readonly path: string;
  readonly algorithm: "md5";
  readonly targets: readonly string[];
}

export interface ServerPreparationPlan {
  readonly description: string;
  readonly workingDirectory: string;
  readonly arguments: readonly string[];
  readonly sentinels: readonly string[];
  readonly closeStdin: boolean;
  /** Mohist 首次引导会在未接受 EULA 时以非零码退出；哨兵齐全即可继续正式启动。 */
  readonly acceptNonZeroWithSentinels: boolean;
  /** NeoForge 的主要依赖路径由安装器写进平台参数文件，需逐项确认。 */
  readonly classPathArgumentFile?: string;
  /** Mohist 用 installInfo 中的 MD5 校验原始胖 JAR 与生成的 Forge server。 */
  readonly hashManifest?: FileHashManifestPlan;
}

export interface JvmArgumentFilePlan {
  readonly path: string;
  readonly managedArguments: readonly string[];
}

export interface ServerLaunchPlan {
  readonly serverType: ServerRuntimeSupportedType;
  readonly displayName: string;
  readonly java: JavaVersionRequirement;
  readonly preparation?: ServerPreparationPlan;
  readonly workingDirectory: string;
  readonly requiredRuntimeFiles: readonly string[];
  readonly arguments: readonly string[];
  readonly jvmArgumentFile?: JvmArgumentFilePlan;
  readonly eula: "minecraft" | "none";
  readonly writesServerProperties: boolean;
  readonly stopCommand: string;
}

/** 各核心实现只接收已校验的实例和公共 JVM 参数，不读取其他组件状态。 */
export interface ServerProfileContext {
  readonly instance: ServerInstanceSnapshot;
  readonly managedJvmArguments: readonly string[];
  readonly platform: NodeJS.Platform;
}

export type ServerProfileBuilder = (context: ServerProfileContext) => ServerLaunchPlan;
