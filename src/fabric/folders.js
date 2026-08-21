import { GUID_RE } from "./resolvers.js";
import { fabricListAll } from "../http/client.js";

function buildFolderPaths(folders) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const pathCache = new Map();
  const pathOf = (folder) => {
    if (pathCache.has(folder.id)) return pathCache.get(folder.id);
    const parent = folder.parentFolderId ? byId.get(folder.parentFolderId) : null;
    const path = parent ? `${pathOf(parent)}/${folder.displayName}` : folder.displayName;
    pathCache.set(folder.id, path);
    return path;
  };
  return folders
    .map((folder) => ({
      id: folder.id,
      displayName: folder.displayName,
      parentFolderId: folder.parentFolderId ?? null,
      path: pathOf(folder),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function listFolders(workspaceId) {
  const folders = await fabricListAll(`/workspaces/${workspaceId}/folders?recursive=true`);
  return buildFolderPaths(folders);
}

async function resolveFolder(workspaceId, folderRef) {
  if (!folderRef) throw new Error("folder is required (path, display name, or GUID)");
  if (GUID_RE.test(folderRef)) return { id: folderRef, path: undefined };
  const folders = await listFolders(workspaceId);
  const key = folderRef.toLowerCase().replace(/^\/+|\/+$/g, "");
  const byPath = folders.filter((folder) => folder.path.toLowerCase() === key);
  if (byPath.length === 1) return byPath[0];
  const byName = folders.filter((folder) => folder.displayName.toLowerCase() === key);
  if (byName.length === 1) return byName[0];
  if (byPath.length > 1 || byName.length > 1) {
    throw new Error(
      `Folder "${folderRef}" is ambiguous. Matching paths: ${[...byPath, ...byName].map((folder) => folder.path).join(", ")}. Use the full path or GUID.`,
    );
  }
  throw new Error(
    `Folder "${folderRef}" not found in workspace. Folders: ${folders.map((folder) => folder.path).join(", ") || "(none)"}`,
  );
}

export { buildFolderPaths, listFolders, resolveFolder };
