# fabric-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Microsoft Fabric**. It gives an MCP client (Claude Code, Claude Desktop, etc.) read access to Fabric workspaces, items, pipeline run history, job schedules, deployment pipelines, OneLake storage, and read-only DAX queries against semantic models — plus optional write operations (pipeline/notebook runs, refreshes, Git sync, schedules, stage deployments, item create/delete, and workspace role grants) gated behind a write flag.

It talks to the public Fabric REST API (`api.fabric.microsoft.com`) and the Power BI REST API (`api.powerbi.com`), authenticating with [`@azure/identity`](https://www.npmjs.com/package/@azure/identity) so you can run it interactively, headless (device code), via the Azure CLI, or as a service principal.

## Features

- Resolve workspaces, items, pipelines, deployment pipelines, and semantic models by **display name or GUID** — no need to hunt for IDs.
- Continuation-token paging, HTTP 429 retry (honors `Retry-After`), and long-running-operation polling (handles both `202+Location` and `200`-with-body) built in.
- Read-only by default; all mutating operations are gated behind an explicit write mode and audit-logged to stderr.

## Tools

| Tool | Mode | Description |
|------|------|-------------|
| `list_workspaces` | read | List all Fabric workspaces the signed-in identity can see. |
| `list_items` | read | List items in a workspace (notebooks, lakehouses, warehouses, semantic models, reports, pipelines), optional type filter. |
| `list_pipelines` | read | List the data pipelines in a workspace. |
| `list_pipeline_runs` | read | Run (job instance) history for a pipeline, most-recent first, optional status filter. |
| `get_pipeline_run` | read | Full detail for one run by job instance ID, including `failureReason`. |
| `get_refresh_history` | read | Recent refresh history for a semantic model, most-recent first — did the refresh succeed, and why did it fail. |
| `get_git_status` | read | Items changed between the workspace and its connected Git branch, plus remote commit hash and workspace head. |
| `get_item_definition` | read | Get an item's definition parts (semantic model TMDL, notebook content, report). Manifest by default; decoded contents for a named part. |
| `execute_dax` | read | Run a read-only DAX query against a semantic model (Power BI `executeQueries`) and return the result rows. |
| `list_schedules` | read | Job schedules on an item, including each schedule's `owner` (id + type) — spot ownership drift after a deploy/update. |
| `list_deployment_pipelines` | read | List the deployment pipelines the identity can see. |
| `list_deployment_stages` | read | Stages of a deployment pipeline; optionally the items in a stage (source IDs + types for `deploy_stage`). |
| `list_onelake` | read | List files/tables under an item in OneLake via the DFS API — lag-free ground truth when the SQL endpoint's metadata lags. |
| `read_onelake_file` | read | Read a small file (log, JSON result) from an item's OneLake storage as decoded text, size-capped. |
| `list_workspace_roles` | read | Role assignments on a workspace (which principals hold Admin/Member/Contributor/Viewer). |
| `list_sql_databases` | read | SQL databases in a workspace + connection properties (server FQDN, database name, connection string). |
| `run_pipeline` | **write** | Trigger an on-demand pipeline run. |
| `cancel_pipeline_run` | **write** | Cancel an in-progress run. |
| `refresh_dataset` | **write** | Trigger an on-demand refresh of a semantic model. |
| `update_from_git` | **write** | Update a workspace from its connected Git branch (pull repo → workspace), preferring remote on conflicts. |
| `update_item_definition` | **write** | Deploy an item definition from a local folder, overwriting the live item. Snapshots the current definition first for one-call rollback. |
| `create_schedule` | **write** | Create a job schedule on an item (owned by the creating identity). |
| `update_schedule` | **write** | Enable/disable (pause/resume) or reconfigure a schedule. A PATCH re-stamps the owner to the caller. |
| `delete_schedule` | **write** | Delete a schedule; snapshots it to local JSON first. |
| `deploy_stage` | **write** | Selective deploy between deployment-pipeline stages (explicit item list required); polls to completion. |
| `run_notebook` | **write** | Run a notebook on demand as a job; waits for terminal status by default. |
| `create_item` | **write** | Create an item, optionally from a local definition folder. |
| `delete_item` | **write** | Delete an item (auto-handles the Gen2 dataflow endpoint quirk); best-effort definition snapshot first. |
| `add_workspace_role` | **write** | Grant a principal a role (Admin/Member/Contributor/Viewer) on a workspace. |

The write tools are only registered when `FABRIC_MCP_MODE=write`.

## Requirements

- Node.js >= 20
- An Entra (Azure AD) identity with access to the target Fabric workspace(s).
- For `execute_dax`: **Build** permission on the target semantic model, and the tenant's **"Dataset Execute Queries REST API"** admin setting enabled.

## Install

```bash
git clone <this-repo-url> fabric-mcp-server
cd fabric-mcp-server
npm install
```

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)). Set them in your MCP client's `env` block, or copy `.env.example` to `.env` for local debugging.

