import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const schemaVersion = 1;
const lockStaleMilliseconds = 10_000;
const ownerPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;

export type HostInstallationPackageType = "appimage" | "deb" | "nsis" | "pkg";

export interface HostInstallationRecord {
  readonly schemaVersion: typeof schemaVersion;
  readonly kind: "standalone" | "bundled";
  /** 旧版记录没有该字段；新 Host 启动时会按真实制品补齐。 */
  readonly packageType?: HostInstallationPackageType;
  readonly owners: readonly string[];
}

export interface ReleasedBundledHostOwner {
  readonly installation: HostInstallationRecord;
  /** 最后一个捆绑产品卸载后，安装器应停止并移除 Host。 */
  readonly removeHost: boolean;
}

export async function readHostInstallation(
  dataRoot: string,
): Promise<HostInstallationRecord | undefined> {
  const marked = await readMarkedInstallation(dataRoot);
  if (marked) return marked;

  let source: string;
  try {
    source = await readFile(installationPath(dataRoot), "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  return parseInstallation(JSON.parse(source) as unknown);
}

/** 独立安装拥有最高所有权；后续 Desktop 或 Server 复用时不能将其降级为捆绑安装。 */
export function registerStandaloneHost(
  dataRoot: string,
  packageType?: HostInstallationPackageType,
): Promise<HostInstallationRecord> {
  return mutateInstallation(dataRoot, (current) => ({
    schemaVersion,
    kind: "standalone",
    owners: [],
    ...((packageType ?? current?.packageType)
      ? { packageType: packageType ?? current?.packageType }
      : {}),
  }));
}

/** 产品只登记自己的捆绑所有权；检测到独立 Host 时保持原记录不变。 */
export function registerBundledHostOwner(
  dataRoot: string,
  owner: string,
): Promise<HostInstallationRecord> {
  requireOwner(owner);
  return mutateInstallation(dataRoot, (current) => {
    if (current?.kind === "standalone") return current;
    return {
      schemaVersion,
      kind: "bundled",
      owners: [...new Set([...(current?.owners ?? []), owner])].sort(),
      ...(current?.packageType ? { packageType: current.packageType } : {}),
    };
  });
}

/**
 * 卸载器只释放自己的所有权。返回 removeHost=true 时已经没有其他整体产品依赖该 Host；
 * 独立安装始终返回 false。
 */
export function releaseBundledHostOwner(
  dataRoot: string,
  owner: string,
): Promise<ReleasedBundledHostOwner> {
  requireOwner(owner);
  return withInstallationLock(dataRoot, async () => {
    const current = await readHostInstallation(dataRoot);
    if (!current) throw new Error(`SeaShard Host installation is not registered: ${dataRoot}`);
    if (current.kind === "standalone") return { installation: current, removeHost: false };
    const installation: HostInstallationRecord = {
      ...current,
      owners: current.owners.filter((candidate) => candidate !== owner),
    };
    await writeInstallation(dataRoot, installation);
    return { installation, removeHost: installation.owners.length === 0 };
  });
}

function mutateInstallation(
  dataRoot: string,
  mutate: (current: HostInstallationRecord | undefined) => HostInstallationRecord,
): Promise<HostInstallationRecord> {
  return withInstallationLock(dataRoot, async () => {
    const next = mutate(await readHostInstallation(dataRoot));
    await writeInstallation(dataRoot, next);
    return next;
  });
}

async function withInstallationLock<T>(dataRoot: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dataRoot, { recursive: true });
  const lockPath = join(dataRoot, ".host-installation.lock");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const metadata = await stat(lockPath).catch(() => undefined);
      if (metadata && Date.now() - metadata.mtimeMs > lockStaleMilliseconds) {
        await rm(lockPath, { force: true });
        continue;
      }
      await delay(25);
    }
  }
  if (!handle) throw new Error(`SeaShard Host installation state is busy: ${dataRoot}`);
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function writeInstallation(
  dataRoot: string,
  installation: HostInstallationRecord,
): Promise<void> {
  await writeInstallationMarkers(dataRoot, installation);
  const target = installationPath(dataRoot);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(installation, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rm(target, { force: true });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function installationPath(dataRoot: string): string {
  return join(dataRoot, "host-installation.json");
}

async function readMarkedInstallation(
  dataRoot: string,
): Promise<HostInstallationRecord | undefined> {
  const root = installationMarkerRoot(dataRoot);
  const [standalone, bundled] = await Promise.all([
    pathExists(join(root, "standalone")),
    pathExists(join(root, "bundled")),
  ]);
  if (standalone && bundled) {
    throw new Error(`SeaShard Host installation markers conflict: ${root}`);
  }
  if (!standalone && !bundled) return undefined;

  const ownerRoot = join(root, "owners");
  const ownerEntries = await readdir(ownerRoot, { withFileTypes: true }).catch((error) => {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  });
  const owners = ownerEntries
    .filter((entry) => entry.isFile())
    .map(({ name }) => {
      requireOwner(name);
      return name;
    })
    .sort();
  if (standalone && owners.length > 0) {
    throw new TypeError("Standalone Host installation cannot have bundled owners");
  }

  const packageTypeEntries = await readdir(join(root, "package-types"), {
    withFileTypes: true,
  }).catch((error) => {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  });
  const packageTypes = packageTypeEntries
    .filter((entry) => entry.isFile())
    .map(({ name }) => requirePackageType(name));
  if (packageTypes.length > 1) {
    throw new TypeError(`SeaShard Host package type markers conflict: ${root}`);
  }
  return {
    schemaVersion,
    kind: standalone ? "standalone" : "bundled",
    owners,
    ...(packageTypes[0] ? { packageType: packageTypes[0] } : {}),
  };
}

async function writeInstallationMarkers(
  dataRoot: string,
  installation: HostInstallationRecord,
): Promise<void> {
  const root = installationMarkerRoot(dataRoot);
  const ownerRoot = join(root, "owners");
  const packageTypeRoot = join(root, "package-types");
  await rm(root, { recursive: true, force: true });
  await Promise.all([
    mkdir(ownerRoot, { recursive: true }),
    mkdir(packageTypeRoot, { recursive: true }),
  ]);
  await writeFile(join(root, installation.kind), "", { mode: 0o600 });
  for (const owner of installation.owners) {
    requireOwner(owner);
    await writeFile(join(ownerRoot, owner), "", { mode: 0o600 });
  }
  if (installation.packageType) {
    await writeFile(join(packageTypeRoot, installation.packageType), "", { mode: 0o600 });
  }
}

function installationMarkerRoot(dataRoot: string): string {
  return join(dataRoot, "host-installation");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function parseInstallation(value: unknown): HostInstallationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("SeaShard Host installation record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== schemaVersion ||
    (record.kind !== "standalone" && record.kind !== "bundled") ||
    !Array.isArray(record.owners)
  ) {
    throw new TypeError("SeaShard Host installation record is invalid");
  }
  const owners = record.owners.map((owner) => {
    if (typeof owner !== "string") throw new TypeError("Host installation owner must be a string");
    requireOwner(owner);
    return owner;
  });
  if (record.kind === "standalone" && owners.length > 0) {
    throw new TypeError("Standalone Host installation cannot have bundled owners");
  }
  const packageType =
    record.packageType === undefined ? undefined : requirePackageType(record.packageType);
  return {
    schemaVersion,
    kind: record.kind,
    owners: [...new Set(owners)].sort(),
    ...(packageType ? { packageType } : {}),
  };
}

function requireOwner(owner: string): void {
  if (!ownerPattern.test(owner)) throw new TypeError(`invalid Host installation owner: ${owner}`);
}

function requirePackageType(value: unknown): HostInstallationPackageType {
  if (value === "appimage" || value === "deb" || value === "nsis" || value === "pkg") return value;
  throw new TypeError(`invalid Host installation package type: ${String(value)}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
