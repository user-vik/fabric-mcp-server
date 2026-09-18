import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { UsageError, describeSchema, kindOf, parseToolArgs, tokenize } from "../src/cli/args.js";
import { EXIT_OK, EXIT_USAGE, emit, firstSentence, runCli, toolHelp, toolsListing } from "../src/cli/main.js";
import { getTool } from "../src/tools/index.js";

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, out: chunks.join("") }))
    .finally(() => {
      process.stdout.write = original;
    });
}

test("tokenize handles --k v, --k=v, bare booleans, --no-k, and positionals", () => {
  const { flags, positionals } = tokenize(["list-runs", "--workspace", "BI-Prod", "--top=5", "--wait", "--no-recursive", "--job-instance-id", "abc"]);
  assert.deepEqual(positionals, ["list-runs"]);
  assert.equal(flags.get("workspace"), "BI-Prod");
  assert.equal(flags.get("top"), "5");
  assert.equal(flags.get("wait"), true);
  assert.equal(flags.get("recursive"), false);
  assert.equal(flags.get("job_instance_id"), "abc", "kebab-case flags normalise to snake_case keys");
});

test("kindOf maps zod field types onto CLI value kinds", () => {
  assert.equal(kindOf(z.string()), "string");
  assert.equal(kindOf(z.string().optional()), "string");
  assert.equal(kindOf(z.number().int().positive().max(200).optional()), "number");
  assert.equal(kindOf(z.boolean().optional()), "boolean");
  assert.equal(kindOf(z.array(z.string()).optional()), "string[]");
  assert.equal(kindOf(z.array(z.object({ a: z.string() }))), "json");
  assert.equal(kindOf(z.record(z.any()).optional()), "json");
});

test("parseToolArgs coerces every real tool schema shape", () => {
  const schema = getTool("list_item_runs").schema;
  const flags = new Map([["workspace", "BI-Prod"], ["item", "brz_nb"], ["top", "3"], ["status", "Failed"]]);
  assert.deepEqual(parseToolArgs(schema, flags), { workspace: "BI-Prod", item: "brz_nb", top: 3, status: "Failed" });

  const commit = getTool("commit_to_git").schema;
  assert.deepEqual(parseToolArgs(commit, new Map([["workspace", "w"], ["items", "A, B ,C"]])).items, ["A", "B", "C"]);
  assert.deepEqual(parseToolArgs(commit, new Map([["workspace", "w"], ["items", '["A","B"]']])).items, ["A", "B"]);

  const deploy = getTool("deploy_stage").schema;
  const parsed = parseToolArgs(
    deploy,
    new Map([
      ["deployment_pipeline", "dp"],
      ["source_stage", "Dev"],
      ["target_stage", "Test"],
      ["items", '[{"sourceItemId":"1","itemType":"Notebook"}]'],
    ]),
  );
  assert.equal(parsed.items[0].itemType, "Notebook");

  const notebook = getTool("run_notebook").schema;
  const nb = parseToolArgs(notebook, new Map([["workspace", "w"], ["notebook", "n"], ["wait", false], ["parameters", '{"p":{"value":"5","type":"int"}}']]));
  assert.equal(nb.wait, false);
  assert.equal(nb.parameters.p.type, "int");
});

test("parseToolArgs reads @file for JSON values and rejects unknown or invalid flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-cli-test-"));
  const file = join(dir, "params.json");
  writeFileSync(file, JSON.stringify({ a: 1 }));
  const schema = getTool("run_pipeline").schema;
  assert.deepEqual(parseToolArgs(schema, new Map([["workspace", "w"], ["pipeline", "p"], ["parameters", `@${file}`]])).parameters, { a: 1 });

  assert.throws(() => parseToolArgs(schema, new Map([["workspace", "w"], ["pipeline", "p"], ["bogus", "1"]])), UsageError);
  assert.throws(() => parseToolArgs(schema, new Map([["workspace", "w"]])), /--pipeline/);
  assert.throws(() => parseToolArgs(getTool("list_pipeline_runs").schema, new Map([["workspace", "w"], ["pipeline", "p"], ["top", "lots"]])), /expects a number/);
  assert.throws(() => parseToolArgs(getTool("list_pipeline_runs").schema, new Map([["workspace", "w"], ["pipeline", "p"], ["top", "500"]])), UsageError);
  // Global flags are ignored by the tool parser.
  assert.deepEqual(parseToolArgs(getTool("list_workspaces").schema, new Map([["out", "x.json"], ["compact", true]])), {});
});

