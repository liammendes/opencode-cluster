# Run opencode-cluster with Docker

Start here to try the cluster on a laptop or a Linux server. You will run PostgreSQL, two API replicas, an execution worker and a separate container for shell and file tools.

This guide is for one trusted installation. Read the [current limits](../../../CLUSTER.md#current-limits) before putting important work on it.

## Before you start

You need Git and Docker with Compose v2. On macOS, OrbStack is supported. Allow enough memory for several containers: the database and executor need resources as well as the agent runtime.

Use an OpenCode **v2.0.32** client for this release. Model calls also need a provider account and API key. You can check shared storage before adding a model key.

## 1. Clone the fork

```sh
git clone --branch cluster-v2.0.32 https://github.com/liammendes/opencode-cluster.git
cd opencode-cluster
```

Run the remaining commands from this directory.

## 2. Create local secrets

```sh
umask 077
cp packages/cluster/deploy/.env.example packages/cluster/deploy/.env
```

Edit `packages/cluster/deploy/.env`. Give the first three settings different random values. Generate each value with `openssl rand -hex 32`. The file is ignored by Git; keep it private.

| Setting                   | Purpose                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`       | Database password. Use hex characters so the Compose URL needs no extra escaping. |
| `CLUSTER_PASSWORD`        | Password for OpenCode and Paseo clients.                                          |
| `EXECUTION_TOKEN`         | Token for the tool executor.                                                      |
| `OPENCODE_CONFIG_CONTENT` | One line of OpenCode v2 JSON, shared by API and workers. Starts as `{}`.          |

For an OpenAI-compatible provider, the configuration has this shape. Replace the uppercase examples with your provider's values, then put the JSON on one line in the environment file:

```json
{
  "model": "custom/MODEL_ID",
  "providers": {
    "custom": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://PROVIDER_HOST/v1",
        "apiKey": "PROVIDER_API_KEY"
      },
      "models": { "MODEL_ID": {} }
    }
  }
}
```

Treat configuration containing a key as a secret. On a hosted deployment, use its secret manager. A copied local config needs adjustment if it refers to local files, plugins or desktop MCP servers.

## 3. Start the services

```sh
docker compose --env-file packages/cluster/deploy/.env \
  -f packages/cluster/deploy/compose.yaml up --build -d --scale api=2
docker compose --env-file packages/cluster/deploy/.env \
  -f packages/cluster/deploy/compose.yaml ps
```

The first build downloads dependencies. Wait until PostgreSQL is healthy and the API and worker containers are running. Find the API ports:

```sh
docker compose --env-file packages/cluster/deploy/.env \
  -f packages/cluster/deploy/compose.yaml port --index 1 api 8080
docker compose --env-file packages/cluster/deploy/.env \
  -f packages/cluster/deploy/compose.yaml port --index 2 api 8080
```

Both ports bind to `127.0.0.1`. PostgreSQL and the executor have no published host ports.

## 4. Check shared state

Set the addresses to the ports printed above:

```sh
export API_A=http://127.0.0.1:PORT_A
export API_B=http://127.0.0.1:PORT_B
curl --fail --user opencode "$API_A/api/info"
curl --fail --user opencode -H 'Content-Type: application/json' \
  -d '{"title":"Shared state check","location":{"directory":"/workspace"}}' \
  "$API_A/api/session"
```

Curl prompts for `CLUSTER_PASSWORD`. Copy the returned `data.id`, then read it through the second API:

```sh
curl --fail --user opencode "$API_B/api/session/SESSION_ID"
```

The title and ID should match. This checks shared storage; it does not test a model or a tool.

## 5. Connect OpenCode

Set `OPENCODE_PASSWORD` to the cluster password in a private shell environment, then run:

```sh
opencode --server "$API_A" --session SESSION_ID
```

Use the session created above so its working directory is `/workspace` in the executor. A positional command-line directory refers to the client machine; it does not upload that directory.

Ask the agent to create a small file in `/workspace`, read it back, and report its contents. This checks the model and executor together. Workspace files persist in the Compose `workspace` volume.

For remote clients, first put an HTTPS reverse proxy in front of the API. Keep password authentication enabled. See the [Paseo setup](../integrations/paseo/README.md) for Paseo 0.12.0.

## Add execution workers

Each native worker admits four top-level session families by default. To run two workers:

```sh
docker compose --env-file packages/cluster/deploy/.env \
  -f packages/cluster/deploy/compose.yaml up -d --scale api=2 --scale worker=2
```

Workers claim different session families through PostgreSQL. Child agents stay with their parent's worker. Four workers provide 16 top-level slots with the default setting; nested agents can add work inside those families.

Compose does not automatically change the worker count. The [Cloud Run guide](gcp/README.md) includes a controller for queue depth, CPU and RAM. Other hosts can implement the same capacity-provider interface.

## Stop and back up

Stop without deleting volumes:

```sh
docker compose --env-file packages/cluster/deploy/.env \
  -f packages/cluster/deploy/compose.yaml down
```

Do not add `--volumes` unless you intend to delete the database and workspace. Back up both: a session archive does not contain workspace files. See [export and import](../../../CLUSTER.md#export-and-import).

## Troubleshooting

| Problem                                  | What to check                                                         |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `401 Unauthorized`                       | Use username `opencode` and the API's `CLUSTER_PASSWORD`.             |
| Prompts remain queued                    | Check worker logs, database connectivity and worker capacity.         |
| Model request fails                      | Check the provider URL, model ID, key and quota.                      |
| File or shell tool fails                 | Check the executor, its token and the session's remote directory.     |
| `501` from a terminal or Git UI endpoint | That endpoint is outside this profile. Use the supported shell tools. |

Read worker logs with:

```sh
docker compose --env-file packages/cluster/deploy/.env \
  -f packages/cluster/deploy/compose.yaml logs --tail=100 worker
```

Logs may contain prompts and paths. Redact them before sharing.
