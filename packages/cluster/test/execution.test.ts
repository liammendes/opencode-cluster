import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { createBroker } from "../src/execution/broker"
import { remoteSpawner } from "../src/execution/spawner"
import { requireResidency } from "../src/contracts"
import { authenticatedTransport } from "../src/execution/protocol"
import { Environment } from "@opencode/core/environment/index"
import { OpenCode } from "@opencode/client"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHost } from "../src/host"
import { executionLayers } from "../src/execution/layers"

test("the real broker streams stdin/stdout/stderr and returns a process exit", async () => {
  const broker = createBroker("test-only", "/tmp")
  const spawner = remoteSpawner((request) => {
    const headers = new Headers(request.headers)
    headers.set("authorization", "Bearer test-only")
    return broker.fetch(new Request(request, { headers }))
  })
  try {
    expect((await broker.fetch(new Request("http://execution/health"))).status).toBe(401)
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "-e",
                "const data = await Bun.stdin.text(); process.stdout.write(data.toUpperCase()); process.stderr.write('diagnostic'); process.exitCode = 7",
              ],
              { stdin: Stream.make(new TextEncoder().encode("hello")) },
            ),
          )
          return yield* Effect.all(
            {
              stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
              stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
              code: handle.exitCode,
            },
            { concurrency: "unbounded" },
          )
        }),
      ),
    )
    expect({ ...result, code: Number(result.code) }).toEqual({ stdout: "HELLO", stderr: "diagnostic", code: 7 })
  } finally {
    broker.close()
  }
})

test("execution residency must be qualified before accepting U.S.-only data", () => {
  expect(() => requireResidency("us", { state: "us", artifacts: "us", execution: "unverified" })).toThrow("placement")
  expect(() => requireResidency("us", { state: "us", artifacts: "us", execution: "us" })).not.toThrow()
})

test("native shell execution does not forward the control plane environment", async () => {
  // The isolated test runner sets this on the control plane before importing core.
  expect(process.env.OPENCODE_CONFIG_CONTENT).toBeDefined()
  const directory = await mkdtemp(path.join(tmpdir(), "cluster-shell-"))
  const broker = createBroker("test-only", directory)
  const host = await createHost(
    {
      models: { fetch: false },
      config: { project: false, claude: false },
      fs: { filewatcher: false, fff: false },
    },
    executionLayers((request) => {
      const headers = new Headers(request.headers)
      headers.set("authorization", "Bearer test-only")
      return broker.fetch(new Request(request, { headers }))
    }),
  )
  const client = OpenCode.make({
    baseUrl: "http://cluster",
    fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => host.fetch(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  })
  try {
    const location = { directory }
    const shell = await client.shell.create({
      location,
      command: 'test -z "${OPENCODE_CONFIG_CONTENT+x}" && printf isolated',
    })
    const deadline = Date.now() + 10_000
    while ((await client.shell.get({ location, id: shell.data.id })).data.status === "running") {
      if (Date.now() > deadline) throw new Error("Remote shell did not exit")
      await Bun.sleep(10)
    }
    expect((await client.shell.get({ location, id: shell.data.id })).data.exit).toBe(0)
    expect((await client.shell.output({ location, id: shell.data.id })).data.output).toBe("isolated")
  } finally {
    await host.close()
    broker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

const linux = process.env.CLUSTER_TEST_EXECUTOR_URL ? test : test.skip
linux("Linux executor provides binary files and Git over the portable process transport", async () => {
  const spawner = remoteSpawner(authenticatedTransport(process.env.CLUSTER_TEST_EXECUTOR_URL!, "local-test-only"))
  const files = Environment.execDefaults(spawner)
  const root = `/workspace/test-${crypto.randomUUID()}`
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* spawner.string(ChildProcess.make("mkdir", ["-p", root]))
        yield* files.write(`${root}/bytes.bin`, new Uint8Array([0, 255, 42]))
        const read = yield* files.read(`${root}/bytes.bin`)
        yield* spawner.string(ChildProcess.make("git", ["init", "--quiet", root]))
        const git = yield* spawner.string(ChildProcess.make("git", ["status", "--porcelain"], { cwd: root }))
        const leaked = yield* spawner.string(
          ChildProcess.make("sh", ["-c", 'printf "%s" "${EXECUTION_TOKEN:-absent}"']),
        )
        yield* spawner.string(ChildProcess.make("rm", ["-rf", root]))
        return { bytes: read.bytes, git, leaked }
      }),
    ),
  )
  expect(result.bytes).toEqual(new Uint8Array([0, 255, 42]))
  expect(result.git).toContain("?? bytes.bin")
  expect(result.leaked).toBe("absent")
})
