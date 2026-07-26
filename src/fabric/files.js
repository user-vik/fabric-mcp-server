import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

function collectFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else out.push(full);
  }
  return out;
}

function readDefinitionFromDir(dir) {
  if (!existsSync(dir)) throw new Error(`definition_path does not exist: ${dir}`);
  const files = collectFiles(dir);
  if (!files.some((file) => file.endsWith(".platform"))) {
    throw new Error(
      `No .platform file found under ${dir} — this does not look like a Fabric item definition folder. Point definition_path at the item folder (the one containing .platform and definition/).`,
    );
  }
  return {
    parts: files.map((file) => ({
      path: relative(dir, file).split(sep).join("/"),
      payload: readFileSync(file).toString("base64"),
      payloadType: "InlineBase64",
    })),
  };
}

function snapshotDir() {
  const dir = join(tmpdir(), "fabric-mcp-snapshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSnapshot(itemId, definition) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(snapshotDir(), `${itemId}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(definition, null, 2), "utf8");
  return file;
}

function readSnapshot(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (parsed.parts) return parsed;
  if (parsed.definition?.parts) return parsed.definition;
  throw new Error(`Snapshot file ${file} has no parts.`);
}

function normalizeOneLakeFilePath(path) {
  const segments = path.replace(/^\/+/, "").split("/");
  if (!segments.length || segments.some((segment) => !segment)) {
    throw new Error("path must be a non-empty file path without empty segments.");
  }
  for (const segment of segments) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`path contains an invalid percent-encoded segment: ${segment}`);
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      throw new Error("path must not contain traversal or path delimiter segments.");
    }
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export { normalizeOneLakeFilePath, readDefinitionFromDir, readSnapshot, writeSnapshot };
