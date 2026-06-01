import { generateAiInsights } from "./ai-insights.js";
import { assertPublicScanTarget } from "./url-scan-policy.js";
import { buildRunSummary, computeRunDiff, dispatchAlerts, evaluateAlerts } from "./reporting.js";
import { runLighthouseScan, runSiteWideScan, scanErrorMessage } from "./scanner.js";
import {
  addAlert,
  computeNextRunAt,
  createJob,
  createRun,
  getClient,
  getJob,
  getLatestComparableRun,
  getRun,
  getSite,
  listDueSites,
  listJobs,
  listPageResultsForRun,
  readArtifact,
  replacePageResults,
  touchSiteSchedule,
  updateJob,
  updateRun,
  upsertSite,
  writeArtifact,
} from "./store.js";

let isRunning = false;
let schedulerHandle = null;

function nowIso() {
  return new Date().toISOString();
}

function pageRowsForSingle(summary, artifact) {
  return [
    {
      url: summary.finalUrl,
      status: "completed",
      performance: summary.categories.performance,
      accessibility: summary.categories.accessibility,
      bestPractices: summary.categories.bestPractices,
      seo: summary.categories.seo,
      overall: Math.round(
        (
          summary.categories.performance +
          summary.categories.accessibility +
          summary.categories.bestPractices +
          summary.categories.seo
        ) / 4
      ),
      lcpMs: artifact.audits.find((item) => item.id === "largest-contentful-paint")?.numericValue ?? null,
      cls: artifact.audits.find((item) => item.id === "cumulative-layout-shift")?.numericValue ?? null,
      tbtMs: artifact.audits.find((item) => item.id === "total-blocking-time")?.numericValue ?? null,
      fcpMs: artifact.audits.find((item) => item.id === "first-contentful-paint")?.numericValue ?? null,
      topOpportunities: artifact.topOpportunities || [],
      cspCount: artifact.cspViolations?.length || 0,
      cspViolations: (artifact.cspViolations || []).slice(0, 15),
    },
  ];
}

export function initAutomation() {
  if (schedulerHandle) return;
  schedulerHandle = setInterval(() => {
    void (async () => {
      await enqueueDueScans();
      await processQueue();
    })();
  }, 15_000);
}

export async function createOrUpdateSiteMonitor(input) {
  const site = await upsertSite(input);
  if (site.schedule?.frequency && site.schedule.frequency !== "off" && !site.schedule?.nextRunAt) {
    const nextRunAt = computeNextRunAt(site.schedule.frequency, new Date());
    await touchSiteSchedule(site.id, site.schedule.frequency, nextRunAt);
    return getSite(site.id);
  }
  return site;
}

export async function submitScanJob(input) {
  const site =
    input.siteId && getSite(input.siteId)
      ? getSite(input.siteId)
      : await createOrUpdateSiteMonitor({
          clientName: input.clientName || "Default Client",
          label: input.label || "",
          url: input.url,
          scanMode: input.scanMode,
          formFactor: input.formFactor,
          schedule: {
            frequency: input.scheduleFrequency || "off",
            nextRunAt: input.scheduleFrequency && input.scheduleFrequency !== "off"
              ? computeNextRunAt(input.scheduleFrequency, new Date())
              : null,
          },
          thresholds: input.thresholds,
          alertWebhookUrl: input.alertWebhookUrl,
        });

  const clientId = site?.clientId || null;
  const job = await createJob({
    siteId: site?.id || null,
    clientId,
    source: input.source || "manual",
    scanMode: input.scanMode,
    formFactor: input.formFactor,
    url: input.url,
  });
  void processQueue();
  return job;
}

async function enqueueDueScans() {
  const dueSites = listDueSites(new Date());
  for (const site of dueSites) {
    const existing = listJobs(200).find(
      (job) => job.siteId === site.id && (job.status === "queued" || job.status === "running")
    );
    if (existing) continue;
    const nextRunAt = computeNextRunAt(site.schedule.frequency, new Date());
    await touchSiteSchedule(site.id, site.schedule.frequency, nextRunAt);
    await createJob({
      siteId: site.id,
      clientId: site.clientId,
      source: "scheduled",
      scanMode: site.scanMode,
      formFactor: site.defaultFormFactor,
      url: site.url,
    });
  }
}

