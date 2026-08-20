import type { ServerSettingsSnapshot } from "@seashard/contracts";
import { resolve } from "node:path";
import { readOptionalText, type ServerRuntimeFileSystem } from "./filesystem";
import type { ServerLaunchPlan } from "./profiles";

export async function prepareRuntimeFiles(
  fileSystem: ServerRuntimeFileSystem,
  plan: ServerLaunchPlan,
  settings: ServerSettingsSnapshot,
): Promise<void> {
  for (const path of plan.requiredRuntimeFiles) await fileSystem.access(path);

  if (plan.jvmArgumentFile) {
    const current = await readOptionalText(fileSystem, plan.jvmArgumentFile.path);
    await fileSystem.writeTextFile(
      plan.jvmArgumentFile.path,
      updateManagedJvmArgumentFile(current ?? "", plan.jvmArgumentFile.managedArguments),
    );
  }
  if (plan.eula === "minecraft" && settings.autoAcceptEula) {
    const eulaPath = resolve(plan.workingDirectory, "eula.txt");
    const current = await readOptionalText(fileSystem, eulaPath);
    await fileSystem.writeTextFile(eulaPath, upsertProperty(current ?? "", "eula", "true"));
  }
  if (plan.writesServerProperties) {
    const propertiesPath = resolve(plan.workingDirectory, "server.properties");
    if ((await readOptionalText(fileSystem, propertiesPath)) === undefined) {
      await fileSystem.writeTextFile(propertiesPath, `server-port=${settings.defaultServerPort}\n`);
    }
  }
}

function upsertProperty(content: string, key: string, value: string): string {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const propertyPattern = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*=`,
    "u",
  );
  const updatedLines: string[] = [];
  let propertyWritten = false;
  for (const line of lines) {
    if (!propertyPattern.test(line)) {
      updatedLines.push(line);
      continue;
    }
    if (!propertyWritten) updatedLines.push(`${key}=${value}`);
    propertyWritten = true;
  }
  if (!propertyWritten) updatedLines.push(`${key}=${value}`);
  return `${updatedLines.join("\n")}\n`;
}

const managedJvmArgumentsBegin = "# >>> SeaShard managed JVM arguments";
const managedJvmArgumentsEnd = "# <<< SeaShard managed JVM arguments";

/** 保留安装器和用户注释，只接管活动的堆参数及 SeaShard 自己的参数块。 */
function updateManagedJvmArgumentFile(
  content: string,
  managedArguments: readonly string[],
): string {
  const sourceLines = content.replaceAll("\r\n", "\n").split("\n");
  const retained: string[] = [];
  let insideManagedBlock = false;
  for (const line of sourceLines) {
    if (line.trim() === managedJvmArgumentsBegin) {
      insideManagedBlock = true;
      continue;
    }
    if (line.trim() === managedJvmArgumentsEnd) {
      insideManagedBlock = false;
      continue;
    }
    if (insideManagedBlock || /^\s*-Xm[sx]\S*\s*$/iu.test(line)) continue;
    retained.push(line);
  }
  while (retained.at(-1) === "") retained.pop();
  if (retained.length > 0) retained.push("");
  retained.push(
    managedJvmArgumentsBegin,
    ...managedArguments.map(encodeJvmArgumentFileEntry),
    managedJvmArgumentsEnd,
  );
  return `${retained.join("\n")}\n`;
}

function encodeJvmArgumentFileEntry(argument: string): string {
  return /\s|"/u.test(argument)
    ? `"${argument.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : argument;
}
