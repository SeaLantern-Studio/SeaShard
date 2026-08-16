import {
  dataCapsuleDigest,
  validateDataCapsule,
  type DataCapsule,
  type DataCommandRequest,
  type DatabaseCheckpointResult,
  type DatabaseCommandResult,
  type DatabaseDiagnostics,
  type DatabaseIntegrityResult,
  type DatabaseService,
  type DatabaseValue,
  type RegisteredDataCapsule,
} from "@seashard/database";
import type {
  DatabaseWorkerCommand,
  DatabaseWorkerData,
  DatabaseWorkerRequest,
  DatabaseWorkerResponse,
  DatabaseWorkerResult,
} from "@seashard/database/worker-protocol";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

export interface SQLiteDatabaseBrokerOptions {
  readonly databasePath: string;
  readonly workerEntry: string | URL;
  readonly readWorkers?: number;
}

export class SQLiteDatabaseBroker implements DatabaseService {
  private readonly capsules = new Set<string>();
  private readonly commandAccess = new Map<string, DataCapsule["commands"][number]["access"]>();
  private closed = false;
  private closeTask?: Promise<void>;

  private constructor(
    private readonly writer: QueuedWorker,
    private readonly readers: readonly QueuedWorker[],
    private readonly maintenance: QueuedWorker,
  ) {}

  static async create(options: SQLiteDatabaseBrokerOptions): Promise<SQLiteDatabaseBroker> {
    const writer = new QueuedWorker(
      new WorkerClient(options.workerEntry, {
        role: "writer",
        databasePath: options.databasePath,
      }),
    );
    let readers: QueuedWorker[] = [];
    let maintenance: QueuedWorker | undefined;
    try {
      await writer.request({ type: "ping" });
      const readerCount = normalizeReaderCount(options.readWorkers);
      readers = Array.from(
        { length: readerCount },
        () =>
          new QueuedWorker(
            new WorkerClient(options.workerEntry, {
              role: "reader",
              databasePath: options.databasePath,
            }),
          ),
      );
      maintenance = new QueuedWorker(
        new WorkerClient(options.workerEntry, {
          role: "maintenance",
          databasePath: options.databasePath,
        }),
      );
      await Promise.all([
        maintenance.request({ type: "ping" }),
        ...readers.map((reader) => reader.request({ type: "ping" })),
      ]);
      return new SQLiteDatabaseBroker(writer, readers, maintenance);
    } catch (error) {
      await Promise.allSettled(
        [...readers, ...(maintenance ? [maintenance] : []), writer].map((worker) => worker.close()),
      );
      throw error;
    }
  }

  async registerCapsule(capsule: DataCapsule): Promise<RegisteredDataCapsule> {
    this.assertOpen();
    validateDataCapsule(capsule);
    const digest = dataCapsuleDigest(capsule);
    await this.writer.request({ type: "register", capsule, digest });
    await Promise.all(
      this.readers.map((reader) => reader.request({ type: "register", capsule, digest })),
    );
    this.capsules.add(digest);
    for (const command of capsule.commands) {
      this.commandAccess.set(`${digest}:${command.id}`, command.access);
    }
    return new CapsuleRepository(this, capsule.namespace, digest);
  }

  quickCheck(): Promise<DatabaseIntegrityResult> {
    this.assertOpen();
    return this.maintenance.request({ type: "quick-check" }) as Promise<DatabaseIntegrityResult>;
  }

  checkpoint(): Promise<DatabaseCheckpointResult> {
    this.assertOpen();
    return this.maintenance.request({ type: "checkpoint" }) as Promise<DatabaseCheckpointResult>;
  }

  async backup(destination: string): Promise<void> {
    this.assertOpen();
    await this.maintenance.request({ type: "backup", destination });
  }

  diagnostics(): DatabaseDiagnostics {
    return {
      writerQueueDepth: this.writer.depth,
      readQueueDepth: this.readers.reduce((total, reader) => total + reader.depth, 0),
      readWorkers: this.readers.length,
      registeredCapsules: this.capsules.size,
      closed: this.closed,
    };
  }

  close(): Promise<void> {
    this.closeTask ??= this.closeWorkers();
    return this.closeTask;
  }

