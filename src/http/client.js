import { getToken } from "../auth/credentials.js";
import {
  FABRIC_BASE,
  FABRIC_SCOPE,
  MAX_RETRIES,
  ONELAKE_BASE,
  PBI_BASE,
  PBI_SCOPE,
  REQUEST_TIMEOUT_MS,
  RETRY_MAX_DELAY_MS,
  STORAGE_SCOPE,
} from "../config.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function httpError(res, method, target) {
  const text = await res.text();
  const err = new Error(`${method} ${target} -> ${res.status}: ${text}`);
  err.status = res.status;
  return err;
}

function getRetryDelay(headers, attempt, fallbackMs) {
  const retryAfter = parseInt(headers.get("retry-after") ?? "", 10);
  return Number.isFinite(retryAfter)
    ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
    : Math.min(2 ** attempt * fallbackMs, RETRY_MAX_DELAY_MS);
}

async function apiRequest(base, scope, method, path, body, extraQuery = {}) {
  const token = await getToken(scope);
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(extraQuery)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const backoffMs = getRetryDelay(res.headers, attempt, 500);
      console.error(
        `[fabric-mcp] 429 throttled on ${method} ${path}; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(backoffMs);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    const parsed = text ? JSON.parse(text) : {};
    const result = parsed && typeof parsed === "object" ? parsed : { value: parsed };
    if (res.status === 202) {
      result._accepted = true;
      result._location = res.headers.get("location") ?? undefined;
      result._retryAfter = res.headers.get("retry-after") ?? undefined;
    }
    return result;
  }
}

async function fabric(method, path, body, extraQuery = {}) {
  return apiRequest(FABRIC_BASE, FABRIC_SCOPE, method, path, body, extraQuery);
}

async function powerbi(method, path, body, extraQuery = {}) {
  return apiRequest(PBI_BASE, PBI_SCOPE, method, path, body, extraQuery);
}

async function readResponseBytes(res, maxBytes) {
  if (!res.body) return { buffer: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  let truncated = false;
  try {
    while (bytesRead <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes + 1 - bytesRead;
      if (value.byteLength > remaining) {
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        bytesRead += remaining;
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (truncated) await reader.cancel();
  }
  return { buffer: Buffer.concat(chunks, bytesRead), truncated };
}

async function onelake(method, path, { query = {}, raw = false, maxBytes } = {}) {
  const token = await getToken(STORAGE_SCOPE);
  const url = new URL(`${ONELAKE_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const headers = { Authorization: `Bearer ${token}` };
    if (raw && maxBytes != null) headers.Range = `bytes=0-${maxBytes}`;
    const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(getRetryDelay(res.headers, attempt, 500));
      continue;
    }
    if (!res.ok) {
      throw await httpError(res, method, path);
    }
    if (raw) {
      if (maxBytes != null) {
        const { buffer, truncated } = await readResponseBytes(res, maxBytes);
        const contentRange = res.headers.get("content-range");
        const totalMatch = contentRange?.match(/\/(\d+)$/);
        const totalBytes = totalMatch ? Number(totalMatch[1]) : undefined;
        return {
          text: buffer.subarray(0, maxBytes).toString("utf8"),
          bytesRead: Math.min(buffer.length, maxBytes),
          totalBytes,
          truncated: truncated || (totalBytes != null && totalBytes > maxBytes),
        };
      }
      return res.text();
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
}

async function fabricListAll(path, valueKey = "value", cap = 500) {
  const items = [];
  let token = null;
  do {
    const data = await fabric("GET", path, null, token ? { continuationToken: token } : {});
    for (const value of data[valueKey] ?? []) items.push(value);
    token = data.continuationToken ?? null;
  } while (token && items.length < cap);
  return items;
}

export { apiRequest, fabric, fabricListAll, httpError, onelake, powerbi, readResponseBytes, sleep };
