import { aggregateSiteCsp, buildCspRunSummary, diffCspViolations, violationsToCsv } from "./csp-console.js";

function round(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function getAuditMap(artifact) {
  const items = artifact?.audits || [];
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

export function buildRunSummary(scanMode, summary, artifact, pageResults = [], options = {}) {
  const maxCsp = Number.isFinite(options.maxCspViolations) ? options.maxCspViolations : 0;
  if (scanMode === "site") {
    const perf = average(pageResults.map((row) => row.performance));
    const a11y = average(pageResults.map((row) => row.accessibility));
    const bp = average(pageResults.map((row) => row.bestPractices));
    const seo = average(pageResults.map((row) => row.seo));
    const overall = average(pageResults.map((row) => row.overall));
    return {
      kind: "site",
      routeCount: summary.routeCount || pageResults.length,
      capped: Boolean(summary.capped),
      avgScores: {
        performance: round(perf),
        accessibility: round(a11y),
        bestPractices: round(bp),
        seo: round(seo),
        overall: round(overall),
      },
      lowPages: [...pageResults]
        .filter((row) => row.overall != null)
        .sort((a, b) => (a.overall ?? 999) - (b.overall ?? 999))
        .slice(0, 5)
        .map((row) => ({
          url: row.url,
          overall: row.overall,
          performance: row.performance,
          accessibility: row.accessibility,
          bestPractices: row.bestPractices,
          seo: row.seo,
        })),
      topIssues: artifact?.topIssues || [],
      note: summary.note || null,
      csp: aggregateSiteCsp(pageResults, maxCsp),
    };
  }

  const audits = getAuditMap(artifact);
  const cspViolations = artifact?.cspViolations || [];
  return {
    kind: "single",
    finalUrl: summary.finalUrl,
    categories: summary.categories,
    csp: summary.csp || buildCspRunSummary(cspViolations, maxCsp),
    overall: round(
      average([
        summary.categories?.performance,
        summary.categories?.accessibility,
        summary.categories?.bestPractices,
        summary.categories?.seo,
      ])
    ),
    metrics: {
      lcpMs: round(audits["largest-contentful-paint"]?.numericValue),
      cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
      tbtMs: round(audits["total-blocking-time"]?.numericValue),
      fcpMs: round(audits["first-contentful-paint"]?.numericValue),
      speedIndexMs: round(audits["speed-index"]?.numericValue),
    },
    topOpportunities: artifact?.topOpportunities || [],
  };
}

export function computeRunDiff(currentRun, previousRun, currentPages = [], previousPages = []) {
  if (!previousRun) return null;
  if (currentRun.scanMode === "site") {
    const previousByUrl = new Map(previousPages.map((row) => [row.url, row]));
    let improvedPages = 0;
    let regressedPages = 0;
    let newPages = 0;
    for (const row of currentPages) {
      const prev = previousByUrl.get(row.url);
      if (!prev) {
        newPages += 1;
        continue;
      }
      if ((row.overall ?? 0) > (prev.overall ?? 0)) improvedPages += 1;
      if ((row.overall ?? 0) < (prev.overall ?? 0)) regressedPages += 1;
    }
    const currentCsp = currentRun.summary?.csp?.count ?? 0;
    const previousCsp = previousRun.summary?.csp?.count ?? 0;
    const cspMessageDiff = diffCspViolations(
      currentRun.summary?.csp?.violations || [],
      previousRun.summary?.csp?.violations || []
    );
    return {
      avgScores: diffObjects(currentRun.summary?.avgScores, previousRun.summary?.avgScores),
      routeCountDelta: (currentRun.summary?.routeCount || 0) - (previousRun.summary?.routeCount || 0),
      improvedPages,
      regressedPages,
      newPages,
      cspCountDelta: currentCsp - previousCsp,
      cspPagesDelta:
        (currentRun.summary?.csp?.pageCount ?? 0) - (previousRun.summary?.csp?.pageCount ?? 0),
      ...cspMessageDiff,
    };
  }

  const currentCsp = currentRun.summary?.csp?.count ?? 0;
  const previousCsp = previousRun.summary?.csp?.count ?? 0;
  const cspMessageDiff = diffCspViolations(
    currentRun.summary?.csp?.violations || [],
    previousRun.summary?.csp?.violations || []
  );
  return {
    categories: diffObjects(currentRun.summary?.categories, previousRun.summary?.categories),
    metrics: diffObjects(currentRun.summary?.metrics, previousRun.summary?.metrics),
    overallDelta: (currentRun.summary?.overall ?? 0) - (previousRun.summary?.overall ?? 0),
    cspCountDelta: currentCsp - previousCsp,
    ...cspMessageDiff,
  };
}

function diffObjects(current = {}, previous = {}) {
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(previous || {})]);
  const out = {};
  for (const key of keys) {
    if (!Number.isFinite(current[key]) || !Number.isFinite(previous[key])) continue;
    out[key] = round(current[key] - previous[key]);
  }
  return out;
}

