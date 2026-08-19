import {
  javaRuntimeManagerContract,
  type JavaInstallationSnapshot,
  type JavaRuntimeManagerService as JavaRuntimeManagerContractService,
} from "@seashard/contracts";
import type { JsonValue, PluginManifest, PluginModule, PluginStorage } from "@seashard/plugin-sdk";
import { JavaRuntimeScanner, type JavaRuntimeScannerOptions } from "./scanner";

const manualJavaPathsStorageKey = "manual-java-paths";

export type JavaRuntimeManagerModuleOptions = JavaRuntimeScannerOptions;
export type JavaRuntimeManagerService = JavaRuntimeManagerContractService;

export const javaRuntimeManagerManifest: PluginManifest = {
  id: "seashard.java-runtime-manager",
  version: "0.0.0",
  publisher: "sealantern-studio",
  entries: [
    {
      id: "java-runtime-manager.host",
      runtime: "host",
      module: "./dist/host.js",
      hostProfiles: ["electron", "node", "docker"],
      activationScopes: ["global"],
      permissions: [],
      upgradeMode: "stop-first",
    },
  ],
  compatibility: {
    seaShard: ">=0.0.0 <1.0.0",
  },
};

/** 创建 Java 运行环境管理组件；自动发现只读取文件系统元数据，不执行未知 java 程序。 */
export function createJavaRuntimeManagerModule(
  options: JavaRuntimeManagerModuleOptions = {},
): PluginModule {
  return {
    provides: [javaRuntimeManagerContract],
    apply(ctx) {
      const scanner = new JavaRuntimeScanner(options);
      const platform = options.platform ?? process.platform;
      let manualPathsTask = loadManualJavaPaths(ctx.storage);
      let writeQueue: Promise<void> = Promise.resolve();

      const rememberManualPath = (executablePath: string): Promise<void> => {
        const task = writeQueue.then(async () => {
          const current = await manualPathsTask;
          const key = storedPathKey(executablePath, platform);
          if (current.some((path) => storedPathKey(path, platform) === key)) return;
          const next = [...current, executablePath];
          await ctx.storage.put(manualJavaPathsStorageKey, {
            version: 1,
            paths: next,
          });
          manualPathsTask = Promise.resolve(next);
        });
        writeQueue = task.then(
          () => undefined,
          () => undefined,
        );
        return task;
      };

      /** 仅忘记已保存的路径；此操作绝不访问、修改或删除 Java 安装目录。 */
      const forgetManualPath = (executablePath: string): Promise<boolean> => {
        const task = writeQueue.then(async () => {
          const current = await manualPathsTask;
          const key = storedPathKey(executablePath, platform);
          const next = current.filter((path) => storedPathKey(path, platform) !== key);
          if (next.length === current.length) return false;
          await ctx.storage.put(manualJavaPathsStorageKey, {
            version: 1,
            paths: next,
          });
          manualPathsTask = Promise.resolve(next);
          return true;
        });
        writeQueue = task.then(
          () => undefined,
          () => undefined,
        );
        return task;
      };

      const readManualInstallations = async (): Promise<readonly JavaInstallationSnapshot[]> => {
        await writeQueue;
        const installations: JavaInstallationSnapshot[] = [];
        for (const executablePath of await manualPathsTask) {
          try {
            installations.push(await scanner.inspect(executablePath));
          } catch (error) {
            options.reportError?.(
              new Error(`Stored Java installation rejected: ${executablePath}`, {
                cause: error,
              }),
            );
          }
        }
        return installations;
      };

      ctx.provide(javaRuntimeManagerContract, {
        scan: async () =>
          asJsonValue(
            mergeJavaInstallations(await scanner.scan(), await readManualInstallations()),
          ),
        inspect: async (executablePath: unknown) => {
          if (typeof executablePath !== "string" || executablePath.length === 0) {
            throw new TypeError("Java executable path must be a non-empty string");
          }
          const installation = await scanner.inspect(executablePath);
          await rememberManualPath(installation.path);
          return asJsonValue(installation);
        },
        remove: async (executablePath: unknown) => {
          if (typeof executablePath !== "string" || executablePath.length === 0) {
            throw new TypeError("Java executable path must be a non-empty string");
          }
          return forgetManualPath(executablePath);
        },
      });
    },
  };
}

async function loadManualJavaPaths(storage: PluginStorage): Promise<readonly string[]> {
  const value = (await storage.get(manualJavaPathsStorageKey))?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const paths = Reflect.get(value, "paths");
  if (!Array.isArray(paths)) return [];
  return paths.filter((path): path is string => typeof path === "string" && path.length > 0);
}

function storedPathKey(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function mergeJavaInstallations(
  automatic: readonly JavaInstallationSnapshot[],
  manuallyAdded: Iterable<JavaInstallationSnapshot>,
): readonly JavaInstallationSnapshot[] {
  const merged = new Map(automatic.map((installation) => [installation.id, installation]));
  for (const installation of manuallyAdded) merged.set(installation.id, installation);
  return [...merged.values()].sort(
    (left, right) =>
      right.majorVersion - left.majorVersion ||
      left.vendor.localeCompare(right.vendor) ||
      left.path.localeCompare(right.path),
  );
}

function asJsonValue(
  value: JavaInstallationSnapshot | readonly JavaInstallationSnapshot[],
): JsonValue {
  return value as unknown as JsonValue;
}

export * from "./scanner";
