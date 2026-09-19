const UNBOUND = new Set(["automatic", "none"]);

function isUnbound(connection) {
  return UNBOUND.has((connection.connectivityType ?? "").toLowerCase()) || !connection.id;
}

function connectionOut(connection) {
  return {
    id: connection.id ?? null,
    displayName: connection.displayName ?? null,
    connectivityType: connection.connectivityType,
    gatewayId: connection.gatewayId ?? null,
    connectionDetails: connection.connectionDetails ?? null,
    bound: !isUnbound(connection),
  };
}

/**
 * For each unbound data source on the target model, find a bound connection on
 * the source model with the same connection type and path. Returns the bind
 * plan plus anything that could not be matched.
 */
function matchConnections(targetConnections, sourceConnections) {
  const bound = (sourceConnections ?? []).filter((connection) => !isUnbound(connection));
  const plan = [];
  const unmatched = [];
  const alreadyBound = [];
  for (const target of targetConnections ?? []) {
    if (!isUnbound(target)) {
      alreadyBound.push(connectionOut(target));
      continue;
    }
    const type = (target.connectionDetails?.type ?? "").toLowerCase();
    const path = normalizePath(target.connectionDetails?.path);
    const exact = bound.filter(
      (candidate) =>
        (candidate.connectionDetails?.type ?? "").toLowerCase() === type &&
        normalizePath(candidate.connectionDetails?.path) === path,
    );
    const byType = exact.length ? exact : bound.filter((candidate) => (candidate.connectionDetails?.type ?? "").toLowerCase() === type);
    if (byType.length === 1) {
      plan.push({
        target: connectionOut(target),
        source: connectionOut(byType[0]),
        matchedBy: exact.length ? "type+path" : "type",
      });
    } else {
      unmatched.push({ target: connectionOut(target), candidates: byType.map(connectionOut) });
    }
  }
  return { plan, unmatched, alreadyBound };
}

function normalizePath(path) {
  return (path ?? "").toLowerCase().replace(/\/+$/, "");
}

export { connectionOut, isUnbound, matchConnections };
