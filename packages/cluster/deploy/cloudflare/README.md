# Deploy on Cloudflare Workers

This profile runs the OpenCode API and agent runtime in a SQLite Durable Object. A separate Linux executor runs shell, file and Git tools. It needs no Google Cloud services.

**One namespace uses one Durable Object runtime.** This profile does not spread a single namespace across hundreds of Workers. Choose the [native profile](../README.md) for the PostgreSQL worker pool and its capacity controls.

Local workerd tests cover sessions, restart, state export/import and an agent using a synthetic model. Managed Cloudflare Containers and their recovery have not been qualified in a live deployment.

## Before you start

You need:

- A checkout of this fork, Bun 1.4.2 and the repository dependencies.
- A paid Workers account with SQLite Durable Objects.
- Access to the current Cloudflare Containers API for the supplied configuration.
- A model provider account and API key.

The configuration is pinned to Wrangler 4.151.1 and uses its `images` and `scheduling_policy` container fields. Do not replace the pinned CLI with an older global Wrangler.

From the repository root:

```sh
bun install --frozen-lockfile
cd packages/cluster
bun run test:workerd
```

A local test pass does not establish your account's container availability or data residency.

## 1. Choose where tools run

| Choice                  | Configuration                                               | Workspace storage                             |
| ----------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| Cloudflare Container    | Keep the `containers` section; leave `EXECUTION_URL` unset. | Container filesystem with explicit snapshots. |
| Your own Linux executor | Set `EXECUTION_URL` to its reachable HTTPS address.         | A persistent volume you manage.               |

Both use the same process protocol and `EXECUTION_TOKEN`. With an external executor, the native container binding is unused. The supplied file still declares container resources; remove its `containers` section if you only want the external executor, while retaining both Durable Object bindings and their migrations.

The executor must be reachable from the Worker. An ordinary private VPC IP is not enough. Keep its token authentication enabled; an endpoint that also requires cloud IAM needs a corresponding identity-token transport.

## 2. Review the deployment settings

Edit `deploy/cloudflare/wrangler.jsonc` for your account. Choose a Worker name, a unique R2 bucket name and a `CLUSTER_NAMESPACE`. A namespace represents one trusted installation.

The supplied configuration requires U.S. residency and leaves `EXECUTION_RESIDENCY=unverified`. This deliberately blocks requests until execution placement is established.

- If U.S. residency is required, keep `RESIDENCY=us`, create the R2 bucket with U.S. jurisdiction, and verify the executor's placement before setting `EXECUTION_RESIDENCY=us`.
- If your data has no geographic restriction, explicitly set `RESIDENCY=unrestricted`.

A Durable Object or R2 jurisdiction does not prove where a container executes. Choose an external executor with a verified location if the managed container cannot meet your requirement.

Create the R2 bucket named in the configuration. The binding is available to the object-storage adapter; automatic backups are not implemented.

## 3. Add secrets and model configuration

Generate different random values for the API password and executor token. These commands prompt for each value:

```sh
bunx wrangler secret put CLUSTER_PASSWORD --config deploy/cloudflare/wrangler.jsonc
bunx wrangler secret put EXECUTION_TOKEN --config deploy/cloudflare/wrangler.jsonc
bunx wrangler secret put OPENCODE_CONFIG_CONTENT --config deploy/cloudflare/wrangler.jsonc
```

For `OPENCODE_CONFIG_CONTENT`, paste a complete OpenCode v2 JSON object with your model provider configuration. The [native guide](../README.md#2-create-local-secrets) includes an OpenAI-compatible example.

The API password authenticates clients. Model keys authenticate the provider. Shared remote MCP configuration belongs in this JSON; local desktop MCP processes will not appear in a Worker.

## 4. Deploy and verify

After completing the residency settings:

```sh
bunx wrangler deploy --config deploy/cloudflare/wrangler.jsonc
```

Use the HTTPS address printed by Wrangler, or configure a custom domain. Verify authentication:

```sh
curl -I https://YOUR_CLUSTER_HOST/api/info
curl --fail --user opencode https://YOUR_CLUSTER_HOST/api/info
```

Expect `401` without a password and server information with the correct password. If the request fails before reaching the API, check the residency settings and Worker logs.

Create a session with location `/workspace` using the [native API example](../README.md#4-check-shared-state). Then set `OPENCODE_PASSWORD` privately and connect:

```sh
opencode --server https://YOUR_CLUSTER_HOST --session SESSION_ID
```

Ask the agent to write and read a small file. This checks the provider, executor and workspace together. An API health check alone does not prove tool execution works.

## Recovery and backups

Prompt admission sets a Durable Object alarm so queued work remains discoverable after the client disconnects. Recovery reports uncertain running work as interrupted instead of automatically replaying tool calls.

To snapshot a managed container, stop new work and let active sessions finish:

```sh
curl --fail --user opencode -X POST https://YOUR_CLUSTER_HOST/cluster/checkpoint
```

The response contains a snapshot ID. The executor stores it and uses it on its next container start. Snapshots are explicit: edits since the last snapshot can be lost. Running commands, memory and network connections do not survive restoration.

For an external executor, `/cluster/checkpoint` returns `501`; back up its volume through your storage provider.

Use authenticated `/cluster/archive` for database export/import, following the [archive guide](../../../../CLUSTER.md#export-and-import). Archives omit credential values and workspace files. Restore those separately.

## Limits and troubleshooting

| Symptom                                       | Next step                                                           |
| --------------------------------------------- | ------------------------------------------------------------------- |
| Requests fail on residency checks             | Verify placement, then set the policy explicitly.                   |
| Container does not become ready               | Check account access, image build, startup logs and port `8081`.    |
| Tools return `401`                            | Check that Worker and executor use the same token.                  |
| Prompts fail at the model                     | Check provider configuration, key and quota.                        |
| A workspace edit disappears after replacement | Restore your latest filesystem backup; snapshots are not automatic. |

Cloudflare runtime limits, the single namespace runtime and executor resources all constrain capacity. The native CPU/RAM controller does not apply to this profile.

See Cloudflare's [Durable Objects documentation](https://developers.cloudflare.com/durable-objects/), [container API](https://developers.cloudflare.com/containers/api/durable-object-container/), and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) before selecting it for a workload.