test("describeSchema and toolHelp expose kebab-case flags with required markers", () => {
  const fields = describeSchema(getTool("get_item_run").schema);
  const byFlag = Object.fromEntries(fields.map((field) => [field.flag, field]));
  assert.equal(byFlag["--job-instance-id"].required, true);
  assert.equal(byFlag["--type"].required, false);
  const help = toolHelp(getTool("get_item_run"));
  assert.match(help, /fabric get-item-run\s+\[read\]/);
  assert.match(help, /--job-instance-id\s+required/);
});

test("runCli: tools listing, help, unknown tool, and the write gate", async () => {
  const listing = await captureStdout(() => runCli(["tools"]));
  assert.equal(listing.result, EXIT_OK);
  assert.match(listing.out, /^list_workspaces\s+read/m);
  assert.match(listing.out, /^commit_to_git\s+write/m);
  assert.equal(toolsListing().split("\n").length, 42);

  const help = await captureStdout(() => runCli(["help", "list-workspaces"]));
  assert.equal(help.result, EXIT_OK);
  assert.match(help.out, /No flags/);

  const errors = [];
  const unknown = await captureStdout(() => runCli(["frobnicate"], { stderr: (msg) => errors.push(msg) }));
  assert.equal(unknown.result, EXIT_USAGE);
  assert.match(errors[0], /Unknown tool/);

  const writeGate = await captureStdout(() => runCli(["commit-to-git", "--workspace", "w", "--mode", "All"], { stderr: (msg) => errors.push(msg) }));
  assert.equal(process.env.FABRIC_MCP_MODE === "write", false, "test must run without write mode");
  assert.equal(writeGate.result, EXIT_USAGE);
  assert.match(errors.at(-1), /FABRIC_MCP_MODE=write/);

  const usageErr = await captureStdout(() => runCli(["list-pipeline-runs", "--workspace", "w"], { stderr: (msg) => errors.push(msg) }));
  assert.equal(usageErr.result, EXIT_USAGE);
  assert.match(errors.at(-1), /--pipeline/);

  const noArgs = await captureStdout(() => runCli([]));
  assert.equal(noArgs.result, EXIT_USAGE);
  assert.match(noArgs.out, /Usage:/);
});

test("emit writes pretty or compact JSON to stdout, or to --out with a receipt", async () => {
  const payload = { a: 1, rows: [{ b: 2 }] };
  const pretty = await captureStdout(() => emit(payload, {}));
  assert.equal(pretty.out, `${JSON.stringify(payload, null, 2)}\n`);
  const compact = await captureStdout(() => emit(payload, { compact: true }));
  assert.equal(compact.out, `${JSON.stringify(payload)}\n`);

  const dir = mkdtempSync(join(tmpdir(), "fabric-cli-out-"));
  const file = join(dir, "result.json");
  const receipt = await captureStdout(() => emit(payload, { out: file, compact: true }));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), payload);
  assert.deepEqual(JSON.parse(receipt.out), { written: file, bytes: JSON.stringify(payload).length });
});

test("firstSentence keeps e.g. / etc. inside the summary", () => {
  assert.equal(firstSentence("List folders (e.g. 'Reports/Sales'). Use it to inspect."), "List folders (e.g. 'Reports/Sales').");
  assert.equal(firstSentence("Items — notebooks, lakehouses, etc. Optional type filter."), "Items — notebooks, lakehouses, etc.");
  assert.equal(firstSentence("Promote across stages (e.g. Dev -> Test -> Prod). Next."), "Promote across stages (e.g. Dev -> Test -> Prod).");
  assert.equal(firstSentence("One sentence only"), "One sentence only");
});
