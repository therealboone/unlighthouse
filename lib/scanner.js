import lighthouse from "lighthouse";
import { launch as launchChrome } from "chrome-launcher";
import * as lhConstants from "lighthouse/core/config/constants.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  collectConsoleCspOnChrome,
  extractCspFromLighthouseAudits,
  mergeCspViolations,
  summarizeCspViolations,
} from "./csp-console.js";

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(PROJECT_ROOT, "..");

const CHROME_FLAGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeTarget(input) {
  if (!input || typeof input !== "string") return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function normalizeFormFactor(raw) {
  const s = String(raw || "").toLowerCase();
  return s === "desktop" ? "desktop" : "mobile";
}

export function normalizeScanMode(raw) {
  const s = String(raw || "").toLowerCase();
  return s === "site" || s === "full" ? "site" : "single";
}

function lighthouseFormSettings(formFactor) {
  if (formFactor === "desktop") {
    return {
      formFactor: "desktop",
      throttling: lhConstants.throttling.desktopDense4G,
      screenEmulation: lhConstants.screenEmulationMetrics.desktop,
      emulatedUserAgent: lhConstants.userAgents.desktop,
    };
  }
  return {
    formFactor: "mobile",
    throttling: lhConstants.throttling.mobileSlow4G,
    screenEmulation: lhConstants.screenEmulationMetrics.mobile,
    emulatedUserAgent: lhConstants.userAgents.mobile,
  };
}

export function scanErrorMessage(err) {
  if (err.code === "SCAN_BUSY") {
    return "Another scan is still running. Wait until it finishes, then try again.";
  }
  if (err.code === "BLOCKED_HOST" || err.code === "BLOCKED_URL") {
    return (
      "That URL is not allowed (internal or non-public host). " +
      "For local testing, set ALLOW_INTERNAL_SCANS=true in the environment."
    );
  }
  if (err.code === "DNS_FAILED") {
    return "Could not resolve that hostname. Check the URL and try again.";
  }
  if (String(err.message || "").includes("Context conflict")) {
    return "Scanner context error. Restart the server and try again, or update dependencies.";
  }
  if (err.code === "ECONNREFUSED" || /ECONNREFUSED/i.test(String(err.message))) {
    return (
      "Could not connect to Chrome's debugging port (the browser closed or never became ready). " +
      "Install Google Chrome or Chromium, or set CHROME_PATH to your browser binary. " +
      "Close other Chrome instances and try again."
    );
  }
  return err?.message || "Scan failed.";
}

function summarizeAudit(auditId, audit) {
  if (!audit) return null;
  const rawValue = Number(audit.numericValue);
  const score = typeof audit.score === "number" ? Math.round(audit.score * 100) : null;
  return {
    id: auditId,
    title: audit.title || auditId,
    description: audit.description || "",
    score,
    displayValue: audit.displayValue || "",
    numericValue: Number.isFinite(rawValue) ? rawValue : null,
    scoreDisplayMode: audit.scoreDisplayMode || "unknown",
    details: audit.details?.type || null,
  };
}

function extractKeyAudits(audits = {}) {
  const tracked = [
    "largest-contentful-paint",
    "cumulative-layout-shift",
    "total-blocking-time",
    "first-contentful-paint",
    "speed-index",
    "server-response-time",
    "render-blocking-resources",
    "unused-javascript",
    "unused-css-rules",
    "modern-image-formats",
    "offscreen-images",
    "unminified-css",
    "unminified-javascript",
    "uses-optimized-images",
    "uses-text-compression",
    "uses-responsive-images",
    "dom-size",
    "legacy-javascript",
    "image-alt",
    "meta-description",
    "document-title",
    "link-text",
    "crawlable-anchors",
    "is-crawlable",
    "html-has-lang",
    "viewport",
  ];
  return tracked.map((id) => summarizeAudit(id, audits[id])).filter(Boolean);
}

function extractTopOpportunities(audits = {}, limit = 6) {
  return Object.entries(audits)
    .map(([id, audit]) => summarizeAudit(id, audit))
    .filter((audit) => audit && audit.scoreDisplayMode !== "notApplicable")
    .filter((audit) => audit.score === null || audit.score < 90)
    .sort((a, b) => {
      const aWeight = a.numericValue ?? Number.POSITIVE_INFINITY;
      const bWeight = b.numericValue ?? Number.POSITIVE_INFINITY;
      return aWeight - bWeight;
    })
    .slice(0, limit);
}

export async function runLighthouseScan(url, formFactor) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runLighthouseScanOnce(url, formFactor);
    } catch (err) {
      lastErr = err;
      const transient = err.code === "ECONNREFUSED" || /ECONNREFUSED/i.test(String(err.message || ""));
      if (transient && attempt < maxAttempts) {
        console.warn(`Lighthouse attempt ${attempt} failed (${err.message}), retrying…`);
        await sleep(750 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function runLighthouseScanOnce(url, formFactor) {
  const userDataDir = await mkdtemp(join(tmpdir(), "lhs-chrome-profile-"));
  const chrome = await launchChrome({
    chromePath: process.env.CHROME_PATH || undefined,
    userDataDir,
    chromeFlags: CHROME_FLAGS,
    maxConnectionRetries: 100,
    connectionPollInterval: 100,
  });

  try {
    const result = await lighthouse(
      url,
      {
        port: chrome.port,
        output: "json",
        onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
        throttlingMethod: "simulate",
        ...lighthouseFormSettings(formFactor),
      },
      undefined
    );

    const categories = result.lhr.categories;
    const vitals = result.lhr.audits;
    const finalUrl = result.lhr.finalDisplayedUrl || result.lhr.finalUrl || url;
    const fromLighthouse = extractCspFromLighthouseAudits(result.lhr.audits, finalUrl);
    let cspViolations = fromLighthouse;
    if (process.env.CSP_CONSOLE_AUDIT !== "false") {
      const fromBrowser = await collectConsoleCspOnChrome(chrome.port, url, formFactor);
      cspViolations = mergeCspViolations([fromLighthouse, fromBrowser]);
    }
    const csp = summarizeCspViolations(cspViolations);

    return {
      summary: {
        device: formFactor,
        finalUrl,
        csp: {
          count: csp.count,
          pageCount: csp.pageCount,
        },
        categories: {
          performance: Math.round((categories.performance?.score || 0) * 100),
          accessibility: Math.round((categories.accessibility?.score || 0) * 100),
          bestPractices: Math.round((categories["best-practices"]?.score || 0) * 100),
          seo: Math.round((categories.seo?.score || 0) * 100),
        },
        metrics: {
          lcp: vitals["largest-contentful-paint"]?.displayValue || "n/a",
          cls: vitals["cumulative-layout-shift"]?.displayValue || "n/a",
          tbt: vitals["total-blocking-time"]?.displayValue || "n/a",
          fcp: vitals["first-contentful-paint"]?.displayValue || "n/a",
        },
      },
      artifact: {
        finalUrl,
        fetchTime: result.lhr.fetchTime,
        lighthouseVersion: result.lhr.lighthouseVersion,
        categories: result.lhr.categories,
        audits: extractKeyAudits(result.lhr.audits),
        topOpportunities: extractTopOpportunities(result.lhr.audits),
        cspViolations: csp.violations,
        rawLhr: result.lhr,
      },
    };
  } finally {
    await chrome.kill();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

function summarizeSiteReport(report) {
  const categories = report?.categories || {};
  const byId = Array.isArray(categories)
    ? Object.fromEntries(categories.filter(Boolean).map((item) => [item.id || item.key, item.score]))
    : Object.fromEntries(Object.entries(categories).map(([key, item]) => [key, item?.score]));
  const score = (id) => (typeof byId[id] === "number" ? Math.round(byId[id] * 100) : null);
  return {
    performance: score("performance"),
    accessibility: score("accessibility"),
    bestPractices: score("best-practices"),
    seo: score("seo"),
    overall: typeof report?.score === "number" ? Math.round(report.score * 100) : null,
  };
}

export async function runSiteWideScan(siteUrl, formFactor) {
  const outFile = join(tmpdir(), `uls-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const workerScript = join(APP_ROOT, "scripts", "run-site-scan-worker.mjs");
  const ff = formFactor === "desktop" ? "desktop" : "mobile";
  const timeoutMs = Number(process.env.SITE_SCAN_TIMEOUT_MS) || 45 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript, siteUrl, ff, outFile], {
      cwd: APP_ROOT,
      env: { ...process.env, PROJECT_ROOT: APP_ROOT },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    const hardKillMs = timeoutMs + 120_000;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, hardKillMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      (async () => {
        try {
          const raw = await readFile(outFile, "utf8");
          await rm(outFile, { force: true }).catch(() => {});
          const payload = JSON.parse(raw);
          if (!payload.ok) {
            const err = new Error(payload.error || "Site scan failed");
            if (payload.code) err.code = payload.code;
            reject(err);
            return;
          }
          const result = payload.result || null;
          if (!result) {
            reject(new Error("Invalid site scan worker response"));
            return;
          }
          resolve({
            summary: {
              formFactor,
              siteUrl,
              maxRoutes: result.maxRoutes,
              rows: result.rows,
              capped: result.capped,
              routeCount: result.routeCount,
              note: result.note || null,
            },
            artifact: {
              siteUrl,
              formFactor,
              routeCount: result.routeCount,
              maxRoutes: result.maxRoutes,
              capped: result.capped,
              note: result.note || null,
              rows: result.rows,
              reports: result.reports || [],
              topIssues: aggregateSiteIssues(result.reports || []),
            },
          });
        } catch (parseErr) {
          await rm(outFile, { force: true }).catch(() => {});
          reject(
            new Error(
              code !== 0
                ? stderr.trim().slice(0, 2000) || `Site scan worker exited with code ${code}`
                : String(parseErr instanceof Error ? parseErr.message : parseErr)
            )
          );
        }
      })();
    });
  });
}

function aggregateSiteIssues(reports) {
  const counts = new Map();
  for (const report of reports) {
    const items = report.topOpportunities || [];
    for (const issue of items) {
      const current = counts.get(issue.id) || {
        id: issue.id,
        title: issue.title,
        pages: 0,
      };
      current.pages += 1;
      counts.set(issue.id, current);
    }
  }
  return [...counts.values()].sort((a, b) => b.pages - a.pages).slice(0, 10);
}

export function summarizeSitePage(page) {
  return {
    url: page.url,
    status: page.status,
    performance: page.performance ?? null,
    accessibility: page.accessibility ?? null,
    bestPractices: page.bestPractices ?? null,
    seo: page.seo ?? null,
    overall: page.overall ?? null,
  };
}

export function summarizeSiteReportForStorage(page) {
  return {
    url: page.url,
    status: page.status,
    ...summarizeSiteReport(page.report),
    topOpportunities: page.topOpportunities || [],
  };
}