| Variable | Required | Purpose |
|----------|----------|---------|
| `FABRIC_AUTH_MODE` | no (default `interactive`) | `interactive`, `device-code`, `cli`, `service-principal`, `managed-identity`, or `default`. |
| `AZURE_TENANT_ID` | for interactive / device-code / service-principal | Your Entra tenant ID. |
| `AZURE_CLIENT_ID` | for service-principal | App registration client ID. |
| `AZURE_CLIENT_SECRET` | for service-principal | App registration secret. |
| `FABRIC_MCP_MODE` | no (default `read`) | `read` or `write` (see tools table). |

### Auth modes

- **interactive** — opens a browser; best for desktop/AVD.
- **device-code** — prints a code + URL to stderr; for SSH / WSL / headless.
- **cli** — reuses your existing `az login` session.
- **service-principal** — non-interactive with client ID + secret.
- **managed-identity** — for hosting on Azure.
- **default** — tries env → managed-identity → CLI → browser in turn.

## Use with Claude Code / Claude Desktop

Add to your MCP client config (e.g. `~/.claude.json` for Claude Code, or `claude_desktop_config.json`):

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

To enable pipeline execution, add `"FABRIC_MCP_MODE": "write"` to the `env` block.

## Examples

Check last night's run of a pipeline:

> "Using fabric, how did **my_pipeline** run in **My-Workspace** last night?"
> → `list_pipeline_runs` → `get_pipeline_run` on the failed instance.

Validate a measure against a live model:

> "Run this DAX against the **Production Analytics** model in **My-Workspace**:
> `EVALUATE ROW("Sales", [Total Sales])`"
> → `execute_dax` returns the row.

## Security notes

- No secrets are stored in the repo. Credentials come from environment variables at runtime; `.env` is git-ignored.
- The write tools (`run_pipeline`, `cancel_pipeline_run`, `refresh_dataset`, `update_from_git`, `update_item_definition`, `create_schedule`, `update_schedule`, `delete_schedule`, `deploy_stage`, `run_notebook`, `create_item`, `delete_item`, `add_workspace_role`) are only exposed under `FABRIC_MCP_MODE=write`, and each logs an `[AUDIT]` line to stderr.
- `list_onelake` / `read_onelake_file` call the OneLake DFS API (`onelake.dfs.fabric.microsoft.com`), which uses the Azure **Storage** token audience (`https://storage.azure.com/.default`) — the same `@azure/identity` credential acquires it, no extra configuration.
- `update_item_definition` overwrites the live item wholesale; it snapshots the current definition to a local JSON first (under the OS temp dir) and returns the path so you can roll back with `restore_snapshot`.
- `execute_dax` uses the Power BI `executeQueries` API, which only runs read-only DAX (data-modifying queries are rejected by the service).

## License

[MIT](LICENSE)
