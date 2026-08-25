import pg from "pg";
import { config, type AppConfig } from "../config.js";
import {
  beginObservedTransaction,
  databaseOutcome,
  databaseQueryClass,
  endObservedTransaction,
  observeDatabaseHistogram,
  observabilityProcess,
  type DatabaseOutcome,
  type ObservabilityProcess
} from "../modules/operations/observability-metrics.js";

export function databaseApplicationName(entrypoint = process.argv[1] ?? ""): string {
  if (/(?:^|[/\\])worker\.[cm]?[jt]s$/i.test(entrypoint)) return "atendon-worker";
  if (/(?:^|[/\\])migrate(?:-test)?\.[cm]?[jt]s$/i.test(entrypoint)) return "atendon-migration";
  return "atendon-api";
}

export function databasePoolConfig(
  appConfig: AppConfig = config,
  applicationName = databaseApplicationName()
): pg.PoolConfig {
  return {
    connectionString: appConfig.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: appConfig.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: appConfig.DATABASE_IDLE_TIMEOUT_MS,
    statement_timeout: appConfig.DATABASE_STATEMENT_TIMEOUT_MS,
    lock_timeout: appConfig.DATABASE_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: appConfig.DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
    application_name: applicationName
  };
}

type ActiveTransaction = ReturnType<typeof beginObservedTransaction>;
const instrumentedClients = new WeakSet<pg.PoolClient>();
const clientTransactions = new WeakMap<pg.PoolClient, ActiveTransaction>();

function queryText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string") {
    return value.text;
  }
  return undefined;
}

function transactionCommand(text: string | undefined): "begin" | "end" | undefined {
  const command = text?.trim().replace(/;\s*$/, "").toLocaleUpperCase("en-US");
  if (command === "BEGIN" || command === "START TRANSACTION") return "begin";
  if (command === "COMMIT" || command === "ROLLBACK") return "end";
  return undefined;
}

function instrumentClient(client: pg.PoolClient, process: ObservabilityProcess): pg.PoolClient {
  if (instrumentedClients.has(client)) return client;
  instrumentedClients.add(client);
  const originalQuery = client.query.bind(client);
  const originalRelease = client.release.bind(client);

  client.query = ((...input: unknown[]) => {
    const startedAt = performance.now();
    const text = queryText(input[0]);
    const command = transactionCommand(text);
    const queryClass = databaseQueryClass(text);
    let completed = false;
    const complete = (error?: unknown) => {
      if (completed) return;
      completed = true;
      const outcome = databaseOutcome(error);
      observeDatabaseHistogram({
        metric: "database_statement_duration_ms",
        process,
        outcome,
        queryClass,
        durationMs: performance.now() - startedAt
      });
      if (command === "begin" && !error && !clientTransactions.has(client)) {
        clientTransactions.set(client, beginObservedTransaction(process));
      } else if (command === "end") {
        const active = clientTransactions.get(client);
        if (active) {
          clientTransactions.delete(client);
          endObservedTransaction(active, outcome);
        }
      }
    };

    let callbackIndex = -1;
    for (let index = input.length - 1; index >= 0; index -= 1) {
      if (typeof input[index] === "function") {
        callbackIndex = index;
        break;
      }
    }
    if (callbackIndex >= 0) {
      const callback = input[callbackIndex] as (...args: unknown[]) => unknown;
      input[callbackIndex] = (error: unknown, ...args: unknown[]) => {
        complete(error);
        return callback(error, ...args);
      };
      return (originalQuery as (...args: unknown[]) => unknown)(...input);
    }
    try {
      const result = (originalQuery as (...args: unknown[]) => unknown)(...input);
      if (result && typeof result === "object" && "then" in result) {
        return (result as Promise<unknown>).then(
          (value) => {
            complete();
            return value;
          },
          (error) => {
            complete(error);
            throw error;
          }
        );
      }
      complete();
      return result;
    } catch (error) {
      complete(error);
      throw error;
    }
  }) as typeof client.query;

  client.release = ((error?: boolean | Error) => {
    const active = clientTransactions.get(client);
    if (active) {
      clientTransactions.delete(client);
      endObservedTransaction(active, "abandoned");
    }
    return originalRelease(error);
  }) as typeof client.release;
  return client;
}

export class ObservedDatabasePool extends pg.Pool {
  private readonly process: ObservabilityProcess;

  constructor(poolConfig: pg.PoolConfig) {
    super(poolConfig);
    this.process = observabilityProcess(String(poolConfig.application_name ?? ""));
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(
    callback: (
      error: Error | undefined,
      client: pg.PoolClient | undefined,
      done: (release?: boolean | Error) => void
    ) => void
  ): void;
  override connect(callback?: (
    error: Error | undefined,
    client: pg.PoolClient | undefined,
    done: (release?: boolean | Error) => void
  ) => void): Promise<pg.PoolClient> | void {
    const startedAt = performance.now();
    const observe = (outcome: DatabaseOutcome) => observeDatabaseHistogram({
      metric: "database_pool_wait_ms",
      process: this.process,
      outcome,
      durationMs: performance.now() - startedAt
    });

    if (callback) {
      return super.connect((error, client, done) => {
        observe(databaseOutcome(error));
        if (!client) return callback(error, undefined, done);
        const observed = instrumentClient(client, this.process);
        const observedDone = (release?: boolean | Error) => {
          const active = clientTransactions.get(observed);
          if (active) {
            clientTransactions.delete(observed);
            endObservedTransaction(active, "abandoned");
          }
          done(release);
        };
        callback(error, observed, observedDone);
      });
    }

    return super.connect().then(
      (client) => {
        observe("success");
        return instrumentClient(client, this.process);
      },
      (error) => {
        observe(databaseOutcome(error));
        throw error;
      }
    );
  }
}

export const db = new ObservedDatabasePool(databasePoolConfig());
