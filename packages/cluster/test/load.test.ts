import { expect, test } from "bun:test"
import { PostgresState } from "../src/native/postgres"
import { createReplica } from "../src/native/server"

const benchmark = process.env.CLUSTER_BENCHMARK === "1" ? test : test.skip

benchmark(
  "1,000 stored sessions stay readable across independent API runtimes",
  async () => {
    const backend = new PostgresState(process.env.CLUSTER_DATABASE_URL!)
    await backend.initialize()
    const namespace = crypto.randomUUID()
    const options = {
      backend,
      namespace,
      server: {
        models: { fetch: false },
        config: { project: false, claude: false },
        fs: { filewatcher: false, fff: false },
      },
    }
    const first = await createReplica(options)
    const second = await createReplica(options)
    const before = process.memoryUsage().rss
    const started = performance.now()
    const ids: string[] = []
    try {
      // Bounded admission, with writes split across both application runtimes.
      for (let offset = 0; offset < 1000; offset += 8) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(8, 1000 - offset) }, async (_, index) => {
            const response = await (index % 2 ? first : second).fetch(
              new Request("http://cluster/api/session", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ title: `Synthetic ${offset + index}`, location: { directory: "/tmp" } }),
              }),
            )
            if (!response.ok) throw new Error(await response.text())
            return ((await response.json()) as { data: { id: string } }).data.id
          }),
        )
        ids.push(...batch)
      }
      const admittedMs = performance.now() - started
      await first.close()
      const replacement = await createReplica(options)
      try {
        for (let offset = 0; offset < ids.length; offset += 8)
          await Promise.all(
            ids.slice(offset, offset + 8).map(async (id) => {
              const response = await replacement.fetch(new Request(`http://cluster/api/session/${id}`))
              expect(response.status).toBe(200)
              expect(((await response.json()) as { data: { id: string } }).data.id).toBe(id)
            }),
          )
        console.log(
          "CLUSTER_BENCHMARK",
          JSON.stringify({
            sessions: ids.length,
            admittedMs: Math.round(admittedMs),
            totalMs: Math.round(performance.now() - started),
            rssBeforeMiB: Math.round(before / 2 ** 20),
            rssAfterMiB: Math.round(process.memoryUsage().rss / 2 ** 20),
            note: "Two API runtimes in one Bun test process; zero LLM executions. RSS is process-wide, not per-agent.",
          }),
        )
      } finally {
        await replacement.close()
      }
    } finally {
      await first.close()
      await second.close()
      await backend.sql`DELETE FROM opencode_cluster_state WHERE namespace = ${namespace}`
      await backend.close()
    }
  },
  180_000,
)
