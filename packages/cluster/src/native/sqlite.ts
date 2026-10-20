import { Database as SQLite, type SQLQueryBindings } from "bun:sqlite"
import { Effect, Exit, Layer } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient, Statement } from "effect/sql"
import { classifySqliteError, SqlError } from "effect/sql/SqlError"
import { Sqlite } from "@opencode/core/database/sqlite"
import type { Fence, StateBackend } from "../contracts"

const sqlError = (cause: unknown) =>
  new SqlError({
    reason: classifySqliteError(cause, { message: "Cluster transaction failed", operation: "execute" }),
  })

/**
 * Each Effect SQL scope borrows the latest image under a backend transaction.
 * No SQLite file is shared over NFS, and an HTTP replica never serves a cached
 * database. SQLite transactions/savepoints retain upstream semantics.
 */
export function sharedSqlite(backend: StateBackend, namespace: string, fence?: Fence) {
  const acquire = Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const transaction = await backend.begin(namespace, fence)
        try {
          const bytes = transaction.checkpoint.bytes
          const database = bytes.length ? SQLite.deserialize(bytes, { readonly: false }) : new SQLite(":memory:")
          database.run("PRAGMA foreign_keys = ON")
          return { database, transaction }
        } catch (error) {
          await transaction.rollback()
          throw error
        }
      },
      catch: sqlError,
    }),
    ({ database, transaction }, exit) =>
      Effect.promise(async () => {
        try {
          if (Exit.isFailure(exit)) return await transaction.rollback()
          // Do not persist connection pragmas or read-only statements.
          const bytes = database.serialize()
          const before = transaction.checkpoint.bytes
          const changed = bytes.length !== before.length || bytes.some((byte, index) => byte !== before[index])
          await transaction.commit(changed ? bytes : undefined)
        } finally {
          database.close()
        }
      }),
  )
  const acquirer = acquire.pipe(
    Effect.map(({ database }) => {
      const run = (query: string, params: ReadonlyArray<unknown> = []) =>
        Effect.try({
          try: () =>
            database.query<Record<string, unknown>, SQLQueryBindings[]>(query).all(...(params as SQLQueryBindings[])),
          catch: sqlError,
        })
      const values = (query: string, params: ReadonlyArray<unknown> = []) =>
        Effect.try({
          try: () => database.query(query).values(...(params as SQLQueryBindings[])),
          catch: sqlError,
        })
      return Sqlite.makeConnection(run, values, {})
    }),
  )
  return Layer.effect(
    SqlClient.SqlClient,
    SqlClient.make({
      acquirer,
      transactionAcquirer: acquirer,
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [["db.system.name", "opencode-cluster"]],
    }),
  ).pipe(Layer.provide(Reactivity.layer))
}
