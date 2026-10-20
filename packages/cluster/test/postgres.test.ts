import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Layer } from "effect"
import { OpenCode } from "@opencode/client"
import { LLMClient } from "@opencode/ai"
import { TestLLM } from "@opencode/ai/testing"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { SessionMessage } from "@opencode/core/session/message"
import { SqlClient } from "effect/sql"
import { PostgresState } from "../src/native/postgres"
import { sharedSqlite } from "../src/native/sqlite"
import { createReplica, createWorker } from "../src/native/server"
import { createPoolWorker } from "../src/native/pool"
import { exportArchive, importTables, verifyArchive, type PortableSql } from "../src/archive"

const enabled = process.env.CLUSTER_TEST_POSTGRES === "1"
const url = process.env.CLUSTER_DATABASE_URL ?? "postgres://unused"
const backend = new PostgresState(url)
const namespaces: string[] = []
const namespace = () => {
  const id = crypto.randomUUID()
  namespaces.push(id)
  return id
}
beforeAll(async () => {
  if (enabled) await backend.initialize()
})
afterAll(async () => {
  if (!enabled) return
  for (const id of namespaces) {
    await backend.sql`DELETE FROM opencode_cluster_workers WHERE namespace = ${id}`
    await backend.sql`DELETE FROM opencode_cluster_state WHERE namespace = ${id}`
  }
  await backend.close()
})
const integration = enabled ? test : test.skip

integration("pool leases coexist, exclude the legacy worker, and fence late commits", async () => {
  const id = namespace()
  const first = (await backend.acquireWorker(id, "one", 60_000))!
  const second = (await backend.acquireWorker(id, "two", 60_000))!
  expect(first.scope).toBe("worker")
  expect(await backend.alive(second)).toBe(true)
  expect(await backend.acquire(id, "legacy", 60_000)).toBeUndefined()
  await expect(backend.begin(namespace(), first)).rejects.toThrow("ownership")
  const transaction = await backend.begin(id, first)
  await backend.sql`
    UPDATE opencode_cluster_workers SET expires = clock_timestamp() - interval '1 second'
    WHERE namespace = ${id} AND owner = ${first.owner}
  `
  await expect(transaction.commit(new Uint8Array([1]))).rejects.toThrow("ownership")
  const successor = (await backend.acquireWorker(id, "one", 60_000))!
  expect(successor.epoch).toBe(first.epoch + 1)
  await backend.release(first)
  expect(await backend.alive(successor)).toBe(true)
  await backend.release(successor)
  await backend.release(second)
  const legacy = (await backend.acquire(id, "legacy", 60_000))!
  expect(await backend.acquireWorker(id, "three", 60_000)).toBeUndefined()
  await backend.release(legacy)
})

integration(
  "two pool workers enforce capacity, own different sessions, and recover without replay",
  async () => {
    const id = namespace()
    const options = {
      backend,
      namespace: id,
      server: {
        models: { fetch: false },
        fs: { filewatcher: false, fff: false },
        config: {
          content: JSON.stringify({
            model: "custom/fictional-chat",
            providers: {
              custom: {
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: "https://provider.example/v1", apiKey: "synthetic" },
                models: { "fictional-chat": {} },
              },
            },
          }),
        },
      },
    }
    const api = await createReplica(options)
    const client = OpenCode.make({
      baseUrl: "http://cluster",
      fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => api.fetch(new Request(input, init)), {
        preconnect: fetch.preconnect,
      }),
    })
    const llms = await Promise.all(
      [0, 1].map(() =>
        Effect.runPromise(TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer({ fallback: TestLLM.hangAfter() })))),
      ),
    )
    const fences = await Promise.all(["a", "b"].map((owner) => backend.acquireWorker(id, owner, 120_000)))
    const workers = await Promise.all(
      fences.map((fence, index) =>
        createPoolWorker(
          { ...options, overrides: [llmClient.replace(Layer.succeed(LLMClient.Service, llms[index]!))] },
          fence!,
          2,
        ),
      ),
    )
    try {
      for (let index = 0; index < 5; index++) {
        const session = await client.session.create({ location: { directory: "/tmp" } })
        await client.session.prompt({ sessionID: session.id, text: "Wait for a reply" })
      }
      await Promise.all(workers.map((worker) => worker.tick()))
      await Promise.all(llms.map((llm) => Effect.runPromise(llm.wait(2))))
      const first = await workers[0]!.active()
      const second = await workers[1]!.active()
      expect(first.size).toBe(2)
      expect(second.size).toBe(2)
      expect([...first].filter((session) => second.has(session))).toHaveLength(0)
      const transaction = await backend.begin(id)
      const db = Database.deserialize(transaction.checkpoint.bytes)
      expect(db.query("SELECT count(*) AS total FROM cluster_assignments").get()).toEqual({ total: 4 })
      expect(db.query("SELECT count(*) AS total FROM session_inbox").get()).toEqual({ total: 1 })
      const lostNotice = SessionMessage.ID.create()
      const liveNotice = SessionMessage.ID.create()
      for (const [session, notificationID] of [[...first][0]!, [...second][0]!].map(
        (session, index) => [session, index === 0 ? lostNotice : liveNotice] as const,
      ))
        db.run("INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)", [
          `job.background/${notificationID}`,
          JSON.stringify({
            id: notificationID,
            notificationID,
            status: "running",
            recovery: {
              kind: "shell",
              sessionID: session,
              shellID: "test-shell",
              command: "synthetic background command",
            },
          }),
          Date.now(),
          Date.now(),
        ])
      await transaction.commit(db.serialize())
      db.close()
      await transaction.rollback()
      await backend.sql`
      UPDATE opencode_cluster_workers SET expires = clock_timestamp() - interval '1 second'
      WHERE namespace = ${id} AND owner = ${fences[0]!.owner}
    `
      await workers[0]!.close()
      await workers[1]!.tick()
      expect([...(await workers[1]!.active())].sort()).toEqual([...second].sort())
      const recovered = await backend.begin(id)
      const state = Database.deserialize(recovered.checkpoint.bytes)
      expect(state.query("SELECT key FROM kv WHERE key = ?").get(`job.background/${lostNotice}`)).toBeNull()
      expect(state.query("SELECT key FROM kv WHERE key = ?").get(`job.background/${liveNotice}`)).not.toBeNull()
      for (const session of first)
        expect(state.query("SELECT time_suspended FROM session_v2 WHERE id = ?").get(session)).toEqual({
          time_suspended: null,
        })
      state.close()
      await recovered.rollback()
    } finally {
      await Promise.all(workers.map((worker) => worker.close()))
      await api.close()
      await Promise.all(fences.map((fence) => backend.release(fence!)))
    }
  },
  60_000,
)

