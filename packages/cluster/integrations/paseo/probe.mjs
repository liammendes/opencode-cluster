// Paseo probes its configured command before loading the native v2 HTTP adapter.
// Actual compatibility and authentication are checked against server.info.
if (process.argv.includes("--version")) {
  console.log("2.0.32-cluster.1")
} else {
  console.error("This command is the Paseo remote OpenCode adapter. Configure OPENCODE_REMOTE_URL and OPENCODE_REMOTE_PASSWORD_FILE in Paseo.")
  process.exitCode = 1
}
