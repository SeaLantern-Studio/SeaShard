import type { ServerRuntimeSupportedType } from "@seashard/contracts";
import { resolve } from "node:path";
import type { ServerLaunchPlan, ServerProfileContext } from "../types";
import { boundedJava, minimumJava } from "./java";
import { argumentPath } from "./paths";

export interface DirectJarOptions {
  readonly serverType: ServerRuntimeSupportedType;
  readonly displayName: string;
  readonly javaMajor: number;
  readonly maximumJavaMajor?: number;
  readonly jvmArguments?: readonly string[];
  readonly programArguments: readonly string[];
  readonly eula: "minecraft" | "interactive-minecraft" | "none";
  readonly writesServerProperties: boolean;
  readonly stopCommand?: string;
  readonly forbiddenWorkingDirectoryCharacters?: readonly string[];
}

/** 直接 JAR 与自引导 JAR 共享相同的 Java、工作目录和停止控制骨架。 */
export function buildDirectJarPlan(
  context: ServerProfileContext,
  options: DirectJarOptions,
): ServerLaunchPlan {
  const { instance, managedJvmArguments } = context;
  for (const character of options.forbiddenWorkingDirectoryCharacters ?? []) {
    if (instance.rootPath.includes(character)) {
      throw new Error(
        `${options.displayName} cannot run from a working directory containing "${character}"`,
      );
    }
  }

  const jarArgument = argumentPath(instance.rootPath, instance.coreJarPath);
  const java =
    options.maximumJavaMajor === undefined
      ? minimumJava(options.javaMajor, options.displayName)
      : boundedJava(options.javaMajor, options.maximumJavaMajor, options.displayName);
  return {
    serverType: options.serverType,
    displayName: options.displayName,
    java,
    workingDirectory: resolve(instance.rootPath),
    requiredRuntimeFiles: [resolve(instance.coreJarPath)],
    arguments: [
      ...managedJvmArguments,
      ...(options.jvmArguments ?? []),
      "-jar",
      jarArgument,
      ...options.programArguments,
    ],
    eula: options.eula,
    writesServerProperties: options.writesServerProperties,
    stopCommand: options.stopCommand ?? "stop",
  };
}
