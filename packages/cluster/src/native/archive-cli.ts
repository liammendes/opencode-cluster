import { Database } from "bun:sqlite"
import { readFile, writeFile } from "node:fs/promises"
import { exportArchive, importTables, verifyArchive, type Archive, type PortableSql } from "../archive"
import { PostgresState } from "./postgres"

const [operation, file] = process.argv.slice(2)
if (!file || !["export", "import"].includes(operation))
  throw new Error("Usage: bun src/native/archive-cli.ts export|import archive.json")
if (!process.env.CLUSTER_DATABASE_URL) throw new Error("CLUSTER_DATABASE_URL is required")
const backend = new PostgresState(process.env.CLUSTER_DATABASE_URL)
await backend.initialize()
const namespace = process.env.CLUSTER_NAMESPACE ?? "default"
const fence = await backend.acquire(namespace, `archive-${crypto.randomUUID()}`, 60_000)
if (!fence) throw new Error("Drain and stop the execution worker before archiving this namespace")
const transaction = await backend.begin(namespace, fence)
const database = transaction.checkpoint.bytes.length
  ? Database.deserialize(transaction.checkpoint.bytes, { readonly: false })
  : new Database(":memory:")
const sql: PortableSql = {
  all: (query, params = []) =>
    database
      .query<Record<string, unknown>, Array<string | number | null>>(query)
      .all(...(params as Array<string | number | null>)),
  values: (query) => database.query(query).values(),
  exec: (query, params = []) => {
    database.run(query, params as Array<string | number | null>)
  },
}
try {
  if (operation === "export") {
    if (
      sql.all("SELECT name FROM sqlite_master WHERE name = 'session_inbox'").length &&
      sql.all("SELECT id FROM session_inbox LIMIT 1").length
    )
      throw new Error("Drain or cancel pending inputs before export")
    const archive = await exportArchive(sql)
    await writeFile(file, JSON.stringify(archive), { flag: "wx", mode: 0o600 })
    await transaction.rollback()
    console.log(JSON.stringify({ operation, tables: archive.tables.length, checksum: archive.checksum }))
  }
  if (operation === "import") {
    const archive = JSON.parse(await readFile(file, "utf8")) as Archive
    await verifyArchive(archive)
    database.transaction(() => importTables(sql, archive))()
    await transaction.commit(database.serialize())
    console.log(JSON.stringify({ operation, tables: archive.tables.length, checksum: archive.checksum }))
  }
} finally {
  await transaction.rollback()
  database.close()
  await backend.release(fence)
  await backend.close()
}
