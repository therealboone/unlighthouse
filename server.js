import compression from "compression";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import {
  createOrUpdateSiteMonitor,
  getSiteClient,
  initAutomation,
  isQueueBusy,
  submitScanJob,
} from "./lib/automation.js";
import { buildCspDashboardStats } from "./lib/csp-dashboard.js";
import { runToCsv, runToCspCsv } from "./lib/reporting.js";
import { normalizeFormFactor, normalizeScanMode, normalizeTarget, scanErrorMessage } from "./lib/scanner.js";
import {
  deleteSite,
  getClient,
  getJob,
  getRun,
  getSite,
  initStore,
  listAlerts,
  listJobs,
  listPageResultsForRun,
  listRuns,
  listRunsForSite,
  listSites,
  markStaleJobsFailed,
  readArtifact,
  updateSite,
} from "./lib/store.js";
import { assertPublicScanTarget } from "./lib/url-scan-policy.js";

const app = express();
const isProd = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 4173;
const SITE_SCAN_TIMEOUT_MS = Number(process.env.SITE_SCAN_TIMEOUT_MS) || 45 * 60 * 1000;

if (isProd || process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(compression());
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true, limit: "64kb" }));
app.use(express.json({ limit: "64kb" }));

const scanLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || (isProd ? 20 : 120),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.RATE_LIMIT_DISABLED === "true",
  handler: async (req, res) => {
    return renderIndex(res, {
      error: "Too many scan requests from this address. Please wait a few minutes.",
      formDefaults: formDefaultsFromBody(req.body),
      statusCode: 429,
    });
  },
});

function parseThresholds(body) {
  const n = (value, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };
  return {
    minPerformance: n(body.minPerformance, 80),
    minAccessibility: n(body.minAccessibility, 85),
    minBestPractices: n(body.minBestPractices, 85),
    minSeo: n(body.minSeo, 85),
    minOverall: n(body.minOverall, 80),
    maxLcpMs: n(body.maxLcpMs, 2500),
    maxCls: n(body.maxCls, 0.1),
    maxCspViolations: n(body.maxCspViolations, 0),
  };
}

function formDefaultsFromBody(body = {}) {
  return {
    submittedUrl: String(body.url || ""),
    clientName: String(body.clientName || "Default Client"),
    siteLabel: String(body.siteLabel || ""),
    formFactor: normalizeFormFactor(body.formFactor),
    scanMode: normalizeScanMode(body.scanMode),
    scheduleFrequency: normalizeScheduleFrequency(body.scheduleFrequency),
    alertWebhookUrl: String(body.alertWebhookUrl || ""),
    thresholds: parseThresholds(body),
  };
}

function normalizeScheduleFrequency(value) {
  const s = String(value || "off").toLowerCase();
  return ["off", "daily", "weekly"].includes(s) ? s : "off";
}

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function routeToRunUrl(job) {
  if (job?.runId) return `/runs/${job.runId}`;
  return null;
}

async function renderIndex(res, overrides = {}) {
  const context = {
    isProd,
    queueBusy: isQueueBusy(),
    sites: listSites(),
    recentJobs: listJobs(12),
    recentRuns: listRuns(12),
    recentAlerts: listAlerts(12),
    cspDashboard: buildCspDashboardStats(listSites(), listRuns(100)),
    hasCspFilter: false,
    error: null,
    notice: null,
    formDefaults: {
      submittedUrl: "",
      clientName: "Default Client",
      siteLabel: "",
      formFactor: "mobile",
      scanMode: "single",
      scheduleFrequency: "off",
      alertWebhookUrl: "",
      thresholds: parseThresholds({}),
    },
    formatDate,
    ...overrides,
  };
  return res.status(overrides.statusCode || 200).render("index", context);
}

async function buildRunView(runId) {
  const run = getRun(runId);
  if (!run) return null;
  const site = run.siteId ? getSite(run.siteId) : null;
  const client = run.clientId ? getClient(run.clientId) : site ? getSiteClient(site) : null;
  const pages = listPageResultsForRun(run.id);
  const artifact = await readArtifact(run);
  const alerts = (run.alerts || []).map((alertId) => listAlerts(500).find((item) => item.id === alertId)).filter(Boolean);
  return {
    run,
    site,
    client,
    pages,
    artifact,
    alerts,
  };
}

async function validateTargetOrRender(res, defaults) {
  const target = normalizeTarget(defaults.submittedUrl);
  if (!target) {
    await renderIndex(res, {
      error: "Please enter a valid http(s) URL without embedded credentials.",
      formDefaults: defaults,
      statusCode: 400,
    });
    return null;
  }
  try {
    await assertPublicScanTarget(target);
    return target;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    await renderIndex(res, {
      error: code === "BLOCKED_HOST" || code === "DNS_FAILED" ? scanErrorMessage(err) : `Invalid target: ${err.message}`,
      formDefaults: { ...defaults, submittedUrl: target },
      statusCode: code === "BLOCKED_HOST" ? 403 : 400,
    });
    return null;
  }
}

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    queueBusy: isQueueBusy(),
    jobsTracked: listJobs(500).length,
    uptime: process.uptime(),
  });
});