integration("independent clients serialize concurrent writes and see committed state", async () => {
  const id = namespace()
  const first = sharedSqlite(backend, id)
  const second = sharedSqlite(backend, id)
  const query = <A>(layer: typeof first, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped))
  await query(
    first,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("CREATE TABLE counter (value INTEGER NOT NULL)")
      yield* sql.unsafe("INSERT INTO counter VALUES (0)")
    }),
  )
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      query(
        index % 2 ? first : second,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const [row] = yield* sql<{ value: number }>`SELECT value FROM counter`
              yield* sql`UPDATE counter SET value = ${row!.value + 1}`
            }),
          )
        }),
      ),
    ),
  )
  expect(
    await query(
      second,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ value: number }>`SELECT value FROM counter`
      }),
    ),
  ).toEqual([{ value: 40 }])
  await expect(
    query(
      first,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.withTransaction(
          sql
            .unsafe("UPDATE counter SET value = 999")
            .pipe(Effect.andThen(Effect.fail(new Error("cancel transaction")))),
        )
      }),
    ),
  ).rejects.toThrow("cancel transaction")
  const transaction = await backend.begin(id)
  const db = Database.deserialize(transaction.checkpoint.bytes)
  expect(db.query("SELECT value FROM counter").get()).toEqual({ value: 40 })
  db.close()
  await transaction.rollback()
})

integration("stale owners cannot publish, renew, or release a successor", async () => {
  const id = namespace()
  const first = (await backend.acquire(id, "one", 10_000))!
  expect(await backend.acquire(id, "two", 10_000)).toBeUndefined()
  // Drive the database clock boundary explicitly, with no sleep or flaky timeout.
  await backend.sql`UPDATE opencode_cluster_state SET expires = clock_timestamp() - interval '1 second' WHERE namespace = ${id}`
  const next = (await backend.acquire(id, "two", 10_000))!
  expect(next.epoch).toBe(first.epoch + 1)
  await expect(backend.begin(id, first)).rejects.toThrow("ownership")
  expect(await backend.renew(first, 10_000)).toBe(false)
  await backend.release(first)
  expect(await backend.renew(next, 10_000)).toBe(true)
  await backend.release(next)
})

