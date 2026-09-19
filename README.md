# fabric-mcp-server

**Microsoft Fabric as an MCP server and as a CLI, from one tool registry.**

- The **MCP server** gives Claude Code, Claude Desktop, or any [Model Context Protocol](https://modelcontextprotocol.io) client typed, permission-gated access to Fabric.
- The **`fabric` CLI** exposes the exact same tools from a shell, so you can pipe large results through `jq` or PowerShell, loop over workspaces in one call, and run unattended from a scheduled task with no model in the loop.

Both talk to the public Fabric REST API (`api.fabric.microsoft.com`), the Power BI REST API (`api.powerbi.com`), and the OneLake DFS endpoint, authenticating with [`@azure/identity`](https://www.npmjs.com/package/@azure/identity).

## Features

- Resolve workspaces, items, pipelines, deployment pipelines, folders, and semantic models by **display name or GUID**.
- Continuation-token paging, HTTP 429 retry (honors `Retry-After`), and long-running-operation polling built in.
- **Read-only by default.** Every mutating tool is gated behind `FABRIC_MCP_MODE=write` on both surfaces and audit-logged to stderr.
- Safety rails on the dangerous operations: `deploy_stage` and `commit_to_git` refuse blanket "everything" runs; `update_item_definition` and `delete_item` snapshot the live definition first for one-call rollback.

## Which surface when

| Situation | Use |
|---|---|
| Ad hoc question in a Claude session, small result | MCP |
| A write operation you want permission-gated per tool by the MCP client | MCP |
| Result is large and you only need a slice (OneLake listing, run history, item definition) | CLI piped through a filter |
| Sweep across many workspaces or items | CLI in one shell call |
| Anything that runs without a model (scheduled task, CI step) | CLI |
| Fabric access from Claude Desktop or another MCP host | MCP |

## Tools

Tool names and parameters are identical on both surfaces. On the CLI, `list_item_runs` is `fabric list-item-runs` (either spelling works) and each parameter is a `--flag`.

| Tool | Mode | Description |
|------|------|-------------|
| `list_workspaces` | read | All workspaces the signed-in identity can see. |
| `list_items` | read | Items in a workspace, optional type filter; includes `folderId`. |
| `list_folders` | read | Workspace folders as a flat list with full paths. |
| `list_workspace_roles` | read | Role assignments on a workspace. |
| `list_sql_databases` | read | SQL databases in a workspace with connection properties. |
| `list_pipelines` | read | Data pipelines in a workspace. |
| `list_pipeline_runs` | read | Run history for a pipeline, most-recent first, optional status filter. |
| `get_pipeline_run` | read | One pipeline run by job instance ID, including `failureReason`. |
| `list_item_runs` | read | **New.** Run history for *any* item type (notebooks, Spark jobs, dataflows), with status/job-type filters. |
| `get_item_run` | read | **New.** One job instance of any item: terminal status, timings, full `failureReason`. |
| `list_schedules` | read | Job schedules on an item, including each schedule's `owner` (spot ownership drift). |
| `execute_dax` | read | Read-only DAX query against a semantic model (Power BI `executeQueries`). |
| `get_refresh_history` | read | Recent refresh history for a semantic model. |
| `get_dataset_datasources` | read | **New.** Power BI data sources of a model with gateway binding (`gatewayId`/`datasourceId`, `bound`). |
| `get_item_connections` | read | **New.** Fabric connections an item is bound to; `connectivityType: Automatic` means unbound. |
| `get_git_status` | read | Items changed between the workspace and its Git branch, plus `workspaceHead` / `remoteCommitHash`. |
| `get_item_definition` | read | Definition parts of an item (TMDL, notebook, report). Manifest by default; decoded content for one part. |
| `list_deployment_pipelines` | read | Deployment pipelines the identity can see. |
| `list_deployment_stages` | read | Stages of a deployment pipeline; optionally a stage's items for `deploy_stage`. |
| `list_onelake` | read | Files/tables under an item in OneLake via the DFS API. |
| `read_onelake_file` | read | Read a small OneLake file as text, size-capped. |
| `add_workspace_role` | **write** | Grant a principal a workspace role. |
| `create_folder` / `move_item` / `delete_folder` | **write** | Workspace folder management. |
| `run_pipeline` / `cancel_pipeline_run` | **write** | Trigger or cancel a pipeline run; `run_pipeline` now returns `jobInstanceId`. |
| `run_notebook` | **write** | Run a notebook and wait, or detach with `wait=false`. **Changed:** pass `job_instance_id` to attach to an existing run instead of starting another. |
| `create_schedule` / `update_schedule` / `delete_schedule` | **write** | Schedule management. |
| `refresh_dataset` | **write** | Trigger an on-demand semantic model refresh. |
| `bind_dataset_to_gateway` | **write** | **New.** Power BI `BindToGateway`: fixes the "default data connection without explicit credentials" refresh failure after a git sync. |
| `takeover_item` | **write** | **New.** Power BI `TakeOver` for a semantic model or paginated report; unblocks `NotPaginatedReportOwner` deploy errors. |
| `bind_semantic_model_connection` | **write** | **New.** Fabric `bindConnection`: explicit `connection_id` + type + path, or `copy_from` a bound sibling model in the same workspace. Every deployment-pipeline leg resets these bindings. |
| `update_from_git` | **write** | Pull repo into workspace. **Changed:** `conflict_policy` (PreferRemote default, PreferWorkspace to re-baseline) and `wait`. |
| `commit_to_git` | **write** | **New.** Commit workspace items to Git. Selective by item name/GUID; `mode=All` is an explicit opt-in. |
| `update_item_definition` | **write** | Deploy a definition from a local folder, snapshotting the live one first. |
| `create_item` / `delete_item` | **write** | Create (optionally from a definition) or delete an item, with best-effort snapshot. |
| `refresh_sql_endpoint_metadata` | **write** | **New.** Force a lakehouse SQL analytics endpoint to re-sync table metadata now, optionally scoped to tables or with `recreate_tables`. |
| `deploy_stage` | **write** | Selective stage-to-stage deployment; explicit item list required. |

## Requirements

- Node.js >= 20
- An Entra identity with access to the target workspaces.
- For `execute_dax`: **Build** permission on the semantic model and the tenant's **"Dataset Execute Queries REST API"** setting enabled.
- For `bind_semantic_model_connection`: the caller must own the model (`takeover_item` first if not).

## Install

```bash
git clone <this-repo-url> fabric-mcp-server
cd fabric-mcp-server
npm install
npm link        # optional: puts `fabric` and `fabric-mcp-server` on your PATH
```

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)). Both surfaces read the same variables.