app.get("/", async (req, res) => {
  const notice = String(req.query.notice || "").trim() || null;
  const error = String(req.query.error || "").trim() || null;
  const hasCspFilter = String(req.query.hasCsp || "") === "1";
  const sites = listSites();
  const allRuns = listRuns(100);
  let recentRuns = allRuns.slice(0, 12);
  if (hasCspFilter) {
    recentRuns = allRuns.filter((run) => (run.summary?.csp?.count || 0) > 0).slice(0, 12);
  }
  const cspDashboard = buildCspDashboardStats(sites, allRuns);
  await renderIndex(res, { notice, error, sites, recentRuns, cspDashboard, hasCspFilter });
});

app.post("/scan", scanLimiter, async (req, res) => {
  const defaults = formDefaultsFromBody(req.body);
  const target = await validateTargetOrRender(res, defaults);
  if (!target) return;
  try {
    const job = await submitScanJob({
      clientName: defaults.clientName,
      label: defaults.siteLabel,
      url: target,
      scanMode: defaults.scanMode,
      formFactor: defaults.formFactor,
      scheduleFrequency: defaults.scheduleFrequency,
      thresholds: defaults.thresholds,
      alertWebhookUrl: defaults.alertWebhookUrl,
      source: "manual",
    });
    return res.redirect(`/jobs/${job.id}`);
  } catch (err) {
    console.error("Queue error:", err);
    return renderIndex(res, {
      error: `Scan failed: ${scanErrorMessage(err)}`,
      formDefaults: { ...defaults, submittedUrl: target },
      statusCode: 500,
    });
  }
});

app.post("/sites", scanLimiter, async (req, res) => {
  const defaults = formDefaultsFromBody(req.body);
  const target = await validateTargetOrRender(res, defaults);
  if (!target) return;
  try {
    const site = await createOrUpdateSiteMonitor({
      clientName: defaults.clientName,
      label: defaults.siteLabel || new URL(target).hostname,
      url: target,
      scanMode: defaults.scanMode,
      formFactor: defaults.formFactor,
      schedule: {
        frequency: defaults.scheduleFrequency,
        nextRunAt: defaults.scheduleFrequency !== "off" ? null : null,
      },
      thresholds: defaults.thresholds,
      alertWebhookUrl: defaults.alertWebhookUrl,
    });
    return res.redirect(`/sites/${site.id}`);
  } catch (err) {
    console.error("Site save error:", err);
    return renderIndex(res, {
      error: `Could not save site monitor: ${scanErrorMessage(err)}`,
      formDefaults: { ...defaults, submittedUrl: target },
      statusCode: 500,
    });
  }
});

app.post("/sites/:id/run", scanLimiter, async (req, res) => {
  const site = getSite(req.params.id);
  if (!site) {
    return res.status(404).send("Site not found.");
  }
  try {
    const job = await submitScanJob({
      siteId: site.id,
      url: site.url,
      scanMode: site.scanMode,
      formFactor: site.defaultFormFactor,
      source: "manual",
    });
    return res.redirect(`/jobs/${job.id}`);
  } catch (err) {
    return res.status(500).send(`Could not queue run: ${scanErrorMessage(err)}`);
  }
});

async function handleDeleteSite(req, res, { redirect = true } = {}) {
  try {
    const result = await deleteSite(req.params.id);
    if (!result) {
      if (redirect) return res.status(404).send("Site not found.");
      return res.status(404).json({ error: "Site not found" });
    }
    if (redirect) {
      const message = `Deleted "${result.label}" and ${result.deletedRuns} scan run(s).`;
      return res.redirect(`/?notice=${encodeURIComponent(message)}`);
    }
    return res.json({ ok: true, ...result });
  } catch (err) {
    if (err.code === "SITE_BUSY") {
      const message = "Cannot delete this site while a scan is queued or running.";
      if (redirect) {
        const site = getSite(req.params.id);
        if (site) {
          return res.redirect(`/sites/${site.id}?error=${encodeURIComponent(message)}`);
        }
        return res.redirect(`/?error=${encodeURIComponent(message)}`);
      }
      return res.status(409).json({ error: message });
    }
    console.error("Site delete error:", err);
    if (redirect) return res.status(500).send(`Could not delete site: ${scanErrorMessage(err)}`);
    return res.status(500).json({ error: scanErrorMessage(err) });
  }
}

app.post("/sites/:id/delete", async (req, res) => {
  return handleDeleteSite(req, res, { redirect: true });
});

