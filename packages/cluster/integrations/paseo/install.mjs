import { readFile, writeFile, copyFile, access } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(process.argv[2] ?? "")
const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
if (packageInfo.name !== "@getpaseo/server" || packageInfo.version !== "0.12.0")
  throw new Error("This overlay supports @getpaseo/server 0.12.0. Review it before upgrading.")
const provider = join(root, "dist/server/server/agent/providers/opencode")
const directory = dirname(fileURLToPath(import.meta.url))
const edits = [
  {
    path: join(provider, "v2/runtime.js"),
    before: "    async start(env = {}) {\n",
    after: `    async start(env = {}) {
        if (this.options.settings?.env?.OPENCODE_REMOTE_URL) {
            const unsupported = Object.keys(env).filter((key) => !["PASEO_AGENT_ID", "PASEO_AGENT_CWD"].includes(key));
            if (unsupported.length) throw new Error("Remote OpenCode cannot accept process environment overrides");
            const generation = await createRemoteGeneration(this.options.settings.env);
            this.generations.add(generation);
            return generation;
        }
`,
    prefix: 'import { createRemoteGeneration } from "./remote-generation.mjs";\n',
  },
  {
    path: join(provider, "runtime-client.js"),
    before: "                bridge: this.options.bridge,",
    after: "                bridge: this.settings?.env?.OPENCODE_REMOTE_URL ? undefined : this.options.bridge,",
    prefix: "",
  },
  {
    path: join(provider, "v2/agent.js"),
    before: "            await session.initialize(launch?.env",
    after: "            await session.initialize(!this.options.settings?.env?.OPENCODE_REMOTE_URL && launch?.env",
    prefix: "",
  },
]
// Validate all targets before changing any target. Keep the original installation recoverable.
const changes = await Promise.all(edits.map(async (edit) => {
  const current = await readFile(edit.path, "utf8")
  if (current.includes(edit.after)) return { ...edit, current, updated: current }
  if (current.split(edit.before).length !== 2)
    throw new Error(`Paseo patch point changed: ${edit.path}`)
  return { ...edit, current, updated: edit.prefix + current.replace(edit.before, () => edit.after) }
}))
await copyFile(join(directory, "remote-generation.mjs"), join(provider, "v2/remote-generation.mjs"))
for (const change of changes) {
  if (change.updated === change.current) continue
  const backup = change.path + ".opencode-cluster-original"
  if (await access(backup).then(() => true, () => false))
    throw new Error(`Refusing to replace an existing original backup: ${backup}`)
  await copyFile(change.path, backup)
  await writeFile(change.path, change.updated)
}
console.log("Installed the OpenCode cluster connection overlay for Paseo 0.12.0")