function evaluateCspAlerts(site, run) {
  const thresholds = site?.thresholds || {};
  const maxAllowed = Number.isFinite(thresholds.maxCspViolations) ? thresholds.maxCspViolations : 0;
  const count = run.summary?.csp?.count ?? 0;
  const alerts = [];
  if (count > maxAllowed) {
    const sample =
      (run.summary?.csp?.violations || [])[0]?.message || run.summary?.csp?.topPages?.[0]?.sample;
    alerts.push({
      severity: "warning",
      title: "CSP console violations detected",
      message: `${site.label} logged ${count} Content-Security-Policy console violation(s), above the allowed threshold of ${maxAllowed}.${sample ? ` Example: ${sample.slice(0, 180)}` : ""}`,
    });
  }
  if ((run.diff?.newCount || 0) > 0) {
    const sample = run.diff.newViolations?.[0]?.message;
    alerts.push({
      severity: "warning",
      title: "New CSP violations since last run",
      message: `${site.label} has ${run.diff.newCount} new CSP console message(s) compared with the previous run.${sample ? ` Example: ${sample.slice(0, 180)}` : ""}`,
    });
  }
  return alerts;
}

export function evaluateAlerts(site, run, pageResults) {
  const thresholds = site?.thresholds || {};
  const alerts = [...evaluateCspAlerts(site, run)];
  if (run.scanMode === "single") {
    const categories = run.summary?.categories || {};
    if (Number.isFinite(categories.performance) && categories.performance < thresholds.minPerformance) {
      alerts.push({
        severity: "warning",
        title: "Performance score below threshold",
        message: `${site.label} scored ${categories.performance} for performance, below the threshold of ${thresholds.minPerformance}.`,
      });
    }
    if (Number.isFinite(categories.accessibility) && categories.accessibility < thresholds.minAccessibility) {
      alerts.push({
        severity: "warning",
        title: "Accessibility score below threshold",
        message: `${site.label} scored ${categories.accessibility} for accessibility, below the threshold of ${thresholds.minAccessibility}.`,
      });
    }
    const lcp = run.summary?.metrics?.lcpMs;
    if (Number.isFinite(lcp) && lcp > thresholds.maxLcpMs) {
      alerts.push({
        severity: "warning",
        title: "LCP above threshold",
        message: `${site.label} recorded LCP ${lcp}ms, above the threshold of ${thresholds.maxLcpMs}ms.`,
      });
    }
    const cls = run.summary?.metrics?.cls;
    if (Number.isFinite(cls) && cls > thresholds.maxCls) {
      alerts.push({
        severity: "warning",
        title: "CLS above threshold",
        message: `${site.label} recorded CLS ${cls}, above the threshold of ${thresholds.maxCls}.`,
      });
    }
    return alerts;
  }

  const avgScores = run.summary?.avgScores || {};
  if (Number.isFinite(avgScores.overall) && avgScores.overall < thresholds.minOverall) {
    alerts.push({
      severity: "warning",
      title: "Average site score below threshold",
      message: `${site.label} averaged ${avgScores.overall}, below the threshold of ${thresholds.minOverall}.`,
    });
  }
  const failingPages = pageResults.filter(
    (row) => Number.isFinite(row.overall) && row.overall < thresholds.minOverall
  );
  if (failingPages.length) {
    alerts.push({
      severity: "warning",
      title: "Pages below score threshold",
      message: `${failingPages.length} pages scored below ${thresholds.minOverall}.`,
    });
  }
  return alerts;
}

