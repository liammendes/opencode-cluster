import path from "node:path"
import { Effect, Layer, Option, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Environment } from "@opencode/core/environment/index"
import { FileSystem } from "@opencode/core/filesystem"
import { Location } from "@opencode/core/location"
import { AbsolutePath, RelativePath } from "@opencode/schema/schema"
import { remoteSpawner } from "./spawner"
import type { Transport } from "./protocol"

export function executionLayers(transport: Transport) {
  const spawner = remoteSpawner(transport)
  const files = Environment.execDefaults(spawner)
  const filesystem = makeLocationNode({
    service: FileSystem.Service,
    deps: [Location.node],
    layer: Layer.effect(
      FileSystem.Service,
      Effect.gen(function* () {
        const location = yield* Location.Service
        const absolute = (name: string) => path.posix.resolve(location.directory, name)
        const missing = (name: string) => new FileSystem.NotFoundError({ path: RelativePath.make(name) })
        return FileSystem.Service.of({
          read: ({ path: name }) =>
            files.read(absolute(name)).pipe(
              Effect.mapError(() => missing(name)),
              Effect.map(({ bytes, info }) => ({
                mime: "application/octet-stream",
                size: info.size,
                mtime: info.mtimeMs === undefined ? Option.none() : Option.some(new Date(info.mtimeMs)),
                stream: (options) =>
                  Stream.make(
                    bytes.slice(
                      options?.offset ?? 0,
                      options?.bytesToRead === undefined ? undefined : (options.offset ?? 0) + options.bytesToRead,
                    ),
                  ),
              })),
            ),
          list: (input) =>
            files.list(absolute(input?.path ?? ".")).pipe(
              Effect.mapError(() => missing(input?.path ?? ".")),
              Effect.map((entries) =>
                entries.flatMap((entry) =>
                  entry.type === "file" || entry.type === "directory"
                    ? [{ path: RelativePath.make(path.posix.join(input?.path ?? "", entry.name)), type: entry.type }]
                    : [],
                ),
              ),
            ),
          write: (input) =>
            files
              .write(absolute(input.path), input.data)
              .pipe(Effect.orDie, Effect.as({ path: AbsolutePath.make(absolute(input.path)) })),
          find: (input) =>
            spawner
              .string(
                ChildProcess.make(
                  "find",
                  [
                    ".",
                    "-name",
                    ".git",
                    "-prune",
                    "-o",
                    "-name",
                    "node_modules",
                    "-prune",
                    "-o",
                    "-type",
                    input.type === "directory" ? "d" : "f",
                    "-print0",
                  ],
                  { cwd: location.directory },
                ),
              )
              .pipe(
                Effect.orDie,
                Effect.map((text) =>
                  text
                    .split("\0")
                    .filter(Boolean)
                    .map((name) => name.replace(/^\.\//, ""))
                    .filter((name) => name.includes(input.query))
                    .slice(0, input.limit ?? 100)
                    .map((name) => ({ path: RelativePath.make(name), type: input.type ?? "file" })),
                ),
              ),
        })
      }),
    ),
  })
  return [
    CrossSpawnSpawner.node.replace(Layer.succeed(ChildProcessSpawner, spawner)),
    Environment.node.replace(Layer.succeed(Environment.Service, { spawner, files })),
    FileSystem.node.replace(filesystem),
  ] as const
}
