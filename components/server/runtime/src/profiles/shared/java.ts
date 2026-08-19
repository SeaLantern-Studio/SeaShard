import type { JavaInstallationSnapshot } from "@seashard/contracts";
import type { JavaVersionRequirement } from "../types";

export function minimumJava(major: number, description: string): JavaVersionRequirement {
  return { major, exact: false, description };
}

/** 根据显式运行策略选择 Java；NeoForge 26.1 等核心可要求精确主版本。 */
export function selectJavaInstallation(
  installations: readonly JavaInstallationSnapshot[],
  requirement: JavaVersionRequirement,
): JavaInstallationSnapshot {
  const compatible = installations
    .filter((installation) =>
      requirement.exact
        ? installation.majorVersion === requirement.major
        : installation.majorVersion >= requirement.major,
    )
    .sort(
      (left, right) =>
        left.majorVersion - right.majorVersion ||
        Number(right.is64Bit) - Number(left.is64Bit) ||
        left.path.localeCompare(right.path),
    );
  const selected = compatible[0];
  if (!selected) {
    throw new Error(
      `${requirement.description} requires ${requirement.exact ? "exactly " : ""}Java ${requirement.major}${requirement.exact ? "" : " or newer"}`,
    );
  }
  return selected;
}

/** Vanilla、Paper 系核心按明确的 Minecraft 版本元数据选择 Java。 */
export function requiredJavaMajor(gameVersion: string | undefined): number {
  const match = gameVersion?.match(/^1\.(\d+)(?:\.(\d+))?/u);
  if (!match) throw new Error("server instance is missing a valid Minecraft version");
  const minor = Number(match[1]);
  const patch = Number(match[2] ?? 0);
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}
