# Publish a project page

This optional Cloudflare Worker serves a static project page. It is separate from
your cluster API: it contains no credentials, private origin or API proxy.
Unrecognized routes, including `/api/info`, return `404`.

## Deploy your own page

Before publishing, replace the personal footer logo and links in `landing.html`
and `liammendes.svg`. Keep the wordmark's included font license.

From this directory, with Node.js and npm installed:

```sh
npm ci
export CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID
export CLUSTER_DOMAIN=cluster.example.com
export CLUSTER_CANONICAL_ORIGIN=https://cluster.example.com
export CLUSTER_DOMAIN_ALIASES=opencode.example.com,oc-cluster.example.com
npm run deploy
```

Sign in to Cloudflare before deploying. The domains must belong to zones in that
account. Omit `CLUSTER_DOMAIN_ALIASES` if you only want one hostname.

The canonical origin must use HTTPS and have no trailing slash. Alias requests
receive a permanent `308` redirect to that origin, preserving their path and
query. The build embeds the HTML, CSS, wordmark and footer logo.

## Verify

Check that the main page returns `200`, an alias returns `308` with the expected
`Location`, and `/api/info` on the canonical host returns `404`.

Configure OpenCode and Paseo with your separate authenticated API hostname.