integration("stock OpenCode HTTP sessions survive replica replacement", async () => {
  const id = namespace()
  const options = {
    backend,
    namespace: id,
    server: {
      models: { fetch: false },
      config: { project: false, claude: false },
      fs: { filewatcher: false, fff: false },
    },
  }
  const first = await createReplica(options)
  const second = await createReplica(options)
  try {
    const created = await first.fetch(
      new Request("http://cluster/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Shared session", location: { directory: "/tmp" } }),
      }),
    )
    expect(await created.clone().text()).not.toContain("_tag")
    expect(created.status).toBe(200)
    const { data } = (await created.json()) as { data: { id: string } }
    const read = await second.fetch(new Request(`http://cluster/api/session/${data.id}`))
    expect(read.status).toBe(200)
    expect(((await read.json()) as { data: { title: string } }).data.title).toBe("Shared session")
    await first.close()
    const third = await createReplica(options)
    try {
      const read = await third.fetch(new Request(`http://cluster/api/session/${data.id}`))
      expect(read.status).toBe(200)
    } finally {
      await third.close()
    }
  } finally {
    await first.close()
    await second.close()
  }
})

integration(
  "an acknowledged prompt survives API shutdown and completes through the stock client on another replica",
  async () => {
    const id = namespace()
    const options = {
      backend,
      namespace: id,
      server: {
        models: { fetch: false },
        fs: { filewatcher: false, fff: false },
        config: {
          project: false,
          claude: false,
          content: JSON.stringify({
            model: "custom/fictional-chat",
            providers: {
              custom: {
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: "https://provider.example/v1", apiKey: "synthetic" },
                models: { "fictional-chat": {} },
              },
            },
          }),
        },
      },
    }
    const first = await createReplica(options)
    const second = await createReplica(options)
    const clientA = OpenCode.make({
      baseUrl: "http://cluster",
      fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => first.fetch(new Request(input, init)), {
        preconnect: fetch.preconnect,
      }),
    })
    const clientB = OpenCode.make({
      baseUrl: "http://cluster",
      fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => second.fetch(new Request(input, init)), {
        preconnect: fetch.preconnect,
      }),
    })
    const fence = (await backend.acquire(id, "test-worker", 60_000))!
    const llm = await Effect.runPromise(
      TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("ready", "answer") }))),
    )
    const worker = await createWorker(
      {
        ...options,
        overrides: [llmClient.replace(Layer.succeed(LLMClient.Service, llm))],
      },
      fence,
    )
    try {
      const session = await clientA.session.create({ location: { directory: "/tmp" } })
      const messageID = SessionMessage.ID.create()
      await clientA.session.prompt({ sessionID: session.id, id: messageID, text: "Say ready", resume: false })
      await worker.tick(8)
      expect((await worker.active()).size).toBe(0)
      const before = await clientB.session.inbox.list({ sessionID: session.id })
      expect(before).toHaveLength(1)

      const abort = new AbortController()
      const completed = (async () => {
        for await (const event of clientB.session.log(
          { sessionID: session.id, follow: true },
          { signal: abort.signal },
        )) {
          if (event.type === "session.execution.succeeded") return event
          if (event.type === "session.execution.failed") throw new Error(JSON.stringify(event))
        }
        throw new Error("Event stream ended without completion")
      })()
      const admitted = await clientA.session.prompt({
        sessionID: session.id,
        id: messageID,
        text: "Retry body must not replace original",
      })
      expect(admitted.id).toBe(messageID)
      await first.close()
      await worker.tick(8)
      try {
        expect((await completed).type).toBe("session.execution.succeeded")
        const context = await clientB.session.context({ sessionID: session.id })
        expect(JSON.stringify(context)).toContain("ready")
        expect(JSON.stringify(context)).not.toContain("Retry body must not replace original")
        expect(await clientB.session.inbox.list({ sessionID: session.id })).toHaveLength(0)
      } finally {
        abort.abort()
      }
    } finally {
      await worker.close()
      await first.close()
      await second.close()
      await backend.release(fence)
    }
  },
)

function portable(db: Database): PortableSql {
  return {
    all: (query) => db.query<Record<string, unknown>, []>(query).all(),
    values: (query) => db.query(query).values(),
    exec: (query, values = []) => {
      db.run(query, values as Array<string | number | null>)
    },
  }
}

test("portable archives retain IDs and blobs, omit credentials, and detect damage", async () => {
  const db = new Database(":memory:")
  const destination = new Database(":memory:")
  try {
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY, bytes BLOB)")
    db.run("CREATE TABLE credential (token TEXT)")
    db.run("INSERT INTO session VALUES (?, ?)", ["ses_fixed", new Uint8Array([0, 255, 42])])
    db.run("INSERT INTO credential VALUES ('private-test-value')")
    const archive = await exportArchive(portable(db))
    expect(JSON.stringify(archive)).not.toContain("private-test-value")
    await verifyArchive(archive)
    destination.transaction(() => importTables(portable(destination), archive))()
    expect(destination.query("SELECT * FROM session").get()).toEqual({
      id: "ses_fixed",
      bytes: new Uint8Array([0, 255, 42]),
    })
    await expect(verifyArchive({ ...archive, checksum: "broken" })).rejects.toThrow("checksum")
  } finally {
    db.close()
    destination.close()
  }
})
