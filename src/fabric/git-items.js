import { GUID_RE } from "./resolvers.js";

/**
 * Map caller-supplied item references (display names or GUIDs) onto the
 * ItemIdentifier objects the commitToGit API expects, using the git status
 * `changes` list as the source of truth for what is actually dirty.
 */
function selectGitItems(changes, refs) {
  const dirty = (changes ?? []).filter((change) => change.workspaceChange);
  const selected = [];
  const missing = [];
  for (const ref of refs) {
    const key = ref.toLowerCase();
    const match = dirty.find((change) => {
      const meta = change.itemMetadata ?? {};
      const ident = meta.itemIdentifier ?? {};
      if (GUID_RE.test(ref)) {
        return (ident.objectId ?? "").toLowerCase() === key || (ident.logicalId ?? "").toLowerCase() === key;
      }
      return (meta.displayName ?? "").toLowerCase() === key;
    });
    if (!match) {
      missing.push(ref);
      continue;
    }
    const ident = match.itemMetadata.itemIdentifier ?? {};
    const entry = {};
    if (ident.objectId) entry.objectId = ident.objectId;
    if (ident.logicalId) entry.logicalId = ident.logicalId;
    selected.push({
      identifier: entry,
      displayName: match.itemMetadata.displayName,
      itemType: match.itemMetadata.itemType,
      workspaceChange: match.workspaceChange,
      conflictType: match.conflictType,
    });
  }
  return { selected, missing, dirty };
}

function summarizeChange(change) {
  const meta = change.itemMetadata ?? {};
  return {
    displayName: meta.displayName,
    itemType: meta.itemType,
    objectId: meta.itemIdentifier?.objectId,
    logicalId: meta.itemIdentifier?.logicalId,
    workspaceChange: change.workspaceChange ?? null,
    remoteChange: change.remoteChange ?? null,
    conflictType: change.conflictType,
  };
}

export { selectGitItems, summarizeChange };
