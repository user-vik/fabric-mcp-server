import { getToken } from "../auth/credentials.js";
import { FABRIC_SCOPE, LRO_MAX_WAIT_MS, REQUEST_TIMEOUT_MS } from "../config.js";
import { fabric, httpError, sleep } from "./client.js";

async function pollLro(
  opUrl,
  retryAfterSec,
  { fetchFn = fetch, getTokenFn = getToken, sleepFn = sleep } = {},
) {
  const started = Date.now();
  let delay = Math.max((retryAfterSec ?? 1) * 1000, 1000);
  while (Date.now() - started < LRO_MAX_WAIT_MS) {
    await sleepFn(delay);
    const token = await getTokenFn(FABRIC_SCOPE);
    const res = await fetchFn(opUrl, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      delay = Number.isFinite(retryAfter) ? Math.max(retryAfter * 1000, 1000) : delay;
      continue;
    }
    if (!res.ok) throw await httpError(res, "GET", opUrl);
    const text = await res.text();
    const state = (text ? JSON.parse(text) : {}) ?? {};
    const status = (state.status ?? "").toLowerCase();
    if (status === "failed") {
      throw new Error(`Fabric operation failed: ${JSON.stringify(state.error ?? state)}`);
    }
    if (status === "succeeded") {
      // Some operations (getDefinition, deploy, create) publish a result at the
      // Location header or at {op}/result. Others (commitToGit, updateFromGit)
      // have no result: the /result probe answers 400 OperationHasNoResult, and
      // the operation state itself is the outcome.
      const resultLoc = res.headers.get("location") ?? `${opUrl}/result`;
      const rr = await fetchFn(resultLoc, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!rr.ok) {
        const body = await rr.text();
        if (rr.status === 400 && /OperationHasNoResult/i.test(body)) return { ...state, _noResult: true };
        const err = new Error(`GET ${resultLoc} -> ${rr.status}: ${body}`);
        err.status = rr.status;
        throw err;
      }
      const rt = await rr.text();
      return rt ? JSON.parse(rt) : {};
    }
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
    if (Number.isFinite(retryAfter)) delay = Math.max(retryAfter * 1000, 1000);
  }
  throw new Error(
    `Poll timed out after ${LRO_MAX_WAIT_MS}ms waiting for the Fabric operation to finish. This is a POLL timeout, not an operation failure — the operation may still be running: ${opUrl}`,
  );
}

async function fabricLro(method, path, body) {
  const res = await fabric(method, path, body);
  if (res && res._accepted && res._location) {
    const retryAfter = res._retryAfter ? parseInt(res._retryAfter, 10) : undefined;
    return pollLro(res._location, retryAfter);
  }
  return res;
}

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "deduped"]);

async function pollJobInstance(
  instanceUrl,
  retryAfterSec,
  { fetchFn = fetch, getTokenFn = getToken, sleepFn = sleep } = {},
) {
  const started = Date.now();
  let delay = Math.max((retryAfterSec ?? 2) * 1000, 2000);
  while (Date.now() - started < LRO_MAX_WAIT_MS) {
    await sleepFn(delay);
    const token = await getTokenFn(FABRIC_SCOPE);
    const res = await fetchFn(instanceUrl, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      delay = Number.isFinite(retryAfter) ? Math.max(retryAfter * 1000, 2000) : delay;
      continue;
    }
    if (!res.ok) throw await httpError(res, "GET", instanceUrl);
    const text = await res.text();
    const state = (text ? JSON.parse(text) : {}) ?? {};
    if (TERMINAL_JOB_STATUSES.has((state.status ?? "").toLowerCase())) return state;
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
    if (Number.isFinite(retryAfter)) delay = Math.max(retryAfter * 1000, 2000);
  }
  const jobInstanceId = jobInstanceIdFrom(instanceUrl);
  throw new Error(
    `Poll timed out after ${LRO_MAX_WAIT_MS}ms waiting for job instance ${jobInstanceId ?? "?"} to reach a terminal status. This is a POLL timeout, not a job failure — the job is still running. Check it with get_item_run / list_item_runs (job_instance_id=${jobInstanceId ?? "?"}): ${instanceUrl}`,
  );
}

/** Extract the job instance GUID from a jobs/instances/{id} Location URL. */
function jobInstanceIdFrom(location) {
  if (!location) return null;
  const match = String(location).match(/\/jobs\/instances\/([0-9a-f-]{36})/i);
  return match ? match[1] : null;
}

function summarizeRun(run) {
  return {
    jobInstanceId: run.id,
    status: run.status,
    invokeType: run.invokeType,
    jobType: run.jobType,
    startTimeUtc: run.startTimeUtc,
    endTimeUtc: run.endTimeUtc,
    durationSec:
      run.startTimeUtc && run.endTimeUtc
        ? Math.round((new Date(run.endTimeUtc) - new Date(run.startTimeUtc)) / 1000)
        : null,
    failureReason: run.failureReason ?? null,
    rootActivityId: run.rootActivityId,
  };
}

export { TERMINAL_JOB_STATUSES, fabricLro, jobInstanceIdFrom, pollJobInstance, pollLro, summarizeRun };
