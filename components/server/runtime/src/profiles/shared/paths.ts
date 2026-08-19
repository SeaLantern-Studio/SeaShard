import type { ServerInstanceSnapshot } from "@seashard/contracts";
import { isAbsolute, relative, resolve } from "node:path";

export function validateInstancePaths(instance: ServerInstanceSnapshot): void {
  if (!isAbsolute(instance.rootPath) || !isAbsolute(instance.coreJarPath)) {
    throw new Error("server instance paths must be absolute");
  }
  const rootPath = resolve(instance.rootPath);
  const corePath = resolve(instance.coreJarPath);
  const relativeCore = relative(rootPath, corePath);
  if (!relativeCore || isOutside(relativeCore)) {
    throw new Error("server core JAR must stay inside the instance root");
  }
}

export function argumentPath(workingDirectory: string, targetPath: string): string {
  const relativeTarget = relative(resolve(workingDirectory), resolve(targetPath));
  return relativeTarget && !isOutside(relativeTarget) ? relativeTarget : resolve(targetPath);
}

function isOutside(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  );
}