  execute(
    namespace: string,
    digest: string,
    command: string,
    parameters: readonly DatabaseValue[],
  ): Promise<DatabaseCommandResult> {
    this.assertOpen();
    const request = { type: "execute", namespace, digest, command, parameters } as const;
    if (this.commandAccess.get(`${digest}:${command}`) !== "read") {
      return this.writer.request(request) as Promise<DatabaseCommandResult>;
    }
    return (leastBusy(this.readers) ?? this.writer).request(
      request,
    ) as Promise<DatabaseCommandResult>;
  }

  transaction(
    namespace: string,
    digest: string,
    requests: readonly DataCommandRequest[],
  ): Promise<readonly DatabaseCommandResult[]> {
    this.assertOpen();
    return this.writer.request({
      type: "transaction",
      namespace,
      digest,
      requests,
    }) as Promise<readonly DatabaseCommandResult[]>;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("database broker is closed");
  }

  private async closeWorkers(): Promise<void> {
    this.closed = true;
    const failures: unknown[] = [];
    for (const worker of [...this.readers, this.maintenance, this.writer]) {
      try {
        await worker.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "database worker shutdown failed");
  }
}

class CapsuleRepository implements RegisteredDataCapsule {
  constructor(
    private readonly broker: SQLiteDatabaseBroker,
    readonly namespace: string,
    readonly digest: string,
  ) {}

  execute(
    command: string,
    parameters: readonly DatabaseValue[] = [],
  ): Promise<DatabaseCommandResult> {
    return this.broker.execute(this.namespace, this.digest, command, parameters);
  }

  transaction(requests: readonly DataCommandRequest[]): Promise<readonly DatabaseCommandResult[]> {
    return this.broker.transaction(this.namespace, this.digest, requests);
  }
}

class QueuedWorker {
  private tail = Promise.resolve();
  private queued = 0;

  constructor(private readonly worker: WorkerClient) {}

  get depth(): number {
    return this.queued;
  }

  request(command: DatabaseWorkerCommand): Promise<DatabaseWorkerResult> {
    this.queued += 1;
    const task = this.tail.then(() => this.worker.request(command));
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task.finally(() => {
      this.queued -= 1;
    });
  }

  async close(): Promise<void> {
    await this.tail;
    await this.worker.close();
  }
}

class WorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    {
      resolve(value: DatabaseWorkerResult): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private counter = 0;
  private stopping = false;
  private exited = false;

  constructor(entry: string | URL, data: DatabaseWorkerData) {
    this.worker = new Worker(entry, { workerData: data });
    this.worker.on("message", (response: DatabaseWorkerResponse) => this.receive(response));
    this.worker.once("error", (error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
    this.worker.once("exit", (code) => {
      this.exited = true;
      if (!this.stopping || code !== 0) {
        this.fail(new Error(`database worker exited with code ${code}`));
      }
    });
  }

  request(command: DatabaseWorkerCommand): Promise<DatabaseWorkerResult> {
    if (this.stopping || this.exited) {
      return Promise.reject(new Error("database worker is not available"));
    }
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`database worker request timed out: ${command.type}`));
        },
        command.type === "backup" ? 120_000 : 30_000,
      );
      this.pending.set(id, { resolve, reject, timer });
      const request: DatabaseWorkerRequest = { type: "request", id, command };
      this.worker.postMessage(request);
    });
  }

  async close(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (!this.exited) {
      const id = ++this.counter;
      try {
        await new Promise<DatabaseWorkerResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error("database worker close timed out"));
          }, 5_000);
          this.pending.set(id, { resolve, reject, timer });
          this.worker.postMessage({
            type: "request",
            id,
            command: { type: "close" },
          } satisfies DatabaseWorkerRequest);
        });
      } finally {
        if (!this.exited) await this.worker.terminate();
      }
    }
  }

  private receive(response: DatabaseWorkerResponse): void {
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.ok) {
      request.resolve(response.value);
    } else {
      request.reject(new Error(response.error));
    }
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function normalizeReaderCount(value: number | undefined): number {
  const count = value ?? Math.min(4, Math.max(1, availableParallelism() - 2));
  if (!Number.isSafeInteger(count) || count < 1 || count > 8) {
    throw new TypeError("SQLite read worker count must be an integer between 1 and 8");
  }
  return count;
}

function leastBusy(workers: readonly QueuedWorker[]): QueuedWorker | undefined {
  return workers.reduce<QueuedWorker | undefined>(
    (selected, worker) => (!selected || worker.depth < selected.depth ? worker : selected),
    undefined,
  );
}
