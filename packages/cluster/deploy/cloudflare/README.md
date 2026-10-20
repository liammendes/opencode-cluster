# Cloudflare Workers

`wrangler.jsonc` runs the OpenCode server in a SQLite Durable Object. Sessions in
one namespace share that runtime. Linux commands run in a separate container via
the same HTTP process protocol used by the native deployment.

This requires a paid Workers account and access to the current Containers APIs.
The configuration uses the container `images`/`scheduling_policy` schema in
Wrangler 4.151.1. Neither a live deployment nor managed container recovery has
been verified by this project.

From `packages/cluster`:

```sh
bun run test:workerd
bunx wrangler secret put CLUSTER_PASSWORD --config deploy/cloudflare/wrangler.jsonc
bunx wrangler secret put EXECUTION_TOKEN --config deploy/cloudflare/wrangler.jsonc
```

Create the R2 bucket named in the configuration with the required U.S.
jurisdiction. Configure model providers through `OPENCODE_CONFIG_CONTENT`, using
secrets for values containing credentials.

The shipped policy requires U.S. state, artifact and execution residency.
DO/R2 jurisdiction does **not** establish where a container runs.
`EXECUTION_RESIDENCY=unverified` therefore intentionally prevents serving data.
Only change it to `us` after independently qualifying execution placement.
For a deployment whose data has no geographic requirement, explicitly choose
`RESIDENCY=unrestricted`. Local tests use synthetic data with this setting because
workerd does not implement jurisdiction restrictions.

After qualifying the deployment:

```sh
bunx wrangler deploy --config deploy/cloudflare/wrangler.jsonc
```

Alternatively, configure `EXECUTION_URL` to an isolated, durable Linux executor
with the same token. Cloudflare's native container binding is then unused.
Account for private connectivity and authentication; a Cloud Run endpoint
requiring IAM also needs an identity-token transport adapter.

Admission arms an alarm before executing a prompt. Alarms keep pending work
discoverable without relying on the original client connection. Recovery marks
uncertain running work interrupted instead of automatically repeating tool calls.

`POST /cluster/checkpoint` requests a container filesystem snapshot after active
sessions have drained. The snapshot ID is held in the executor's DO storage and
used when its container next starts. Stop incoming work before checkpointing.
Snapshots are explicit, not automatic: edits after the latest snapshot can be
lost on VM loss. Process memory, running commands and network connections do not
survive filesystem restore.

Database export/import uses `/cluster/archive`; back up workspace data separately.
Do not describe a provider VM snapshot as a portable backup.

References:

- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Container APIs](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Limits](https://developers.cloudflare.com/workers/platform/limits/)
