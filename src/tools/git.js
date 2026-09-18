import { z } from "zod";
import { selectGitItems, summarizeChange } from "../fabric/git-items.js";
import { resolveWorkspace } from "../fabric/resolvers.js";
import { fabric } from "../http/client.js";
import { fabricLro, pollLro } from "../http/polling.js";
import { audit, defineTool, wsOut } from "./define.js";

const workspaceField = z.string().describe("Workspace display name or GUID");

async function gitStatus(workspaceId) {
  // git/status can itself be an LRO (202 + Location); fabricLro handles both shapes.
  return fabricLro("GET", `/workspaces/${workspaceId}/git/status`);
}

const getGitStatus = defineTool({
  name: "get_git_status",
  description:
    "Show the Git status of a Fabric workspace: items changed between the workspace and its connected Git branch, plus the remote commit hash and workspace head. Requires the workspace to be connected to Git.",
  schema: { workspace: workspaceField },
  handler: async ({ workspace }) => {
    const ws = await resolveWorkspace(workspace);
    const data = await gitStatus(ws.id);
    return { workspace: wsOut(ws), ...data };
  },
});

const updateFromGit = defineTool({
  name: "update_from_git",
  mode: "write",
  description:
    "Update a Fabric workspace from its connected Git branch (pull repo -> workspace). Reads git status to fill remoteCommitHash and workspaceHead, then updates. conflict_policy defaults to PreferRemote; pass PreferWorkspace to re-baseline the branch onto the workspace's version of conflicting items (safe: no live objects/data change) — this is the recovery for DataDeletionWarning / conflict failures. Long-running: returns immediately unless wait=true. Requires the workspace to be connected to Git and FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    conflict_policy: z
      .string()
      .optional()
      .describe("PreferRemote (default) or PreferWorkspace — which side wins for items changed on both sides"),
    allow_override: z
      .boolean()
      .optional()
      .describe("Consent to override incoming items (default true; the API refuses to start without it when incoming items exist)"),
    wait: z.boolean().optional().describe("Poll the operation to completion and re-read git status (default false)"),
  },
  handler: async ({ workspace, conflict_policy, allow_override, wait }) => {
    const ws = await resolveWorkspace(workspace);
    const status = await gitStatus(ws.id);
    const remoteCommitHash = status?.remoteCommitHash;
    if (!remoteCommitHash) {
      throw new Error(
        `Workspace "${ws.displayName ?? ws.id}" has no remote commit to update from — is it connected to Git? Status: ${JSON.stringify(status)}`,
      );
    }
    const policy = (conflict_policy ?? "PreferRemote").toLowerCase();
    if (!["preferremote", "preferworkspace"].includes(policy)) {
      throw new Error(`conflict_policy must be PreferRemote or PreferWorkspace, got "${conflict_policy}"`);
    }
    const body = {
      remoteCommitHash,
      workspaceHead: status?.workspaceHead,
      conflictResolution: {
        conflictResolutionType: "Workspace",
        conflictResolutionPolicy: policy === "preferworkspace" ? "PreferWorkspace" : "PreferRemote",
      },
      options: { allowOverrideItems: allow_override ?? true },
    };
    const data = await fabric("POST", `/workspaces/${ws.id}/git/updateFromGit`, body);
    audit("update_from_git", { ws: ws.id, remoteCommitHash, policy: body.conflictResolution.conflictResolutionPolicy });
    const base = {
      workspace: wsOut(ws),
      requested: true,
      remoteCommitHash,
      workspaceHeadBefore: status?.workspaceHead ?? null,
      conflictPolicy: body.conflictResolution.conflictResolutionPolicy,
      conflicts: (status.changes ?? []).filter((change) => change.conflictType === "Conflict").map(summarizeChange),
      operationLocation: data._location ?? null,
    };
    if (!wait) return { ...base, note: "Update accepted (long-running). Poll get_git_status for completion, or pass wait=true." };
    if (data._accepted && data._location) {
      await pollLro(data._location, data._retryAfter ? parseInt(data._retryAfter, 10) : undefined);
    }
    const after = await gitStatus(ws.id);
    return {
      ...base,
      completed: true,
      workspaceHeadAfter: after?.workspaceHead ?? null,
      remainingChanges: (after.changes ?? []).map(summarizeChange),
    };
  },
});