| Variable | Required | Purpose |
|----------|----------|---------|
| `FABRIC_AUTH_MODE` | no (default `interactive`) | `interactive`, `device-code`, `cli`, `azure-powershell`, `service-principal`, `managed-identity`, or `default`. |
| `AZURE_TENANT_ID` | for interactive / device-code / service-principal | Entra tenant ID. |
| `AZURE_CLIENT_ID` | for service-principal | App registration client ID. |
| `AZURE_CLIENT_SECRET` | for service-principal | App registration secret. |
| `FABRIC_MCP_MODE` | no (default `read`) | `read` or `write`. Gates the write tools on **both** surfaces. |
| `FABRIC_TOKEN_CACHE` | no | `memory` (MCP default) or `persistent` (CLI default). Persistent uses the OS secure store so each CLI process reuses the last sign-in. |
| `FABRIC_TOKEN_CACHE_NAME` | no | Cache partition name (default `fabric-mcp-server`). |

### Auth modes

- **interactive** — opens a browser; best for desktop/AVD. With the persistent cache, the CLI signs in once and then runs silently.
- **device-code** — prints a code + URL to stderr; for SSH / WSL / headless.
- **cli** — reuses your `az login` session.
- **azure-powershell** — reuses your `Connect-AzAccount` session.
- **service-principal** — non-interactive; the right choice for scheduled tasks.
- **managed-identity** — for hosting on Azure.
- **default** — tries env → managed identity → CLI → browser in turn.

## Use as an MCP server