app.post("/sites/:id/settings", async (req, res) => {
  const site = getSite(req.params.id);
  if (!site) {
    return res.status(404).send("Site not found.");
  }
  const nextSite = await updateSite(site.id, {
    label: req.body.label,
    url: normalizeTarget(req.body.url) || site.url,
    scanMode: normalizeScanMode(req.body.scanMode),
    defaultFormFactor: normalizeFormFactor(req.body.formFactor),
    schedule: {
      frequency: normalizeScheduleFrequency(req.body.scheduleFrequency),
      nextRunAt: site.schedule?.nextRunAt || null,
    },
    thresholds: parseThresholds(req.body),
    alertChannels: {
      webhookUrl: String(req.body.alertWebhookUrl || ""),
    },
  });
  return res.redirect(`/sites/${nextSite.id}`);
});

app.get("/sites/:id", async (req, res) => {
  const site = getSite(req.params.id);
  if (!site) {
    return res.status(404).send("Site not found.");
  }
  const error = String(req.query.error || "").trim() || null;
  const runs = listRunsForSite(site.id, 25);
  const latestRun = runs.find((run) => run.status === "completed") || null;
  res.render("site", {
    isProd,
    site,
    client: getClient(site.clientId),
    runs,
    latestRun,
    alerts: listAlerts(100).filter((alert) => alert.siteId === site.id).slice(0, 20),
    error,
    formatDate,
  });
});

app.get("/jobs/:id", async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).send("Job not found.");
  }
  const runView = job.runId ? await buildRunView(job.runId) : null;
  res.render("job", {
    isProd,
    job,
    run: runView?.run || null,
    runUrl: routeToRunUrl(job),
    site: job.siteId ? getSite(job.siteId) : null,
    formatDate,
  });
});

app.get("/runs/:id", async (req, res) => {
  const view = await buildRunView(req.params.id);
  if (!view) {
    return res.status(404).send("Run not found.");
  }
  res.render("run", {
    isProd,
    ...view,
    reportMode: false,
    formatDate,
  });
});

app.get("/exports/:id/csp", async (req, res) => {
  const view = await buildRunView(req.params.id);
  if (!view) {
    return res.status(404).send("Run not found.");
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${view.run.id}-csp.csv"`);
  return res.send(runToCspCsv(view.run, view.pages, view.artifact));
});

app.get("/exports/:id", async (req, res) => {
  const view = await buildRunView(req.params.id);
  if (!view) {
    return res.status(404).send("Run not found.");
  }
  if (String(req.query?.format || "").toLowerCase() === "csp") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${view.run.id}-csp.csv"`);
    return res.send(runToCspCsv(view.run, view.pages, view.artifact));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${view.run.id}.csv"`);
  return res.send(runToCsv(view.run, view.pages));
});

app.get("/reports/:id", async (req, res) => {
  const view = await buildRunView(req.params.id);
  if (!view) {
    return res.status(404).send("Run not found.");
  }
  if (String(req.query?.format || "").toLowerCase() === "csv" || String(req.originalUrl || "").includes("format=csv")) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${view.run.id}.csv"`);
    return res.send(runToCsv(view.run, view.pages));
  }
  res.render("run", {
    isProd,
    ...view,
    reportMode: true,
    formatDate,
  });
});

app.get("/api/jobs/:id", async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json({
    job,
    run: job.runId ? getRun(job.runId) : null,
  });
});

app.get("/api/runs", async (req, res) => {
  return res.json({ runs: listRuns(50) });
});

app.get("/api/runs/:id", async (req, res) => {
  const view = await buildRunView(req.params.id);
  if (!view) return res.status(404).json({ error: "Run not found" });
  return res.json(view);
});

app.get("/api/sites/:id", async (req, res) => {
  const site = getSite(req.params.id);
  if (!site) return res.status(404).json({ error: "Site not found" });
  return res.json({
    site,
    client: getClient(site.clientId),
    runs: listRunsForSite(site.id, 50),
    alerts: listAlerts(200).filter((alert) => alert.siteId === site.id),
  });
});

app.delete("/api/sites/:id", async (req, res) => {
  return handleDeleteSite(req, res, { redirect: false });
});

async function bootstrap() {
  await initStore();
  await markStaleJobsFailed();
  initAutomation();

  const server = app.listen(PORT, () => {
    console.log(
      `Lighthouse Scanner listening on port ${PORT} (${isProd ? "production" : "development"}) — health: http://localhost:${PORT}/health`
    );
  });

  server.timeout = SITE_SCAN_TIMEOUT_MS + 120000;
  server.headersTimeout = SITE_SCAN_TIMEOUT_MS + 120000;
  server.requestTimeout = SITE_SCAN_TIMEOUT_MS + 120000;

  function shutdown(signal) {
    console.log(`Received ${signal}, closing server…`);
    server.close(() => {
      console.log("HTTP server closed.");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("Forced exit after timeout.");
      process.exit(1);
    }, 15_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  console.error("Server bootstrap failed:", err);
  process.exit(1);
});