const commitToGit = defineTool({
  name: "commit_to_git",
  mode: "write",
  description:
    "Commit workspace changes to the connected Git branch (workspace -> repo). Safety-first: name the items to commit (display names or GUIDs) and only those are committed (Selective mode) — other people's in-flight dirty items stay untouched. With no items the tool REFUSES unless mode='All' is passed explicitly, and it lists the dirty items so you can choose. workspaceHead is read from git status. Polls to completion. Requires FABRIC_MCP_MODE=write.",
  schema: {
    workspace: workspaceField,
    comment: z.string().max(300).optional().describe("Commit message (max 300 chars). Defaults to the Git provider's default."),
    items: z
      .array(z.string())
      .optional()
      .describe("Items to commit, by display name or GUID. Must be dirty per get_git_status. Omit only with mode='All'."),
    mode: z.string().optional().describe("Selective (default when items given) or All (commit every dirty item — explicit opt-in)"),
  },
  handler: async ({ workspace, comment, items, mode }) => {
    const ws = await resolveWorkspace(workspace);
    const status = await gitStatus(ws.id);
    if (!status?.workspaceHead && !status?.remoteCommitHash) {
      throw new Error(`Workspace "${ws.displayName ?? ws.id}" does not look connected to Git. Status: ${JSON.stringify(status)}`);
    }
    const dirty = (status.changes ?? []).filter((change) => change.workspaceChange);
    const requestedMode = (mode ?? (items?.length ? "Selective" : "")).toLowerCase();
    if (!requestedMode) {
      const dirtyList =
        dirty.map((change) => `${change.itemMetadata?.displayName} (${change.itemMetadata?.itemType}, ${change.workspaceChange})`).join("; ") ||
        "(none)";
      throw new Error(`No items given. Pass items=[...] to commit specific items, or mode='All' to commit everything. Dirty items: ${dirtyList}`);
    }
    if (!["selective", "all"].includes(requestedMode)) throw new Error(`mode must be Selective or All, got "${mode}"`);
    if (!dirty.length) {
      return { workspace: wsOut(ws), committed: false, note: "Nothing to commit: no workspace-side changes.", workspaceHead: status.workspaceHead };
    }

    const body = { mode: requestedMode === "all" ? "All" : "Selective", workspaceHead: status.workspaceHead, ...(comment ? { comment } : {}) };
    let committedItems;
    if (body.mode === "Selective") {
      if (!items?.length) throw new Error("Selective mode needs items=[...].");
      const { selected, missing } = selectGitItems(status.changes, items);
      if (missing.length) {
        const dirtyNames = dirty.map((change) => change.itemMetadata?.displayName).join(", ") || "(none)";
        throw new Error(`Not dirty in this workspace (nothing to commit): ${missing.join(", ")}. Dirty items: ${dirtyNames}`);
      }
      body.items = selected.map((entry) => entry.identifier);
      committedItems = selected.map(({ identifier, ...rest }) => ({ ...rest, ...identifier }));
    } else {
      committedItems = dirty.map(summarizeChange);
    }

    const result = await fabricLro("POST", `/workspaces/${ws.id}/git/commitToGit`, body);
    audit("commit_to_git", { ws: ws.id, mode: body.mode, items: committedItems.length, head: status.workspaceHead });
    const after = await gitStatus(ws.id);
    return {
      workspace: wsOut(ws),
      committed: true,
      mode: body.mode,
      comment: comment ?? null,
      items: committedItems,
      workspaceHeadBefore: status.workspaceHead,
      workspaceHeadAfter: after?.workspaceHead ?? null,
      remainingDirty: (after.changes ?? []).filter((change) => change.workspaceChange).map(summarizeChange),
      result,
    };
  },
});

export default [getGitStatus, updateFromGit, commitToGit];
