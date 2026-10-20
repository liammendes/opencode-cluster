import { Effect, PlatformError, Sink, Stream } from "effect"
import { ChildProcess } from "effect/process"
import {
  ExitCode,
  make,
  makeHandle,
  ProcessId,
  type ChildProcessHandle,
  type ChildProcessSpawner,
} from "effect/process/ChildProcessSpawner"
import type { Transport } from "./protocol"

/** Streaming process RPC. The same transport works over private HTTP or a DO stub. */
export function remoteSpawner(transport: Transport): ChildProcessSpawner["Service"] {
  const failure = (cause: unknown) =>
    PlatformError.systemError({
      _tag: "Unknown",
      module: "ClusterExecution",
      method: "spawn",
      cause,
      description: "Remote execution failed; an uncertain spawn is never retried automatically",
    })
  const request = (path: string, method = "GET", body?: BodyInit) =>
    Effect.tryPromise({
      try: async () => {
        const response = await transport(new Request(`http://execution${path}`, { method, body }))
        if (!response.ok) throw new Error(`Execution RPC ${response.status}: ${await response.text()}`)
        return response
      },
      catch: failure,
    })
  const spawn: ChildProcessSpawner["Service"]["spawn"] = (command) =>
    Effect.gen(function* () {
      if (command._tag === "PipedCommand") {
        if (
          command.right._tag !== "StandardCommand" ||
          command.options.to?.startsWith("fd") ||
          command.options.from?.startsWith("fd")
        )
          return yield* Effect.fail(failure("Nested/custom-fd pipelines are unsupported"))
        const left = yield* spawn(command.left)
        const input =
          command.options.from === "stderr" ? left.stderr : command.options.from === "all" ? left.all : left.stdout
        return yield* spawn(
          ChildProcess.make(command.right.command, command.right.args, { ...command.right.options, stdin: input }),
        )
      }
      if (Object.keys(command.options.additionalFds ?? {}).length)
        return yield* Effect.fail(failure("Additional file descriptors are unsupported"))
      const id = crypto.randomUUID()
      yield* request(
        "/process",
        "POST",
        JSON.stringify({
          id,
          command: command.command,
          args: command.args,
          cwd: command.options.cwd,
          env: command.options.env,
          extendEnv: command.options.extendEnv,
          shell: command.options.shell,
        }),
      )
      const kill = () => request(`/process/${id}`, "DELETE").pipe(Effect.asVoid)
      yield* Effect.addFinalizer(() => kill().pipe(Effect.ignore))
      const output = (name: string) =>
        request(`/process/${id}/${name}`).pipe(
          Effect.map((response) =>
            response.body
              ? Stream.fromReadableStream({ evaluate: () => response.body!, onError: failure })
              : Stream.empty,
          ),
          Stream.unwrap,
        )
      const stdout = output("stdout")
      const stderr = output("stderr")
      const stdin = Sink.forEach((bytes: Uint8Array) =>
        request(`/process/${id}/stdin`, "POST", new Uint8Array(bytes).buffer).pipe(Effect.asVoid),
      )
      const input = command.options.stdin
      const config = input && typeof input === "object" && "stream" in input ? input : undefined
      const stream = config ? config.stream : input
      if (stream && typeof stream !== "string" && Stream.isStream(stream))
        yield* Stream.run(stream, stdin).pipe(
          Effect.ensuring(
            config?.endOnDone === false ? Effect.void : request(`/process/${id}/stdin`, "DELETE").pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        )
      if (stream === "ignore") yield* request(`/process/${id}/stdin`, "DELETE")
      const result = request(`/process/${id}/result`).pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({ try: () => response.json() as Promise<{ code: number }>, catch: failure }),
        ),
      )
      const handle: ChildProcessHandle = makeHandle({
        pid: ProcessId(0),
        stdout,
        stderr,
        all: Stream.merge(stdout, stderr),
        stdin,
        exitCode: result.pipe(Effect.map((result) => ExitCode(result.code))),
        isRunning: request(`/process/${id}/running`).pipe(
          Effect.flatMap((response) =>
            Effect.tryPromise({ try: () => response.json() as Promise<boolean>, catch: failure }),
          ),
        ),
        kill,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      })
      return handle
    })
  return make(spawn)
}
