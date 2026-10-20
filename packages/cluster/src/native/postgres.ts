import { SQL } from "bun"
import { FencedError, type Fence, type WorkerStateBackend, type Transaction } from "../contracts"

/**
 * A PostgreSQL row is the authoritative SQLite image. Transactions lock that row,
 * so every replica reads the latest committed state without a local cache.
 *
 * This deliberately trades throughput for a small upstream patch surface. It is
 * an alpha backend, not a claim that whole-image commits scale to 1,000 busy agents.
 */
export class PostgresState implements WorkerStateBackend {
  readonly sql: SQL

  constructor(url: string, options: { max?: number; path?: string } = {}) {
    this.sql = new SQL(url, { max: 16, ...options })
  }

  async initialize() {
    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS opencode_cluster_state (
        namespace text PRIMARY KEY,
        revision bigint NOT NULL DEFAULT 0,
        image bytea NOT NULL DEFAULT ''::bytea,
        owner text,
        epoch bigint NOT NULL DEFAULT 0,
        expires timestamptz
      )
    `)
    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS opencode_cluster_workers (
        namespace text NOT NULL,
        owner text NOT NULL,
        epoch bigint NOT NULL DEFAULT 0,
        expires timestamptz,
        PRIMARY KEY (namespace, owner)
      )
    `)
  }

  async begin(namespace: string, fence?: Fence): Promise<Transaction> {
    if (fence && fence.namespace !== namespace) throw new FencedError()
    const connection = await this.sql.reserve()
    let released = false
    const release = async (command: "COMMIT" | "ROLLBACK") => {
      if (released) return
      try {
        await connection.unsafe(command)
      } finally {
        released = true
        connection.release()
      }
    }
    try {
      await connection.unsafe("BEGIN")
      await connection`
        INSERT INTO opencode_cluster_state (namespace) VALUES (${namespace}) ON CONFLICT DO NOTHING
      `
      const [row] = await connection`
        SELECT revision, image, owner, epoch, expires > clock_timestamp() AS live
        FROM opencode_cluster_state WHERE namespace = ${namespace} FOR UPDATE
      `
      const valid = async () => {
        if (!fence) return true
        const [lease] =
          fence.scope === "worker"
            ? await connection`
                SELECT expires > clock_timestamp() AS live FROM opencode_cluster_workers
                WHERE namespace = ${namespace} AND owner = ${fence.owner} AND epoch = ${fence.epoch}
              `
            : await connection`
                SELECT expires > clock_timestamp() AS live FROM opencode_cluster_state
                WHERE namespace = ${namespace} AND owner = ${fence.owner} AND epoch = ${fence.epoch}
              `
        return lease?.live === true
      }
      if (!(await valid())) throw new FencedError()
      let closed = false
      return {
        checkpoint: { revision: Number(row.revision), bytes: new Uint8Array(row.image) },
        commit: async (bytes) => {
          if (closed) throw new Error("Transaction already closed")
          closed = true
          try {
            // Recheck wall-clock expiry after a long transaction. A row lock alone
            // is not a lease: an expired worker must not publish a late result.
            if (!(await valid())) throw new FencedError()
            if (bytes)
              await connection`
                UPDATE opencode_cluster_state SET image = ${bytes}, revision = revision + 1
                WHERE namespace = ${namespace}
              `
            await release("COMMIT")
          } catch (error) {
            await release("ROLLBACK").catch(() => undefined)
            throw error
          }
        },
        rollback: async () => {
          if (closed) return
          closed = true
          await release("ROLLBACK")
        },
      }
    } catch (error) {
      await release("ROLLBACK").catch(() => undefined)
      throw error
    }
  }

  async acquire(namespace: string, owner: string, ttl: number) {
    if (ttl < 1000) throw new Error("Lease TTL must be at least 1 second")
    return this.sql.begin(async (tx) => {
      await tx`INSERT INTO opencode_cluster_state (namespace) VALUES (${namespace}) ON CONFLICT DO NOTHING`
      const [state] = await tx`
        SELECT owner IS NOT NULL AND expires > clock_timestamp() AS live
        FROM opencode_cluster_state WHERE namespace = ${namespace} FOR UPDATE
      `
      if (state?.live) return
      // Check after taking the namespace lock, so a concurrent pool acquisition
      // cannot be hidden by a statement snapshot taken before that lock.
      const workers = await tx`
        SELECT owner FROM opencode_cluster_workers
        WHERE namespace = ${namespace} AND expires > clock_timestamp() LIMIT 1
      `
      if (workers.length) return
      const [row] = await tx`
        UPDATE opencode_cluster_state SET owner = ${owner}, epoch = epoch + 1,
          expires = clock_timestamp() + ${ttl} * interval '1 millisecond'
        WHERE namespace = ${namespace} RETURNING epoch
      `
      return { namespace, owner, epoch: Number(row.epoch) }
    })
  }

  async renew(fence: Fence, ttl: number) {
    if (fence.scope === "worker") {
      const rows = await this.sql`
        UPDATE opencode_cluster_workers
        SET expires = clock_timestamp() + ${ttl} * interval '1 millisecond'
        WHERE namespace = ${fence.namespace} AND owner = ${fence.owner}
          AND epoch = ${fence.epoch} AND expires > clock_timestamp()
        RETURNING epoch
      `
      return rows.length === 1
    }
    const rows = await this.sql`
      UPDATE opencode_cluster_state
      SET expires = clock_timestamp() + ${ttl} * interval '1 millisecond'
      WHERE namespace = ${fence.namespace} AND owner = ${fence.owner}
        AND epoch = ${fence.epoch} AND expires > clock_timestamp()
      RETURNING epoch
    `
    return rows.length === 1
  }

  async release(fence: Fence) {
    if (fence.scope === "worker") {
      await this.sql`
        UPDATE opencode_cluster_workers SET expires = NULL
        WHERE namespace = ${fence.namespace} AND owner = ${fence.owner} AND epoch = ${fence.epoch}
      `
      return
    }
    await this.sql`
      UPDATE opencode_cluster_state SET owner = NULL, expires = NULL
      WHERE namespace = ${fence.namespace} AND owner = ${fence.owner} AND epoch = ${fence.epoch}
    `
  }

  async acquireWorker(namespace: string, owner: string, ttl: number): Promise<Fence | undefined> {
    if (ttl < 1000) throw new Error("Lease TTL must be at least 1 second")
    return this.sql.begin(async (tx) => {
      await tx`INSERT INTO opencode_cluster_state (namespace) VALUES (${namespace}) ON CONFLICT DO NOTHING`
      // Serialize the transition from a legacy singleton to a distributed pool.
      const [legacy] = await tx`
        SELECT owner IS NOT NULL AND expires > clock_timestamp() AS live
        FROM opencode_cluster_state WHERE namespace = ${namespace} FOR UPDATE
      `
      if (legacy?.live) return
      const [row] = await tx`
        INSERT INTO opencode_cluster_workers (namespace, owner, epoch, expires)
        VALUES (${namespace}, ${owner}, 1, clock_timestamp() + ${ttl} * interval '1 millisecond')
        ON CONFLICT (namespace, owner) DO UPDATE SET
          epoch = opencode_cluster_workers.epoch + 1, expires = EXCLUDED.expires
        WHERE opencode_cluster_workers.expires IS NULL OR opencode_cluster_workers.expires <= clock_timestamp()
        RETURNING epoch
      `
      return row ? { namespace, owner, epoch: Number(row.epoch), scope: "worker" as const } : undefined
    })
  }

  async alive(fence: Fence) {
    const [row] =
      fence.scope === "worker"
        ? await this.sql`
            SELECT expires > clock_timestamp() AS live FROM opencode_cluster_workers
            WHERE namespace = ${fence.namespace} AND owner = ${fence.owner} AND epoch = ${fence.epoch}
          `
        : await this.sql`
            SELECT expires > clock_timestamp() AS live FROM opencode_cluster_state
            WHERE namespace = ${fence.namespace} AND owner = ${fence.owner} AND epoch = ${fence.epoch}
          `
    return row?.live === true
  }

  async close() {
    await this.sql.close()
  }
}
