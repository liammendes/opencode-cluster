import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { PostgresState } from "./postgres"

// Same-backend migration intentionally includes credentials. Unlike a portable
// archive, it must stay inside the operator's trusted secret and database paths.
const sourceURL = process.env.SOURCE_DATABASE_URL
const destinationURL = process.env.DESTINATION_DATABASE_URL
if (!sourceURL || !destinationURL) throw new Error("SOURCE_DATABASE_URL and DESTINATION_DATABASE_URL are required")
if (process.env.CLUSTER_WRITERS_STOPPED !== "yes") throw new Error("Stop API and worker writers before copying state")
const namespace = process.env.CLUSTER_NAMESPACE ?? "default"
const source = new PostgresState(sourceURL, {
  max: 2,
  ...(process.env.SOURCE_DATABASE_SOCKET ? { path: process.env.SOURCE_DATABASE_SOCKET } : {}),
})
const destination = new PostgresState(destinationURL, { max: 2 })
await destination.initialize()
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
try {
  const from = await source.begin(namespace)
  try {
    if (!from.checkpoint.bytes.length) throw new Error("Source state is empty")
    const sqlite = Database.deserialize(from.checkpoint.bytes)
    const active = sqlite
      .query<{ total: number }, []>("SELECT count(*) AS total FROM session_v2 WHERE time_suspended IS NOT NULL")
      .get()!.total
    const sessions = sqlite.query<{ total: number }, []>("SELECT count(*) AS total FROM session_v2").get()!.total
    const credentialTables = sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%credential%'")
      .all()
    const credentials = Object.fromEntries(
      credentialTables.map(({ name }) => [
        name,
        sqlite.query<{ total: number }, []>('SELECT count(*) AS total FROM "' + name.replaceAll('"', '""') + '"').get()!
          .total,
      ]),
    )
    sqlite.close()
    if (active) throw new Error("Source has interrupted or active executions; settle them before migration")
    const to = await destination.begin(namespace)
    try {
      if (to.checkpoint.bytes.length && hash(to.checkpoint.bytes) !== hash(from.checkpoint.bytes))
        throw new Error("Destination already contains different state; refusing to overwrite it")
      await to.commit(to.checkpoint.bytes.length ? undefined : from.checkpoint.bytes)
    } finally {
      await to.rollback()
    }
    const verify = await destination.begin(namespace)
    try {
      if (hash(verify.checkpoint.bytes) !== hash(from.checkpoint.bytes))
        throw new Error("Destination checksum mismatch")
      console.log(
        JSON.stringify({
          migrated: true,
          namespace,
          bytes: from.checkpoint.bytes.length,
          checksum: hash(from.checkpoint.bytes),
          sessions,
          credentials,
        }),
      )
    } finally {
      await verify.rollback()
    }
  } finally {
    await from.rollback()
  }
} finally {
  await source.close()
  await destination.close()
}
