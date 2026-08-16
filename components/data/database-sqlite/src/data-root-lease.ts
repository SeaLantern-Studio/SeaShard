import { createHash } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";

export class DataRootLease {
  private released = false;

  private constructor(
    readonly dataRoot: string,
    readonly address: string,
    private readonly server: Server,
    private readonly removeSocket: boolean,
  ) {}

  static async acquire(dataRoot: string): Promise<DataRootLease> {
    await mkdir(dataRoot, { recursive: true });
    const canonicalRoot = await realpath(dataRoot);
    const address = leaseAddress(canonicalRoot);
    const server = createServer((socket) => socket.destroy());
    try {
      await listen(server, address);
    } catch (error) {
      if (!isAddressInUse(error) || process.platform === "win32") {
        server.close();
        throw leaseError(canonicalRoot, error);
      }
      if (await isLiveSocket(address)) {
        server.close();
        throw leaseError(canonicalRoot, error);
      }
      await rm(address, { force: true });
      try {
        await listen(server, address);
      } catch (retryError) {
        server.close();
        throw leaseError(canonicalRoot, retryError);
      }
    }
    return new DataRootLease(canonicalRoot, address, server, process.platform !== "win32");
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    if (this.removeSocket) await rm(this.address, { force: true });
  }
}

function leaseAddress(dataRoot: string): string {
  if (process.platform !== "win32") return join(dataRoot, ".seashard-data-root.sock");
  const digest = createHash("sha256").update(dataRoot.toLowerCase()).digest("hex").slice(0, 32);
  return `\\\\.\\pipe\\seashard-data-${digest}`;
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address);
  });
}

function isLiveSocket(address: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (isConnectionRefused(error) || isMissing(error)) {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });
}

function isAddressInUse(error: unknown): boolean {
  return hasCode(error, "EADDRINUSE");
}

function isConnectionRefused(error: unknown): boolean {
  return hasCode(error, "ECONNREFUSED");
}

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function leaseError(dataRoot: string, cause: unknown): Error {
  return new Error(`SeaShard data root is already in use: ${dataRoot}`, { cause });
}
