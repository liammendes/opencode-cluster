export interface Archive {
  readonly format: "opencode-cluster"
  readonly version: 1
  readonly upstream: "v2.0.32"
  readonly createdAt: string
  readonly objects: ReadonlyArray<{ readonly type: string; readonly name: string; readonly sql: string }>
  readonly tables: ReadonlyArray<{
    readonly name: string
    readonly sql: string
    readonly columns: ReadonlyArray<string>
    readonly rows: ReadonlyArray<ReadonlyArray<Value>>
  }>
  readonly checksum: string
}

export type Value = string | number | null | { readonly blob: string }

export interface PortableSql {
  all(query: string, values?: ReadonlyArray<unknown>): Array<Record<string, unknown>>
  values(query: string): Array<Array<unknown>>
  exec(query: string, values?: ReadonlyArray<unknown>): void
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const secretTable = /credential|secret|auth|token/i
const transientTable = /^cluster_(control|runtime|wake)$/i
const digest = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")

/**
 * Logical SQLite tables work on Bun, Durable Objects and compatible runtimes.
 * Credentials are intentionally absent. Inline configuration and workspace
 * files must be audited separately before publishing an archive.
 */
export async function exportArchive(sql: PortableSql): Promise<Archive> {
  const tables = sql
    .all(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .filter((table) => !transientTable.test(String(table.name)))
    .map((table) => {
      const name = String(table.name)
      return {
        name,
        sql: String(table.sql),
        columns: sql.all(`PRAGMA table_info(${quote(name)})`).map((column) => String(column.name)),
        // Keep the schema so upstream migrations still match after import.
        rows: (secretTable.test(name) ? [] : sql.values(`SELECT * FROM ${quote(name)}`)).map((row) =>
          row.map((value): Value => {
            if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
              const bytes = new Uint8Array(value)
              return { blob: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")) }
            }
            if (value === null || typeof value === "string" || typeof value === "number") return value
            throw new Error(`Unsupported SQLite value in ${name}`)
          }),
        ),
      }
    })
  const body = {
    format: "opencode-cluster" as const,
    version: 1 as const,
    upstream: "v2.0.32" as const,
    createdAt: new Date().toISOString(),
    tables,
    objects: sql
      .all(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .filter((object) => !transientTable.test(String(object.tbl_name)))
      .map((object) => ({ type: String(object.type), name: String(object.name), sql: String(object.sql) })),
  }
  return { ...body, checksum: await digest(JSON.stringify(body)) }
}

export async function verifyArchive(archive: Archive) {
  const { checksum, ...body } = archive
  if (archive.format !== "opencode-cluster" || archive.version !== 1 || archive.upstream !== "v2.0.32")
    throw new Error("Unsupported archive format or upstream schema")
  if ((await digest(JSON.stringify(body))) !== checksum) throw new Error("Archive checksum mismatch")
  if (archive.tables.some((table) => secretTable.test(table.name) && table.rows.length))
    throw new Error("Archive contains credential values")
}

/** Call inside the destination's transaction; import only into an empty database. */
export function importTables(sql: PortableSql, archive: Archive) {
  if (
    sql.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).length
  )
    throw new Error("Import requires an empty database")
  sql.exec("PRAGMA defer_foreign_keys = ON")
  for (const table of archive.tables) {
    // Archives are trusted backups. SQL is deliberately not accepted by a public endpoint.
    sql.exec(table.sql)
  }
  for (const table of archive.tables) {
    const statement = `INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`
    for (const row of table.rows)
      sql.exec(
        statement,
        row.map((value) =>
          typeof value === "object" && value !== null
            ? Uint8Array.from(atob(value.blob), (char) => char.charCodeAt(0))
            : value,
        ),
      )
  }
  for (const object of archive.objects) sql.exec(object.sql)
}
