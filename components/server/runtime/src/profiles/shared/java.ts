import type { JavaInstallationSnapshot } from "@seashard/contracts";
import type { JavaVersionRequirement } from "../types";

export function minimumJava(major: number, description: string): JavaVersionRequirement {
  return { major, exact: false, description };
}

export function exactJava(major: number, description: string): JavaVersionRequirement {
  return { major, exact: true, description };
}
/** 用于 Bukkit 等同时具有最低与最高 Java 主版本边界的精确制品。 */
export function boundedJava(
  minimumMajor: number,
  maximumMajor: number,
  description: string,
): JavaVersionRequirement {
  return { major: minimumMajor, maximumMajor, exact: false, description };
}

/** 根据显式运行策略选择 Java；NeoForge 26.1 等核心可要求精确主版本。 */
export function selectJavaInstallation(
  installations: readonly JavaInstallationSnapshot[],
  requirement: JavaVersionRequirement,
): JavaInstallationSnapshot {
  const compatible = installations
    .filter((installation) => {
      if (installation.disabled) return false;
      if (requirement.exact) return installation.majorVersion === requirement.major;
      return (
        installation.majorVersion >= requirement.major &&
        (requirement.maximumMajor === undefined ||
          installation.majorVersion <= requirement.maximumMajor)
      );
    })
    .sort(
      (left, right) =>
        left.majorVersion - right.majorVersion ||
        Number(right.is64Bit) - Number(left.is64Bit) ||
        left.path.localeCompare(right.path),
    );
  const selected = compatible[0];
  if (!selected) {
    const requiredVersion = requirement.exact
      ? `Java ${requirement.major}`
      : requirement.maximumMajor === undefined
        ? `Java ${requirement.major} 或更高版本`
        : `Java ${requirement.major} 至 ${requirement.maximumMajor}`;
    throw new Error(
      `未检测到已启用的 ${requiredVersion}。${requirement.description} ${
        requirement.exact ? "必须使用" : "需要"
      } ${requiredVersion}，请先启用、安装或添加对应的 Java 后重试。`,
    );
  }
  return selected;
}

/** Vanilla、Paper 系核心按明确的 Minecraft 版本元数据选择 Java。 */
export function requiredJavaMajor(gameVersion: string | undefined): number {
  if (/^26\.\d+(?:\.\d+)?(?:[-+].*)?$/u.test(gameVersion ?? "")) return 25;
  const match = gameVersion?.match(/^1\.(\d+)(?:\.(\d+))?/u);
  if (!match) throw new Error("server instance is missing a valid Minecraft version");
  const minor = Number(match[1]);
  const patch = Number(match[2] ?? 0);
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}
