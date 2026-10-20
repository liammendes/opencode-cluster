import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { createBroker } from "../src/execution/broker"
import { remoteSpawner } from "../src/execution/spawner"
import { requireResidency } from "../src/contracts"
import { authenticatedTransport } from "../src/execution/protocol"
import { Environment } from "@opencode/core/environment/index"

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
