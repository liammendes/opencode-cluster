# Paseo connection to a remote cluster

This small, version-checked overlay lets Paseo 0.12.0 use its native OpenCode v2 adapter with an existing HTTPS cluster. It does not start an OpenCode process for each agent. Releasing a Paseo connection closes its HTTP requests; the remote server stays running.

You need Paseo **0.12.0**, Node.js, a working HTTPS cluster, and an executor
workspace visible at the same path on the Paseo host. The overlay is specific to
this Paseo version.

Install Paseo into a directory owned by your daemon user. From the repository root:

```sh
npm install --prefix "$HOME/.local/share/paseo-cluster" @getpaseo/cli@0.12.0
node packages/cluster/integrations/paseo/install.mjs \
  "$HOME/.local/share/paseo-cluster/node_modules/@getpaseo/server"
```

Merge this provider into Paseo's `agents.providers` configuration. Replace both
absolute paths and the hostname; do not replace the whole Paseo config:

```json
{
  "opencode": {
    "enabled": true,
    "command": ["node", "/ABSOLUTE_PATH/opencode-cluster/packages/cluster/integrations/paseo/probe.mjs"],
    "env": {
      "OPENCODE_REMOTE_URL": "https://your-cluster.example",
      "OPENCODE_REMOTE_PASSWORD_FILE": "/private/path/cluster-password"
    }
  }
}
```

Keep the password file readable only by the daemon user (`chmod 600`). It contains
only the cluster password. Model credentials remain in the cluster.

Restart the Paseo daemon that owns this configuration. Create one agent in a
test workspace and ask it to write and read a file. Check the cluster worker logs
if it stays queued. Check the password and URL if Paseo reports authentication
or connection errors.

Paseo and the remote executor must see the same workspace paths. Mount the workspace directory at the same absolute path on the executor.

The overlay disables Paseo's local plugin bridge for this provider: its loopback callback cannot reach a remote server. Native OpenCode shell and file tools work through the cluster executor. Paseo-specific tools and per-session process environment or MCP overrides need a separate remote bridge and are not supported by this overlay. Configure shared MCP servers in the cluster deployment.

The installer checks the exact Paseo version and patch points, preserves original files, and can be reapplied safely. Upgrading Paseo requires reviewing and replaying this small overlay, rather than carrying a complete Paseo fork.
