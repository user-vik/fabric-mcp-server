import assert from "node:assert/strict";
import test from "node:test";
import { matchConnections } from "../src/fabric/connections.js";
import { selectGitItems, summarizeChange } from "../src/fabric/git-items.js";
import { groupTables } from "../src/fabric/sql-endpoint.js";
import { jobInstanceIdFrom, pollJobInstance } from "../src/http/polling.js";

const changes = [
  { itemMetadata: { itemIdentifier: { objectId: "7753f3b4-dbb8-44c1-a94f-6ae4d776369e" }, itemType: "Notebook", displayName: "brz_nb_clean" }, workspaceChange: "Modified", conflictType: "None" },
  { itemMetadata: { itemIdentifier: { objectId: "1153f3b4-dbb8-33c1-a84f-6ae4d776362d", logicalId: "111e8d7b-4a95-4c02-8ccd-6faef5ba1bd1" }, itemType: "Dataflow", displayName: "LP_dev" }, workspaceChange: "Modified", conflictType: "None" },
  { itemMetadata: { itemIdentifier: { logicalId: "1423f3b4-dba5-44c1-a94f-6ae4d776369a" }, itemType: "Report", displayName: "Deleted in Git" }, remoteChange: "Deleted", conflictType: "None" },
];

test("selectGitItems picks dirty items by name or GUID and reports the rest as missing", () => {
  const byName = selectGitItems(changes, ["BRZ_NB_CLEAN"]);
  assert.deepEqual(byName.selected.map((entry) => entry.identifier), [{ objectId: "7753f3b4-dbb8-44c1-a94f-6ae4d776369e" }]);
  assert.deepEqual(byName.missing, []);
  assert.equal(byName.dirty.length, 2, "remote-only changes are not dirty workspace items");

  const byGuid = selectGitItems(changes, ["111e8d7b-4a95-4c02-8ccd-6faef5ba1bd1", "Nope"]);
  assert.deepEqual(byGuid.selected[0].identifier, { objectId: "1153f3b4-dbb8-33c1-a84f-6ae4d776362d", logicalId: "111e8d7b-4a95-4c02-8ccd-6faef5ba1bd1" });
  assert.deepEqual(byGuid.missing, ["Nope"]);

  const remoteOnly = selectGitItems(changes, ["Deleted in Git"]);
  assert.deepEqual(remoteOnly.missing, ["Deleted in Git"], "a remote-only change cannot be committed from the workspace");
  assert.equal(summarizeChange(changes[2]).remoteChange, "Deleted");
});

test("matchConnections binds unbound targets from a bound sibling by type+path, then by type", () => {
  const target = [
    { connectivityType: "Automatic", connectionDetails: { type: "SQL", path: "abc.datawarehouse.fabric.microsoft.com;db1" } },
    { connectivityType: "Automatic", connectionDetails: { type: "AzureDataLakeStorage", path: "https://onelake.dfs.fabric.microsoft.com/ws/lh/" } },
    { connectivityType: "ShareableCloud", id: "already", connectionDetails: { type: "Web", path: "https://x" } },
  ];
  const source = [
    { connectivityType: "ShareableCloud", id: "sql-conn", connectionDetails: { type: "SQL", path: "ABC.datawarehouse.fabric.microsoft.com;db1" } },
    { connectivityType: "ShareableCloud", id: "lake-conn", connectionDetails: { type: "AzureDataLakeStorage", path: "https://onelake.dfs.fabric.microsoft.com/ws/other/" } },
  ];
  const { plan, unmatched, alreadyBound } = matchConnections(target, source);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].source.id, "sql-conn");
  assert.equal(plan[0].matchedBy, "type+path", "path match is case-insensitive");
  assert.equal(plan[1].source.id, "lake-conn");
  assert.equal(plan[1].matchedBy, "type", "falls back to the single same-type connection");
  assert.equal(plan[1].target.connectionDetails.path.endsWith("/"), true, "target path is preserved verbatim, trailing slash included");
  assert.deepEqual(unmatched, []);
  assert.equal(alreadyBound.length, 1);

  const ambiguous = matchConnections(target.slice(1, 2), [...source, { connectivityType: "ShareableCloud", id: "lake-2", connectionDetails: { type: "AzureDataLakeStorage", path: "https://elsewhere/" } }]);
  assert.equal(ambiguous.plan.length, 0);
  assert.equal(ambiguous.unmatched[0].candidates.length, 2);
});

test("groupTables builds refreshMetadata TableDefinitions grouped by schema", () => {
  assert.deepEqual(groupTables(["dbo.orders", "customers", "sales.daily", "sales.hourly", " "]), [
    { schema: "dbo", tableNames: ["orders", "customers"] },
    { schema: "sales", tableNames: ["daily", "hourly"] },
  ]);
  assert.deepEqual(groupTables([]), []);
});