export async function dispatchAlerts(site, run, alerts) {
  const webhookUrl = String(site?.alertChannels?.webhookUrl || "").trim();
  if (!webhookUrl || !alerts.length) {
    return alerts.map((alert) => ({ type: "webhook", status: webhookUrl ? "skipped" : "disabled" }));
  }
  const payload = {
    site: {
      id: site.id,
      label: site.label,
      url: site.url,
    },
    run: {
      id: run.id,
      scanMode: run.scanMode,
      formFactor: run.formFactor,
      completedAt: run.completedAt,
    },
    csp: {
      status: run.summary?.csp?.status || "unknown",
      count: run.summary?.csp?.count ?? 0,
      maxAllowed: run.summary?.csp?.maxAllowed ?? site?.thresholds?.maxCspViolations ?? 0,
      groups: run.summary?.csp?.groups || null,
      newCount: run.diff?.newCount ?? 0,
    },
    alerts,
  };
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return [
      {
        type: "webhook",
        status: response.ok ? "sent" : "failed",
        statusCode: response.status,
      },
    ];
  } catch (err) {
    return [
      {
        type: "webhook",
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      },
    ];
  }
}

export function runToCspCsv(run, pageResults = [], artifact = null) {
  if (run.scanMode === "site") {
    const rows = [];
    for (const page of pageResults) {
      for (const item of page.cspViolations || []) {
        rows.push({ ...item, url: item.url || page.url });
      }
    }
    return violationsToCsv(rows);
  }
  return violationsToCsv(run.summary?.csp?.violations || artifact?.cspViolations || []);
}

export function runToCsv(run, pageResults = []) {
  const esc = (value) => {
    const str = value == null ? "" : String(value);
    if (str.includes('"') || str.includes(",") || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [];
  if (run.scanMode === "single") {
    lines.push(
      [
        "run_id",
        "site_url",
        "device",
        "final_url",
        "performance",
        "accessibility",
        "best_practices",
        "seo",
        "overall",
        "lcp_ms",
        "cls",
        "tbt_ms",
        "fcp_ms",
        "csp_violations",
      ].join(",")
    );
    lines.push(
      [
        esc(run.id),
        esc(run.url),
        esc(run.formFactor),
        esc(run.summary?.finalUrl),
        esc(run.summary?.categories?.performance),
        esc(run.summary?.categories?.accessibility),
        esc(run.summary?.categories?.bestPractices),
        esc(run.summary?.categories?.seo),
        esc(run.summary?.overall),
        esc(run.summary?.metrics?.lcpMs),
        esc(run.summary?.metrics?.cls),
        esc(run.summary?.metrics?.tbtMs),
        esc(run.summary?.metrics?.fcpMs),
        esc(run.summary?.csp?.count ?? 0),
      ].join(",")
    );
    return lines.join("\n");
  }

  lines.push(
    [
      "run_id",
      "site_url",
      "device",
      "url",
      "status",
      "performance",
      "accessibility",
      "best_practices",
      "seo",
      "overall",
      "csp_violations",
    ].join(",")
  );
  for (const page of pageResults) {
    lines.push(
      [
        esc(run.id),
        esc(run.url),
        esc(run.formFactor),
        esc(page.url),
        esc(page.status),
        esc(page.performance),
        esc(page.accessibility),
        esc(page.bestPractices),
        esc(page.seo),
        esc(page.overall),
        esc(page.cspCount ?? 0),
      ].join(",")
    );
  }
  return lines.join("\n");
}
