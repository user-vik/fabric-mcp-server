const MODES = new Set(["read", "write"]);

function defineTool({ name, description, mode = "read", schema = {}, handler }) {
  if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid tool name: ${name}`);
  if (!description) throw new Error(`Tool ${name} needs a description`);
  if (!MODES.has(mode)) throw new Error(`Tool ${name} has invalid mode ${mode}`);
  if (typeof handler !== "function") throw new Error(`Tool ${name} needs a handler`);
  return Object.freeze({ name, description, mode, schema, handler });
}

function audit(tool, fields = {}) {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.error(`[fabric-mcp][AUDIT] ${new Date().toISOString()} ${tool}${pairs ? ` ${pairs}` : ""}`);
}

function wsOut(ws) {
  return { id: ws.id, displayName: ws.displayName };
}

function itemOut(it, fallbackName) {
  return { id: it.id, displayName: it.displayName ?? fallbackName, type: it.type };
}

export { audit, defineTool, itemOut, wsOut };