test("jobInstanceIdFrom extracts the GUID from a jobs/instances Location and poll timeouts name it", async () => {
  const url = "https://api.fabric.microsoft.com/v1/workspaces/w/items/i/jobs/instances/2f961fc7-17f3-4cc7-9fae-95f068f74983";
  assert.equal(jobInstanceIdFrom(url), "2f961fc7-17f3-4cc7-9fae-95f068f74983");
  assert.equal(jobInstanceIdFrom(null), null);
  assert.equal(jobInstanceIdFrom("https://api.fabric.microsoft.com/v1/operations/abc"), null);

  // Drive the poll loop past its deadline instantly by faking time via a
  // never-terminal response and a sleep that jumps the clock.
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    await assert.rejects(
      () =>
        pollJobInstance(url, 0, {
          fetchFn: async () => new Response(JSON.stringify({ status: "InProgress" }), { status: 200 }),
          getTokenFn: async () => "t",
          sleepFn: async () => {
            now += 400_000;
          },
        }),
      /POLL timeout, not a job failure.*2f961fc7-17f3-4cc7-9fae-95f068f74983/s,
    );
  } finally {
    Date.now = realNow;
  }
});

test("pollLro treats OperationHasNoResult as success and returns the operation state", async () => {
  const { pollLro } = await import("../src/http/polling.js");
  const state = { status: "Succeeded", createdTimeUtc: "2026-09-19T01:32:00Z", percentComplete: 100 };
  const responses = [
    new Response(JSON.stringify(state), { status: 200 }),
    new Response(JSON.stringify({ errorCode: "OperationHasNoResult", message: "The operation has no result" }), { status: 400 }),
  ];
  const result = await pollLro("https://api.fabric.microsoft.com/v1/operations/op-1", 0, {
    fetchFn: async () => responses.shift(),
    getTokenFn: async () => "t",
    sleepFn: async () => {},
  });
  assert.equal(result.status, "Succeeded");
  assert.equal(result._noResult, true);

  // Any other failure on the result fetch still surfaces (existing contract).
  const failing = [
    new Response(JSON.stringify(state), { status: 200 }),
    new Response("nope", { status: 403 }),
  ];
  await assert.rejects(
    () => pollLro("https://api.fabric.microsoft.com/v1/operations/op-2", 0, { fetchFn: async () => failing.shift(), getTokenFn: async () => "t", sleepFn: async () => {} }),
    /403: nope/,
  );

  // Only the structured errorCode counts: a 400 that merely mentions the string
  // in its message, or a non-JSON body, is still a failure.
  for (const body of [
    JSON.stringify({ errorCode: "InvalidRequest", message: "see OperationHasNoResult docs" }),
    "OperationHasNoResult",
  ]) {
    const lookalike = [new Response(JSON.stringify(state), { status: 200 }), new Response(body, { status: 400 })];
    await assert.rejects(
      () => pollLro("https://api.fabric.microsoft.com/v1/operations/op-3", 0, { fetchFn: async () => lookalike.shift(), getTokenFn: async () => "t", sleepFn: async () => {} }),
      /400/,
    );
  }
});

test("initializeCredential is memoised so concurrent first callers share one sign-in", async () => {
  const { initializeCredential } = await import("../src/auth/credentials.js");
  const originalMode = process.env.FABRIC_AUTH_MODE;
  try {
    // cli mode builds a credential without any network or browser interaction.
    process.env.FABRIC_AUTH_MODE = "cli";
    const [a, b, c] = await Promise.all([initializeCredential(), initializeCredential(), initializeCredential()]);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(await initializeCredential(), a, "later calls reuse the same credential");
  } finally {
    if (originalMode === undefined) delete process.env.FABRIC_AUTH_MODE;
    else process.env.FABRIC_AUTH_MODE = originalMode;
  }
});

test("authRecordPath is keyed by cache name, mode, tenant and client under the user profile", async () => {
  const { authRecordPath } = await import("../src/auth/credentials.js");
  const path = authRecordPath({ mode: "interactive", tenantId: "924c0f91-0000-0000-0000-000000000000", clientId: undefined });
  assert.match(path, /[\\/]\.fabric-mcp-server[\\/]fabric-mcp-server\.interactive\.924c0f91-0000-0000-0000-000000000000\.04b07795-8ddb-461a-bbee-02f9e1bf7b46\.auth-record\.json$/);
  const other = authRecordPath({ mode: "device-code", tenantId: "t", clientId: "custom/app" });
  assert.match(other, /\.device-code\.t\.custom_app\.auth-record\.json$/);
});
