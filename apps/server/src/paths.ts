import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface ServerControllerPaths {
  readonly userDataRoot: string;
  readonly hostDataRoot: string;
  readonly controllerDataRoot: string;
  readonly logFile: string;
}

interface ResolveServerControllerPathsOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly controllerDataRoot?: string;
  readonly hostDataRoot?: string;
}

/**
 * Server 与 Desktop 运行在同一用户下时必须解析到相同的 SeaShard 用户目录，才能发现
 * Desktop 已经安装的本机 Host。Server 自己的数据放在独立子目录，避免碰触 Desktop 的
 * Controller 数据和页面状态。
 */
export function resolveServerControllerPaths(
  options: ResolveServerControllerPathsOptions = {},
): ServerControllerPaths {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const path = platform === "win32" ? win32 : posix;
  const userDataRoot = resolveSeaShardUserDataRoot(environment, platform, homeDirectory);
  const hostDataRoot = path.resolve(
    options.hostDataRoot ??
      environment.SEASHARD_HOST_DATA_DIR ??
      environment.SEASHARD_DATA_DIR ??
      path.join(userDataRoot, "core"),
  );
  const controllerDataRoot = path.resolve(
    options.controllerDataRoot ??
      environment.SEASHARD_SERVER_DATA_DIR ??
      path.join(userDataRoot, "server-controller"),
  );
  return {
    userDataRoot,
    hostDataRoot,
    controllerDataRoot,
    logFile: path.join(controllerDataRoot, "server-controller.log"),
  };
}

function resolveSeaShardUserDataRoot(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
): string {
  const path = platform === "win32" ? win32 : posix;
  if (platform === "win32") {
    return path.join(
      environment.APPDATA ?? path.join(homeDirectory, "AppData", "Roaming"),
      "SeaShard",
    );
  }
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "SeaShard");
  }
  return path.join(environment.XDG_CONFIG_HOME ?? path.join(homeDirectory, ".config"), "SeaShard");
}
