import { SQL } from "bun"
import { FencedError, type Fence, type StateBackend, type Transaction } from "../contracts"

/**
 * A PostgreSQL row is the authoritative SQLite image. Transactions lock that row,
 * so every replica reads the latest committed state without a local cache.
 *
 * This deliberately trades throughput for a small upstream patch surface. It is
 * an alpha backend, not a claim that whole-image commits scale to 1,000 busy agents.
 */
export class PostgresState implements StateBackend {
  readonly sql: SQL

  constructor(url: string) {
    this.sql = new SQL(url, { max: 16 })
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
  }

  async begin(namespace: string, fence?: Fence): Promise<Transaction> {
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
      if (fence && (row.owner !== fence.owner || Number(row.epoch) !== fence.epoch || !row.live))
        throw new FencedError()
      let closed = false
      return {
        checkpoint: { revision: Number(row.revision), bytes: new Uint8Array(row.image) },
        commit: async (bytes) => {
          if (closed) throw new Error("Transaction already closed")
          closed = true
          try {
            // Recheck wall-clock expiry after a long transaction. A row lock alone
            // is not a lease: an expired worker must not publish a late result.
            if (fence) {
              const [valid] = await connection`
                SELECT expires > clock_timestamp() AS live FROM opencode_cluster_state
                WHERE namespace = ${namespace} AND owner = ${fence.owner} AND epoch = ${fence.epoch}
              `
              if (!valid?.live) throw new FencedError()
            }
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
    await this.sql`
      INSERT INTO opencode_cluster_state (namespace) VALUES (${namespace}) ON CONFLICT DO NOTHING
    `
    const [row] = await this.sql`
      UPDATE opencode_cluster_state
      SET owner = ${owner}, epoch = epoch + 1,
          expires = clock_timestamp() + ${ttl} * interval '1 millisecond'
      WHERE namespace = ${namespace} AND (owner IS NULL OR expires <= clock_timestamp())
      RETURNING epoch
    `
    if (!row) return
    return { namespace, owner, epoch: Number(row.epoch) }
  }

  async renew(fence: Fence, ttl: number) {
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
    await this.sql`
      UPDATE opencode_cluster_state SET owner = NULL, expires = NULL
      WHERE namespace = ${fence.namespace} AND owner = ${fence.owner} AND epoch = ${fence.epoch}
    `
  }

  async close() {
    await this.sql.close()
  }
}
