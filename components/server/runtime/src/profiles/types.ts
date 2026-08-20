import type { ServerInstanceSnapshot, ServerRuntimeSupportedType } from "@seashard/contracts";

export interface JavaVersionRequirement {
  readonly major: number;
  readonly exact: boolean;
  /** 部分精确核心会主动拒绝更高版本 Java；未设置表示无已知硬上限。 */
  readonly maximumMajor?: number;
  readonly description: string;
}

export interface ServerPreparationDownloadPlan {
  readonly url: string;
  readonly path: string;
  /** 固定哈希仅用于确有固定依赖的策略；动态版本优先使用官方校验文件。 */
  readonly sha256?: string;
  readonly sha256Url?: string;
  readonly sha256Path?: string;
}

export interface ServerPreparationCopyPlan {
  readonly source: string;
  readonly target: string;
  /** 未声明时以源文件的实时 SHA-256 校验复制结果。 */
  readonly sha256?: string;
}

export interface ServerPreparationPlan {
  readonly description: string;
  readonly workingDirectory: string;
  readonly arguments: readonly string[];
  readonly sentinels: readonly string[];
  readonly closeStdin: boolean;
  /** Mohist 首次引导会在未接受 EULA 时以非零码退出；哨兵齐全即可继续正式启动。 */
  readonly acceptNonZeroWithSentinels: boolean;
  /** 安装器生成的启动参数文件；至少需引用一个存在的 classpath 或 -jar 目标。 */
  readonly runtimeArgumentFile?: string;
  /** 安装器不在核心目录中时，可按版本派生 URL 并校验固定哈希或官方校验文件。 */
  readonly downloads?: readonly ServerPreparationDownloadPlan[];
  /** 复合核心可把核心产物复制到宿主核心要求的目录。 */
  readonly copies?: readonly ServerPreparationCopyPlan[];
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
  readonly eula: "minecraft" | "interactive-minecraft" | "none";
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
