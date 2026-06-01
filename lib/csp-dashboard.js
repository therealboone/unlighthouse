/**
 * @param {Array<{ id: string, thresholds?: { maxCspViolations?: number } }>} sites
 * @param {Array<{ siteId?: string, status: string, completedAt?: string, summary?: { csp?: { count?: number } } }>} runs
 */
export function buildCspDashboardStats(sites, runs) {
  const completed = runs.filter((run) => run.status === "completed");
  const latestBySite = new Map();

  for (const run of completed) {
    if (!run.siteId) continue;
    const prev = latestBySite.get(run.siteId);
    if (!prev || String(run.completedAt || "") > String(prev.completedAt || "")) {
      latestBySite.set(run.siteId, run);
    }
  }

  const siteStatuses = sites.map((site) => {
    const run = latestBySite.get(site.id);
    const count = run?.summary?.csp?.count ?? null;
    const max = Number.isFinite(site.thresholds?.maxCspViolations)
      ? site.thresholds.maxCspViolations
      : 0;
    const hasIssue = count != null && count > max;
    return {
      siteId: site.id,
      count,
      max,
      hasIssue,
      pass: count == null ? null : count <= max,
      runId: run?.id || null,
    };
  });

  const sitesWithIssues = siteStatuses.filter((row) => row.hasIssue).length;
  const totalViolations = siteStatuses.reduce((sum, row) => sum + (row.count || 0), 0);

  const sorted = [...completed].sort((a, b) =>
    String(b.completedAt || "").localeCompare(String(a.completedAt || ""))
  );
  const recent = sorted.slice(0, 6);
  const prior = sorted.slice(6, 12);
  const recentCsp = recent.reduce((sum, run) => sum + (run.summary?.csp?.count || 0), 0);
  const priorCsp = prior.reduce((sum, run) => sum + (run.summary?.csp?.count || 0), 0);

  const statusBySiteId = Object.fromEntries(siteStatuses.map((row) => [row.siteId, row]));

  return {
    sitesWithIssues,
    totalViolations,
    monitoredSites: sites.length,
    trendDelta: recentCsp - priorCsp,
    statusBySiteId,
  };
}
