import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");
const ARTIFACT_DIR = join(DATA_DIR, "artifacts");
const DB_PATH = join(DATA_DIR, "db.json");

const DEFAULT_STATE = {
  version: 1,
  clients: [],
  sites: [],
  jobs: [],
  scanRuns: [],
  pageResults: [],
  alerts: [],
};

let state = structuredClone(DEFAULT_STATE);

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortedCopy(items, field = "createdAt") {
  return [...items].sort((a, b) => String(b[field] || "").localeCompare(String(a[field] || "")));
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
}

async function saveState() {
  await ensureDataDir();
  const tmpPath = `${DB_PATH}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
  await rename(tmpPath, DB_PATH);
}

export async function initStore() {
  await ensureDataDir();
  if (!existsSync(DB_PATH)) {
    await saveState();
    return;
  }
  try {
    const raw = await readFile(DB_PATH, "utf8");
    const parsed = raw ? JSON.parse(raw) : {};
    state = {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      clients: Array.isArray(parsed.clients) ? parsed.clients : [],
      sites: Array.isArray(parsed.sites) ? parsed.sites : [],
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      scanRuns: Array.isArray(parsed.scanRuns) ? parsed.scanRuns : [],
      pageResults: Array.isArray(parsed.pageResults) ? parsed.pageResults : [],
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
    };
  } catch {
    state = structuredClone(DEFAULT_STATE);
    await saveState();
  }
}

export function getState() {
  return clone(state);
}

function nextId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeSiteUrl(url) {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function defaultThresholds() {
  return {
    minPerformance: 80,
    minAccessibility: 85,
    minBestPractices: 85,
    minSeo: 85,
    minOverall: 80,
    maxLcpMs: 2500,
    maxCls: 0.1,
    maxCspViolations: 0,
  };
}

export async function upsertClientByName(name) {
  const trimmed = String(name || "").trim() || "Default Client";
  const existing = state.clients.find((client) => client.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    return clone(existing);
  }
  const client = {
    id: nextId("client"),
    name: trimmed,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.clients.push(client);
  await saveState();
  return clone(client);
}

export async function upsertSite(input) {
  const client = await upsertClientByName(input.clientName);
  const canonicalUrl = normalizeSiteUrl(input.url);
  const existing = state.sites.find(
    (site) => site.clientId === client.id && site.url === canonicalUrl && site.scanMode === input.scanMode
  );
  const hostname = (() => {
    try {
      return new URL(canonicalUrl).hostname;
    } catch {
      return canonicalUrl;
    }
  })();
  const incomingSchedule = input.schedule ? normalizeSchedule(input.schedule) : null;
  const incomingThresholds = input.thresholds
    ? {
        ...defaultThresholds(),
        ...input.thresholds,
      }
    : null;
  const incomingAlertChannels =
    input.alertWebhookUrl !== undefined
      ? {
          webhookUrl: String(input.alertWebhookUrl || "").trim(),
        }
      : null;
  if (existing) {
    existing.label = input.label || existing.label || hostname;
    existing.url = canonicalUrl;
    existing.hostname = hostname;
    existing.scanMode = input.scanMode || existing.scanMode || "single";
    existing.defaultFormFactor = input.formFactor || existing.defaultFormFactor || "mobile";
    if (incomingSchedule) existing.schedule = incomingSchedule;
    if (incomingThresholds) existing.thresholds = incomingThresholds;
    if (incomingAlertChannels) existing.alertChannels = incomingAlertChannels;
    existing.updatedAt = nowIso();
    await saveState();
    return clone(existing);
  }
  const site = {
    id: nextId("site"),
    clientId: client.id,
    label: input.label || hostname,
    url: canonicalUrl,
    hostname,
    scanMode: input.scanMode || "single",
    defaultFormFactor: input.formFactor || "mobile",
    schedule: incomingSchedule || normalizeSchedule({ frequency: "off", nextRunAt: null }),
    thresholds: incomingThresholds || defaultThresholds(),
    alertChannels: incomingAlertChannels || { webhookUrl: "" },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.sites.push(site);
  await saveState();
  return clone(site);
}

function normalizeSchedule(schedule) {
  const freq = String(schedule?.frequency || "off").toLowerCase();
  const valid = new Set(["off", "daily", "weekly"]);
  const nextRunAt = schedule?.nextRunAt || null;
  return {
    frequency: valid.has(freq) ? freq : "off",
    nextRunAt,
  };
}

export async function updateSite(siteId, patch) {
  const site = state.sites.find((item) => item.id === siteId);
  if (!site) return null;
  if (patch.label !== undefined) site.label = String(patch.label || "").trim() || site.label;
  if (patch.url !== undefined) site.url = normalizeSiteUrl(patch.url);
  if (patch.scanMode !== undefined) site.scanMode = patch.scanMode;
  if (patch.defaultFormFactor !== undefined) site.defaultFormFactor = patch.defaultFormFactor;
  if (patch.schedule !== undefined) site.schedule = normalizeSchedule(patch.schedule);
  if (patch.thresholds !== undefined) site.thresholds = { ...defaultThresholds(), ...patch.thresholds };
  if (patch.alertChannels !== undefined) {
    site.alertChannels = { webhookUrl: String(patch.alertChannels.webhookUrl || "").trim() };
  }
  site.updatedAt = nowIso();
  await saveState();
  return clone(site);
}

export function getSite(siteId) {
  const site = state.sites.find((item) => item.id === siteId);
  return site ? clone(site) : null;
}

export async function deleteSite(siteId) {
  const site = state.sites.find((item) => item.id === siteId);
  if (!site) return null;

  const activeJob = state.jobs.find(
    (job) => job.siteId === siteId && (job.status === "queued" || job.status === "running")
  );
  if (activeJob) {
    const err = new Error("Site has an active scan job.");
    err.code = "SITE_BUSY";
    throw err;
  }

  const runIds = new Set(
    state.scanRuns.filter((run) => run.siteId === siteId).map((run) => run.id)
  );
  const deletedJobs = state.jobs.filter((job) => job.siteId === siteId).length;

  for (const runId of runIds) {
    const run = state.scanRuns.find((item) => item.id === runId);
    if (run?.artifactPath) {
      await rm(join(DATA_DIR, run.artifactPath), { force: true }).catch(() => {});
    }
  }

  state.pageResults = state.pageResults.filter((row) => !runIds.has(row.runId));
  state.scanRuns = state.scanRuns.filter((run) => run.siteId !== siteId);
  state.jobs = state.jobs.filter((job) => job.siteId !== siteId);
  state.alerts = state.alerts.filter(
    (alert) => alert.siteId !== siteId && !runIds.has(alert.runId)
  );
  state.sites = state.sites.filter((item) => item.id !== siteId);
  state.clients = state.clients.filter((client) =>
    state.sites.some((item) => item.clientId === client.id)
  );

  await saveState();
  return {
    siteId,
    label: site.label,
    deletedRuns: runIds.size,
    deletedJobs,
  };
}

export function listSites() {
  return sortedCopy(state.sites).map((site) => ({
    ...site,
    client: state.clients.find((client) => client.id === site.clientId) || null,
  }));
}

export async function createJob(input) {
  const job = {
    id: nextId("job"),
    siteId: input.siteId || null,
    clientId: input.clientId || null,
    source: input.source || "manual",
    scanMode: input.scanMode,
    formFactor: input.formFactor,
    url: normalizeSiteUrl(input.url),
    status: "queued",
    progress: 0,
    message: "Queued for scanning",
    error: null,
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
    runId: null,
  };
  state.jobs.push(job);
  await saveState();
  return clone(job);
}

export async function updateJob(jobId, patch) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return null;
  Object.assign(job, patch);
  await saveState();
  return clone(job);
}

export function getJob(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  return job ? clone(job) : null;
}

export function listJobs(limit = 20) {
  return sortedCopy(state.jobs).slice(0, limit).map((job) => ({
    ...job,
    site: job.siteId ? getSite(job.siteId) : null,
  }));
}

export async function createRun(input) {
  const run = {
    id: nextId("run"),
    jobId: input.jobId,
    siteId: input.siteId || null,
    clientId: input.clientId || null,
    url: normalizeSiteUrl(input.url),
    scanMode: input.scanMode,
    formFactor: input.formFactor,
    status: input.status || "running",
    createdAt: nowIso(),
    completedAt: null,
    summary: null,
    diff: null,
    aiInsights: null,
    artifactPath: null,
    alerts: [],
  };
  state.scanRuns.push(run);
  await saveState();
  return clone(run);
}

export async function updateRun(runId, patch) {
  const run = state.scanRuns.find((item) => item.id === runId);
  if (!run) return null;
  Object.assign(run, patch);
  await saveState();
  return clone(run);
}

export function getRun(runId) {
  const run = state.scanRuns.find((item) => item.id === runId);
  return run ? clone(run) : null;
}

export function listRuns(limit = 20) {
  return sortedCopy(state.scanRuns).slice(0, limit).map(enrichRun);
}

export function listRunsForSite(siteId, limit = 20) {
  return sortedCopy(state.scanRuns.filter((run) => run.siteId === siteId))
    .slice(0, limit)
    .map(enrichRun);
}

export function listPageResultsForRun(runId) {
  return sortedCopy(state.pageResults.filter((row) => row.runId === runId), "url");
}

export async function replacePageResults(runId, rows) {
  state.pageResults = state.pageResults.filter((row) => row.runId !== runId);
  for (const row of rows) {
    state.pageResults.push({
      id: nextId("page"),
      runId,
      ...row,
    });
  }
  await saveState();
  return listPageResultsForRun(runId);
}

export async function writeArtifact(runId, artifact) {
  await ensureDataDir();
  const relPath = join("artifacts", `${runId}.json`);
  const fullPath = join(DATA_DIR, relPath);
  await writeFile(fullPath, JSON.stringify(artifact, null, 2), "utf8");
  const run = state.scanRuns.find((item) => item.id === runId);
  if (run) {
    run.artifactPath = relPath;
    await saveState();
  }
  return relPath;
}

export async function readArtifact(run) {
  if (!run?.artifactPath) return null;
  try {
    const fullPath = join(DATA_DIR, run.artifactPath);
    const raw = await readFile(fullPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function addAlert(input) {
  const alert = {
    id: nextId("alert"),
    siteId: input.siteId || null,
    clientId: input.clientId || null,
    runId: input.runId || null,
    severity: input.severity || "warning",
    title: input.title,
    message: input.message,
    channels: input.channels || [],
    createdAt: nowIso(),
  };
  state.alerts.push(alert);
  const run = state.scanRuns.find((item) => item.id === input.runId);
  if (run) {
    run.alerts = [...(run.alerts || []), alert.id];
  }
  await saveState();
  return clone(alert);
}

export function getAlert(alertId) {
  const alert = state.alerts.find((item) => item.id === alertId);
  return alert ? clone(alert) : null;
}

export function listAlerts(limit = 20) {
  return sortedCopy(state.alerts).slice(0, limit).map((alert) => ({
    ...alert,
    run: alert.runId ? getRun(alert.runId) : null,
    site: alert.siteId ? getSite(alert.siteId) : null,
  }));
}

export function getLatestComparableRun(siteId, scanMode, formFactor, excludeRunId) {
  const run = sortedCopy(
    state.scanRuns.filter(
      (item) =>
        item.siteId === siteId &&
        item.scanMode === scanMode &&
        item.formFactor === formFactor &&
        item.status === "completed" &&
        item.id !== excludeRunId
    )
  )[0];
  return run ? clone(run) : null;
}

export async function markStaleJobsFailed() {
  let changed = false;
  for (const job of state.jobs) {
    if (job.status === "queued" || job.status === "running") {
      job.status = "failed";
      job.error = "Server restarted while the job was in progress.";
      job.completedAt = nowIso();
      changed = true;
    }
  }
  for (const run of state.scanRuns) {
    if (run.status === "running") {
      run.status = "failed";
      run.completedAt = nowIso();
      changed = true;
    }
  }
  if (changed) await saveState();
}

function enrichRun(run) {
  return {
    ...run,
    site: run.siteId ? getSite(run.siteId) : null,
    client: run.clientId ? clone(state.clients.find((client) => client.id === run.clientId) || null) : null,
    pages: listPageResultsForRun(run.id),
  };
}

export function computeNextRunAt(frequency, fromDate = new Date()) {
  if (frequency === "daily") {
    return new Date(fromDate.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }
  if (frequency === "weekly") {
    return new Date(fromDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  return null;
}

export function listDueSites(reference = new Date()) {
  return state.sites
    .filter((site) => site.schedule?.frequency && site.schedule.frequency !== "off")
    .filter((site) => !site.schedule?.nextRunAt || new Date(site.schedule.nextRunAt) <= reference)
    .map(clone);
}

export async function touchSiteSchedule(siteId, frequency, nextRunAt) {
  const site = state.sites.find((item) => item.id === siteId);
  if (!site) return null;
  site.schedule = normalizeSchedule({ frequency, nextRunAt });
  site.updatedAt = nowIso();
  await saveState();
  return clone(site);
}

export function getClient(clientId) {
  const client = state.clients.find((item) => item.id === clientId);
  return client ? clone(client) : null;
}