Add to your MCP client config (`~/.claude.json` for Claude Code, `claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "fabric": {
      "command": "node",
      "args": ["/absolute/path/to/fabric-mcp-server/index.js"],
      "env": {
        "FABRIC_AUTH_MODE": "interactive",
        "AZURE_TENANT_ID": "<your-entra-tenant-id>"
      }
    }
  }
}
```

Add `"FABRIC_MCP_MODE": "write"` to the `env` block to expose the write tools. Existing v1.x client configs keep working unchanged.

## Use as a CLI

```bash
fabric tools                                  # every tool with its mode
fabric help list-item-runs                    # a tool's flags
fabric list-workspaces
fabric list-item-runs --workspace BI-Prod --item brz_nb_clean --status Failed --top 5
fabric get-item-definition --workspace BI-Prod --item "Sales Model" --out sales-model.json
```

Conventions:

- Flags mirror tool parameters; `--job_instance_id` and `--job-instance-id` are equivalent.
- Object and array parameters take inline JSON or `@path/to/file.json`. String arrays also take comma-separated values: `--items "Notebook A,Notebook B"`.
- Booleans: `--wait`, `--wait=false`, `--no-wait`.
- Output is JSON on stdout. `--compact` for one line, `--out <file>` to write to disk and print a short receipt instead.
- Exit codes: `0` success, `1` the tool failed (message on stderr), `2` usage problem.
- Write tools need `FABRIC_MCP_MODE=write` in the environment. The CLI will not accept it as a flag, so the same safety property holds on both surfaces.

### Filtering large results in the shell

The point of the CLI is that filtering happens before anything reaches a model or your eyes.

```powershell
# Which tables in the lakehouse have not been written today?
fabric list-onelake --workspace BI-Prod --item Bronze --directory Tables/dbo |
  ConvertFrom-Json | Select-Object -Expand paths |
  Where-Object { [datetime]$_.lastModified -lt (Get-Date).Date } |
  Select-Object name, lastModified
```

```bash
# Failed runs across every pipeline in a workspace, last 24 hours
fabric list-pipelines --workspace BI-Prod | jq -r '.pipelines[].displayName' | while read -r p; do
  fabric list-pipeline-runs --workspace BI-Prod --pipeline "$p" --status Failed --top 5 --compact |
    jq -c --arg p "$p" '.runs[] | select(.startTimeUtc > (now - 86400 | todate)) | {pipeline: $p, startTimeUtc, failureReason}'
done
```

### Scheduled tasks

Use `service-principal` auth (or seed the persistent cache with one interactive sign-in under the task's account) and `FABRIC_MCP_MODE=write` only when the task needs it.

```powershell
# Morning health check written to a share, no model involved
$env:FABRIC_AUTH_MODE = "service-principal"
fabric list-pipeline-runs --workspace BI-Prod --pipeline Nightly-Load --status Failed --top 3 --compact |
  Set-Content "\\share\reports\fabric-health-$(Get-Date -f yyyyMMdd).json"
```

## Deployment recipes the new tools cover

**Semantic model promoted through a deployment pipeline will not refresh.** Every leg resets its connections to `Automatic`.

```
get_item_connections   (target model)  -> confirm paths point at the target stage, unboundCount > 0
bind_semantic_model_connection copy_from=<a bound model in the same workspace>
refresh_dataset
```

**Git-synced model fails with "default data connection without explicit credentials".**

```
get_dataset_datasources (a working sibling) -> gatewayId + datasourceId values
bind_dataset_to_gateway  gateway_id=... datasource_ids=[...]
```

**Notebook just wrote to a lakehouse but the SQL endpoint still shows the old schema.**

```
refresh_sql_endpoint_metadata --workspace W --item Lakehouse --tables dbo.lp_waterusage
```

**Commit one item from a workspace with other people's dirty items.**

```
get_git_status   -> see what is dirty
commit_to_git    items=["my_notebook"] comment="..."   (Selective; nothing else moves)
```

## Development

```bash
npm test          # node --test: registry, CLI arg mapping, helpers, polling
```

Tools live in `src/tools/*.js` as plain `{ name, description, mode, schema, handler }` objects. `src/mcp/register.js` wraps them for MCP; `src/cli/main.js` maps each schema field to a flag. Adding a tool means adding one object; both surfaces pick it up.

## Security notes

- No secrets are stored in the repo. Credentials come from environment variables at runtime; `.env` is git-ignored.
- Write tools are only registered (MCP) or runnable (CLI) under `FABRIC_MCP_MODE=write`, and each logs an `[AUDIT]` line to stderr.
- The persistent token cache uses the OS secure store via `@azure/identity-cache-persistence`. If the native module is unavailable the process falls back to the in-memory cache and says so on stderr.
- `list_onelake` / `read_onelake_file` use the Azure Storage token audience; the same credential acquires it.
- `execute_dax` uses the Power BI `executeQueries` API, which only runs read-only DAX.

## License

[MIT](LICENSE)
