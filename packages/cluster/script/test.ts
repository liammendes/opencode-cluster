import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Start isolation before importing core: config paths are captured at module load.
const root = await mkdtemp(path.join(tmpdir(), "opencode-cluster-test-"))
const config = path.join(root, "config")
await mkdir(config)
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/^(?:OPENCODE_|XDG_|AWS_|AZURE_|GOOGLE_|GCP_|GCLOUD_|VERTEX_|OPENAI_|ANTHROPIC_|GEMINI_|XAI_|CLOUDFLARE_|CF_)/i.test(
        name,
      ) && !/(?:^|_)(?:API_KEY|AUTHORIZATION|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(name),
  ),
)
try {
  const child = Bun.spawn([process.execPath, "test", ...process.argv.slice(2)], {
    env: {
      ...env,
      OPENCODE_TEST_HOME: root,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_CONFIG_CONTENT: "{}",
    },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  process.exitCode = await child.exited
} finally {
  await rm(root, { recursive: true, force: true })
}
