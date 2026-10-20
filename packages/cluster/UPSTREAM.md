# Upstream maintenance

Base: `anomalyco/opencode` tag **v2.0.32**,
commit **843a6c514e606b436a7fe713422ace0a93ad3d61**.

The fork retains upstream Git history. `packages/cluster` holds the adapter
implementation; the small upstream hooks are in:

- `packages/core/src/bus.ts`: subscribe to externally committed events.
- `packages/core/src/session/execution/restart.ts`: configurable recovery policy and recovery scoped to a session family.
- `packages/core/src/environment/environment.ts` and `packages/core/src/shell.ts`: execution-host shell defaults that keep control-plane credentials out of remote commands.
- `packages/server/src/routes.ts`: expose the execution service to embedders.

Keep hooks and adapters in separate commits. On a clean checkout, create a new
release branch and replay the cluster commits:

```sh
git remote add upstream https://github.com/anomalyco/opencode.git
# If the remote already exists, keep it.
git fetch upstream --tags
git switch -c cluster-vNEXT cluster-v2.0.32
git rebase --onto vNEXT 843a6c514e606b436a7fe713422ace0a93ad3d61
```

Replace `vNEXT` with a reviewed upstream tag. Git stops on conflicts; review them,
then `git add` the resolved paths and `git rebase --continue`. Use
`git rebase --abort` to return to the new branch's starting point.

After the rebase:

1. Check the session admission, execution claim and durable-event contracts.
2. Check runtime imports under both Bun and `workerd`.
3. Audit upstream schema changes before changing the archive version. Do not
   merely update its pinned version string and assume migration compatibility.
4. Install the pinned dependencies and run the full root check.
5. Run cluster tests against real PostgreSQL, workerd and the Linux executor;
   run affected upstream session/bus/server tests.
6. Update this base commit, release notes, compatibility matrix and measurements.
7. Push the **new** release branch and open a pull request. Never rewrite the
   published stable branch to hide rebase conflicts or failed checks.

When practical, contribute the small embedding hooks upstream. Adapters should
remain outside OpenCode's core package; avoid copying the native agent loop.
