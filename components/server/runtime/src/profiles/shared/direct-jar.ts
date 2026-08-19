import type { ServerRuntimeSupportedType } from "@seashard/contracts";
import { resolve } from "node:path";
import type { ServerLaunchPlan, ServerProfileContext } from "../types";
import { minimumJava } from "./java";
import { argumentPath } from "./paths";

export interface DirectJarOptions {
  readonly serverType: ServerRuntimeSupportedType;
  readonly displayName: string;
  readonly javaMajor: number;
  readonly programArguments: readonly string[];
  readonly eula: "minecraft" | "none";
  readonly writesServerProperties: boolean;
  readonly stopCommand?: string;
}

/** 直接 JAR 与自引导 JAR 共享相同的 Java、工作目录和停止控制骨架。 */
export function buildDirectJarPlan(
  context: ServerProfileContext,
  options: DirectJarOptions,
): ServerLaunchPlan {
  const { instance, managedJvmArguments } = context;
  const jarArgument = argumentPath(instance.rootPath, instance.coreJarPath);
  return {
    serverType: options.serverType,
    displayName: options.displayName,
    java: minimumJava(options.javaMajor, options.displayName),
    workingDirectory: resolve(instance.rootPath),
    requiredRuntimeFiles: [resolve(instance.coreJarPath)],
    arguments: [...managedJvmArguments, "-jar", jarArgument, ...options.programArguments],
    eula: options.eula,
    writesServerProperties: options.writesServerProperties,
    stopCommand: options.stopCommand ?? "stop",
  };
}
