import { writeFileSync } from "node:fs";
import { VERSION, WRITE_ENABLED } from "../config.js";
import { READ_TOOLS, TOOLS, WRITE_TOOLS, getTool } from "../tools/index.js";
import { UsageError, describeSchema, parseToolArgs, tokenize } from "./args.js";

const EXIT_OK = 0;
const EXIT_TOOL_ERROR = 1;
const EXIT_USAGE = 2;

function usage() {
  return [
    `fabric v${VERSION} — Microsoft Fabric from the shell (same tools as the fabric-mcp-server MCP)`,
    "",
    "Usage:",
    "  fabric <tool> [--flag value ...] [--out file] [--compact]",
    "  fabric tools                 list every tool (name, mode, one-line description)",
    "  fabric help <tool>           show a tool's flags",
    "  fabric --version",
    "",
    "Flags mirror the tool's parameters: snake_case or kebab-case both work",
    "(--job_instance_id / --job-instance-id). Object/array parameters take inline",
    "JSON or @path/to/file.json; string arrays also take comma-separated values.",
    "Booleans: --wait, --wait=false, --no-wait.",
    "",
    "Output is JSON on stdout (pipe it into jq / ConvertFrom-Json). Errors go to",
    "stderr with exit code 1; usage problems exit 2.",
    "",
    "Write tools need FABRIC_MCP_MODE=write in the environment, exactly like the",
    "MCP server. Auth uses the same FABRIC_AUTH_MODE / AZURE_* variables; the CLI",
    "persists its token cache by default (FABRIC_TOKEN_CACHE=memory to disable).",
  ].join("\n");
}

/** First sentence of a description, without tripping on the dot that ends "e.g." / "i.e." / "vs.". */
function firstSentence(text) {
  const guarded = text.replace(/\b(e\.g|i\.e|vs)\./gi, (match) => `${match.slice(0, -1)}\u0000`);
  const cut = guarded.split(/(?<=\.)\s+(?=[A-Z(])/)[0];
  return cut.replace(/\u0000/g, ".");
}

function toolsListing() {
  const rows = [...READ_TOOLS, ...WRITE_TOOLS].map((tool) => ({
    name: tool.name,
    mode: tool.mode,
    description: firstSentence(tool.description),
  }));
  const width = Math.max(...rows.map((row) => row.name.length));
  return rows.map((row) => `${row.name.padEnd(width)}  ${row.mode.padEnd(5)}  ${row.description}`).join("\n");
}

function toolHelp(tool) {
  const fields = describeSchema(tool.schema);
  const lines = [`fabric ${tool.name.replace(/_/g, "-")}  [${tool.mode}]`, "", tool.description, ""];
  if (!fields.length) {
    lines.push("No flags.");
  } else {
    const width = Math.max(...fields.map((field) => field.flag.length));
    for (const field of fields) {
      lines.push(`  ${field.flag.padEnd(width)}  ${field.required ? "required" : "optional"}  ${field.kind.padEnd(8)}  ${field.description}`);
    }
  }
  return lines.join("\n");
}

function emit(result, { out, compact }) {
  const text = compact ? JSON.stringify(result) : JSON.stringify(result, null, 2);
  if (out) {
    writeFileSync(out, `${text}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ written: out, bytes: Buffer.byteLength(text) })}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

async function runCli(argv, { stderr = console.error } = {}) {
  const { flags, positionals } = tokenize(argv);
  const [command, ...rest] = positionals;

  if (flags.has("version")) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (!command || command === "help" && !rest.length || flags.has("help") && !command) {
    process.stdout.write(`${usage()}\n`);
    return command || flags.has("help") ? EXIT_OK : EXIT_USAGE;
  }
  if (command === "tools" || command === "list") {
    process.stdout.write(`${toolsListing()}\n`);
    return EXIT_OK;
  }
  if (command === "help") {
    const tool = getTool(rest[0]);
    if (!tool) {
      stderr(`Unknown tool "${rest[0]}". Run \`fabric tools\` to list them.`);
      return EXIT_USAGE;
    }
    process.stdout.write(`${toolHelp(tool)}\n`);
    return EXIT_OK;
  }

  const tool = getTool(command);
  if (!tool) {
    stderr(`Unknown tool "${command}". Run \`fabric tools\` to list them.`);
    return EXIT_USAGE;
  }
  if (flags.has("help")) {
    process.stdout.write(`${toolHelp(tool)}\n`);
    return EXIT_OK;
  }
  if (rest.length) {
    stderr(`Unexpected positional argument(s): ${rest.join(" ")}. All tool parameters are flags; see \`fabric help ${command}\`.`);
    return EXIT_USAGE;
  }
  if (tool.mode === "write" && !WRITE_ENABLED) {
    stderr(`${tool.name} is a write tool. Set FABRIC_MCP_MODE=write in the environment to enable it (same gate as the MCP server).`);
    return EXIT_USAGE;
  }

  const out = flags.get("out");
  if (out !== undefined && (typeof out !== "string" || !out.trim())) {
    stderr("--out needs a file path, e.g. --out result.json");
    return EXIT_USAGE;
  }

  let args;
  try {
    args = parseToolArgs(tool.schema, flags);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\n\n${toolHelp(tool)}`);
      return EXIT_USAGE;
    }
    throw error;
  }

  let result;
  try {
    result = await tool.handler(args);
  } catch (error) {
    stderr(error?.message ?? String(error));
    return EXIT_TOOL_ERROR;
  }
  try {
    emit(result ?? {}, { out, compact: flags.has("compact") && flags.get("compact") !== false });
  } catch (error) {
    stderr(`Tool succeeded but writing output failed: ${error?.message ?? String(error)}`);
    return EXIT_TOOL_ERROR;
  }
  return EXIT_OK;
}

export { EXIT_OK, EXIT_TOOL_ERROR, EXIT_USAGE, TOOLS, emit, firstSentence, runCli, toolHelp, toolsListing, usage };
