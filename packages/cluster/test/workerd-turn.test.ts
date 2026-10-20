import { expect, test } from "bun:test"
import { Miniflare } from "miniflare"
import path from "node:path"
import { OpenCode } from "@opencode/client"

const integration = process.env.CLUSTER_TEST_WORKER === "1" && process.env.CLUSTER_TEST_EXECUTOR_URL ? test : test.skip

integration("workerd completes an agent turn through HTTP model and Linux execution transports", async () => {
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (!new URL(request.url).pathname.endsWith("/chat/completions"))
        return new Response("Unknown test endpoint", { status: 404 })
      const chunk = (delta: object, finish_reason: string | null) => ({
        id: "chatcmpl-synthetic",
        object: "chat.completion.chunk",
        created: 1,
        model: "synthetic",
        choices: [{ index: 0, delta, finish_reason }],
      })
      return new Response(
        [chunk({ role: "assistant", content: "Workers execution ready" }, null), chunk({}, "stop")]
          .map((item) => `data: ${JSON.stringify(item)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        {
          headers: { "content-type": "text/event-stream" },
        },
      )
    },
  })
  const runtime = new Miniflare({
    workers: [
      {
        name: "cluster-turn",
        modules: true,
        modulesRules: [{ type: "Text", include: ["**/*.txt"], fallthrough: true }],
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
          EXECUTION_TOKEN: "local-test-only",
          EXECUTION_URL: process.env.CLUSTER_TEST_EXECUTOR_URL!,
          RESIDENCY: "unrestricted",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            model: "custom/synthetic",
            providers: {
              custom: {
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "synthetic" },
                models: { synthetic: {} },
              },
            },
          }),
        },
      },
    ],
  })
  const client = OpenCode.make({
    baseUrl: "http://cluster",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        request.headers.set("authorization", `Basic ${btoa("opencode:test-only")}`)
        const response = await runtime.dispatchFetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: request.body ? await request.arrayBuffer() : undefined,
          signal: request.signal,
        })
        return new Response(response.body as unknown as BodyInit, {
          status: response.status,
          headers: Object.fromEntries(response.headers),
        })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const abort = new AbortController()
  try {
    const session = await client.session.create({ location: { directory: "/workspace" } })
    await client.session.prompt({ sessionID: session.id, text: "Say ready" })
    for await (const event of client.session.log({ sessionID: session.id, follow: true }, { signal: abort.signal })) {
      if (event.type === "session.execution.failed") throw new Error(JSON.stringify(event))
      if (event.type === "session.execution.succeeded") {
        expect(JSON.stringify(await client.session.context({ sessionID: session.id }))).toContain(
          "Workers execution ready",
        )
        return
      }
    }
    throw new Error("Session log closed before completion")
  } finally {
    abort.abort()
    await runtime.dispose()
    provider.stop(true)
  }
})
