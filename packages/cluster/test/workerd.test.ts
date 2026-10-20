import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Miniflare } from "miniflare"
import { Database } from "bun:sqlite"
import { exportArchive, importTables, verifyArchive, type Archive, type PortableSql } from "../src/archive"

const integration = process.env.CLUSTER_TEST_WORKER === "1" ? test : test.skip

integration("real workerd serves the stock session API from Durable Object SQLite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-cluster-workerd-"))
  const options = {
    modules: true,
    modulesRules: [{ type: "Text" as const, include: ["**/*.txt"], fallthrough: true }],
    scriptPath: path.join(import.meta.dir, "../dist/cloudflare/worker.js"),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      NAMESPACES: { className: "OpenCodeNamespace", useSQLite: true },
      SANDBOXES: { className: "ExecutionSandbox", useSQLite: true },
    },
    r2Buckets: ["ARTIFACTS"],
    bindings: {
      CLUSTER_PASSWORD: "test-only",
      EXECUTION_TOKEN: "executor-test-only",
      // Synthetic data in a local runtime; this does not qualify cloud placement.
      RESIDENCY: "unrestricted",
    },
  }
  const headers = { authorization: `Basic ${btoa("opencode:test-only")}`, "content-type": "application/json" }
  const configuration = { workers: [{ name: "cluster", ...options }], durableObjectsPersist: path.join(root, "do") }
  try {
    const first = new Miniflare(configuration)
    const id = await (async () => {
      try {
        expect((await first.dispatchFetch("http://cluster/api/session")).status).toBe(401)
        const created = await first.dispatchFetch("http://cluster/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Durable Workers session", location: { directory: "/workspace" } }),
        })
        if (!created.ok) throw new Error(await created.text())
        const { data } = (await created.json()) as { data: { id: string } }
        return data.id
      } finally {
        await first.dispose()
      }
    })()
    const second = new Miniflare(configuration)
    const db = new Database(":memory:")
    const sql: PortableSql = {
      all: (query) => db.query<Record<string, unknown>, []>(query).all(),
      values: (query) => db.query(query).values(),
      exec: (query, values = []) => {
        db.run(query, values as Array<string | number | null>)
      },
    }
    const archive = await (async () => {
      try {
        const response = await second.dispatchFetch(`http://cluster/api/session/${id}`, { headers })
        expect(response.status).toBe(200)
        expect(((await response.json()) as { data: { title: string } }).data.title).toBe("Durable Workers session")
        const exported = await second.dispatchFetch("http://cluster/cluster/archive", { headers })
        if (!exported.ok) throw new Error(await exported.text())
        const archive = (await exported.json()) as Archive
        await verifyArchive(archive)
        db.transaction(() => importTables(sql, archive))()
        expect(db.query("SELECT id FROM session_v2").all()).toEqual([{ id }])
        return await exportArchive(sql)
      } finally {
        db.close()
        await second.dispose()
      }
    })()
    const restored = new Miniflare({
      ...configuration,
      workers: [{ name: "cluster", ...options, bindings: { ...options.bindings, CLUSTER_NAMESPACE: "imported" } }],
    })
    try {
      // A full upstream schema round-trips DO -> native SQLite -> fresh DO.
      const imported = await restored.dispatchFetch("http://cluster/cluster/archive", {
        method: "POST",
        headers,
        body: JSON.stringify(archive),
      })
      if (!imported.ok) throw new Error(await imported.text())
      const response = await restored.dispatchFetch(`http://cluster/api/session/${id}`, { headers })
      expect(response.status).toBe(200)
      expect(((await response.json()) as { data: { title: string } }).data.title).toBe("Durable Workers session")
    } finally {
      await restored.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