async function processQueue() {
  if (isRunning) return;
  const nextJob = listJobs(500)
    .filter((job) => job.status === "queued")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  if (!nextJob) return;
  isRunning = true;
  try {
    await executeJob(nextJob);
  } finally {
    isRunning = false;
  }
  if (listJobs(500).some((job) => job.status === "queued")) {
    void processQueue();
  }
}

async function executeJob(job) {
  const site = job.siteId ? getSite(job.siteId) : null;
  try {
    await updateJob(job.id, {
      status: "running",
      startedAt: nowIso(),
      progress: 5,
      message: "Validating target",
    });
    await assertPublicScanTarget(job.url);

    const run = await createRun({
      jobId: job.id,
      siteId: job.siteId,
      clientId: job.clientId,
      url: job.url,
      scanMode: job.scanMode,
      formFactor: job.formFactor,
      status: "running",
    });
    await updateJob(job.id, {
      runId: run.id,
      progress: 20,
      message: job.scanMode === "site" ? "Scanning full site" : "Running Lighthouse",
    });

    const result =
      job.scanMode === "site"
        ? await runSiteWideScan(job.url, job.formFactor)
        : await runLighthouseScan(job.url, job.formFactor);

    await updateJob(job.id, {
      progress: 75,
      message: "Persisting results",
    });

    const pageResults =
      job.scanMode === "site" ? result.summary.rows.map((row) => ({ ...row })) : pageRowsForSingle(result.summary, result.artifact);
    const maxCspViolations = Number.isFinite(site?.thresholds?.maxCspViolations)
      ? site.thresholds.maxCspViolations
      : 0;
    const summary = buildRunSummary(job.scanMode, result.summary, result.artifact, pageResults, {
      maxCspViolations,
    });
    const artifactPath = await writeArtifact(run.id, result.artifact);
    await replacePageResults(run.id, pageResults);
    await updateRun(run.id, {
      summary,
      artifactPath,
    });

    const previousRun = job.siteId
      ? getLatestComparableRun(job.siteId, job.scanMode, job.formFactor, run.id)
      : null;
    const previousPages = previousRun ? listPageResultsForRun(previousRun.id) : [];
    const diff = computeRunDiff(
      { ...run, scanMode: job.scanMode, summary },
      previousRun,
      pageResults,
      previousPages
    );

    await updateJob(job.id, {
      progress: 88,
      message: "Generating report insights",
    });

    const draftRun = getRun(run.id);
    const completedRun = {
      ...draftRun,
      summary,
      diff,
      completedAt: nowIso(),
      scanMode: job.scanMode,
      formFactor: job.formFactor,
      url: job.url,
    };
    const alerts = evaluateAlerts(site, completedRun, pageResults);
    const dispatches = await dispatchAlerts(site, completedRun, alerts);
    const alertIds = [];
    for (const [index, alert] of alerts.entries()) {
      const stored = await addAlert({
        siteId: job.siteId,
        clientId: job.clientId,
        runId: run.id,
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        channels: dispatches.map((dispatch) => ({
          ...dispatch,
          batchIndex: index,
        })),
      });
      alertIds.push(stored.id);
    }

    const artifact = await readArtifact(getRun(run.id));
    const aiInsights = await generateAiInsights(completedRun, artifact, pageResults);

    await updateRun(run.id, {
      status: "completed",
      completedAt: completedRun.completedAt,
      summary,
      diff,
      alerts: alertIds,
      aiInsights,
    });
    await updateJob(job.id, {
      status: "completed",
      progress: 100,
      message: "Completed",
      completedAt: completedRun.completedAt,
    });
  } catch (err) {
    const message = scanErrorMessage(err);
    const currentJob = getJob(job.id);
    if (currentJob?.runId) {
      await updateRun(currentJob.runId, {
        status: "failed",
        completedAt: nowIso(),
      });
    }
    await updateJob(job.id, {
      status: "failed",
      progress: 100,
      message: "Failed",
      error: message,
      completedAt: nowIso(),
    });
  }
}

export function isQueueBusy() {
  return isRunning;
}

export function getJobStatus(jobId) {
  return getJob(jobId);
}

export function getRunStatus(runId) {
  return getRun(runId);
}

export function getSiteClient(site) {
  return site?.clientId ? getClient(site.clientId) : null;
}
