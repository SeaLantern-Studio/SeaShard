import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface ServerControllerPaths {
  readonly userDataRoot: string;
  readonly sharedControllerDataRoot: string;
  readonly hostDataRoot: string;
  readonly controllerDataRoot: string;
  readonly logFile: string;
}

interface ResolveServerControllerPathsOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly userDataRoot?: string;
  readonly sharedControllerDataRoot?: string;
  readonly controllerDataRoot?: string;
  readonly hostDataRoot?: string;
}

/**
 * 普通领域数据以 SeaShard 用户目录为共同根；Server 目录只保留 Web 身份、服务租约、
 * 日志和更新暂存等 Controller 实例专有状态。
 */
export function resolveServerControllerPaths(
  options: ResolveServerControllerPathsOptions = {},
): ServerControllerPaths {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const path = platform === "win32" ? win32 : posix;
  const userDataRoot = path.resolve(
    options.userDataRoot ??
      environment.SEASHARD_SHARED_DATA_DIR ??
      resolveSeaShardUserDataRoot(environment, platform, homeDirectory),
  );
  const hostDataRoot = path.resolve(
    options.hostDataRoot ??
      environment.SEASHARD_HOST_DATA_DIR ??
      environment.SEASHARD_DATA_DIR ??
      path.join(userDataRoot, "core"),
  );
  const sharedControllerDataRoot = path.resolve(
    options.sharedControllerDataRoot ??
      environment.SEASHARD_CONTROLLER_DATA_DIR ??
      (environment.SEASHARD_DATA_DIR
        ? path.join(environment.SEASHARD_DATA_DIR, "controller")
        : path.join(userDataRoot, "controller")),
  );
  const controllerDataRoot = path.resolve(
    options.controllerDataRoot ??
      environment.SEASHARD_SERVER_DATA_DIR ??
      path.join(userDataRoot, "server-controller"),
  );
  return {
    userDataRoot,
    sharedControllerDataRoot,
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
