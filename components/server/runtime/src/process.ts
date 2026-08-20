import type { JavaInstallationSnapshot } from "@seashard/contracts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, dirname } from "node:path";

const managedJavaToolOptions = [
  "-Dfile.encoding=UTF-8",
  "-Dsun.stdout.encoding=UTF-8",
  "-Dsun.stderr.encoding=UTF-8",
].join(" ");

export type SpawnServerProcess = (
  command: string,
  arguments_: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
  },
) => ChildProcessWithoutNullStreams;

export const defaultSpawnServerProcess: SpawnServerProcess = (command, arguments_, spawnOptions) =>
  spawn(command, [...arguments_], {
    ...spawnOptions,
    stdio: "pipe",
  });

export function createJavaEnvironment(java: JavaInstallationSnapshot): NodeJS.ProcessEnv {
  const javaBin = dirname(java.path);
  const path = process.env.PATH;
  const existingJavaToolOptions = process.env.JAVA_TOOL_OPTIONS?.trim();
  return {
    ...process.env,
    JAVA_HOME: java.javaHome,
    JAVA_TOOL_OPTIONS: existingJavaToolOptions
      ? `${existingJavaToolOptions} ${managedJavaToolOptions}`
      : managedJavaToolOptions,
    PATH: path ? `${javaBin}${delimiter}${path}` : javaBin,
  };
}

export function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const handleSpawn = (): void => {
      child.off("error", handleError);
      resolveSpawn();
    };
    const handleError = (error: Error): void => {
      child.off("spawn", handleSpawn);
      rejectSpawn(error);
    };
    child.once("spawn", handleSpawn);
    child.once("error", handleError);
  });
}
