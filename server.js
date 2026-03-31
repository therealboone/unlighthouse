import express from "express";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import lighthouse from "lighthouse";
import { launch as launchChrome } from "chrome-launcher";
import * as lhConstants from "lighthouse/core/config/constants.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertPublicScanTarget } from "./lib/url-scan-policy.js";

const app = express();
const isProd = process.env.NODE_ENV === "production";
if (isProd || process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

const PORT = Number(process.env.PORT) || 4173;
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));

const SITE_SCAN_TIMEOUT_MS = Number(process.env.SITE_SCAN_TIMEOUT_MS) || 45 * 60 * 1000;

/** @typedef {"mobile" | "desktop"} FormFactor */
/** @typedef {"single" | "site"} ScanMode */

const CHROME_FLAGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scanErrorMessage(err) {
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
  return err.message;
}

let scanInProgress = false;

/**
 * Runs at most one Lighthouse scan at a time so Chrome/RAM is not overloaded.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function runExclusiveScan(fn) {
  if (scanInProgress) {
    const err = new Error("SCAN_BUSY");
    err.code = "SCAN_BUSY";
    throw err;
  }
  scanInProgress = true;
  try {
    return await fn();
  } finally {
    scanInProgress = false;
  }
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
app.use(express.urlencoded({ extended: true, limit: "32kb" }));

const scanLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || (isProd ? 20 : 120),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.RATE_LIMIT_DISABLED === "true",
  handler: (req, res) => {
    res.status(429).render("index", {
      result: null,
      siteScan: null,
      error: "Too many scan requests from this address. Please wait a few minutes.",
      submittedUrl: (req.body?.url || "").toString(),
      formFactor: normalizeFormFactor(req.body?.formFactor),
      scanMode: normalizeScanMode(req.body?.scanMode),
      isProd,
    });
  },
});

function normalizeTarget(input) {
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

/** @param {unknown} raw */
function normalizeFormFactor(raw) {
  const s = String(raw || "").toLowerCase();
  if (s === "desktop") return "desktop";
  return "mobile";
}

/** @param {unknown} raw */
function normalizeScanMode(raw) {
  const s = String(raw || "").toLowerCase();
  if (s === "site" || s === "full") return "site";
  return "single";
}

/** @param {FormFactor} formFactor */
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

/** @param {string} url @param {FormFactor} formFactor */
async function runLighthouseScanOnce(url, formFactor) {
  const chrome = await launchChrome({
    chromePath: process.env.CHROME_PATH || undefined,
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
    return {
      device: formFactor,
      finalUrl: result.lhr.finalDisplayedUrl || result.lhr.finalUrl,
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
    };
  } finally {
    await chrome.kill();
  }
}

/** @param {string} url @param {FormFactor} formFactor */
async function runLighthouseScan(url, formFactor) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runLighthouseScanOnce(url, formFactor);
    } catch (err) {
      lastErr = err;
      const transient =
        err.code === "ECONNREFUSED" || /ECONNREFUSED/i.test(String(err.message || ""));
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

/**
 * Full-site scan runs in a child process so @unlighthouse/core's unctx state cannot conflict
 * across repeated scans (fixes "Context conflict").
 * @param {string} siteUrl
 * @param {FormFactor} formFactor
 */
async function runSiteWideScan(siteUrl, formFactor) {
  const outFile = join(tmpdir(), `uls-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const workerScript = join(PROJECT_ROOT, "scripts", "run-site-scan-worker.mjs");
  const ff = formFactor === "desktop" ? "desktop" : "mobile";

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript, siteUrl, ff, outFile], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PROJECT_ROOT },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    const hardKillMs = SITE_SCAN_TIMEOUT_MS + 120_000;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, hardKillMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      (async () => {
        try {
          const raw = await readFile(outFile, "utf8");
          await rm(outFile, { force: true }).catch(() => {});
          const j = JSON.parse(raw);
          if (!j.ok) {
            const err = new Error(j.error || "Site scan failed");
            if (j.code) err.code = j.code;
            reject(err);
            return;
          }
          if (!j.result) {
            reject(new Error("Invalid site scan worker response"));
            return;
          }
          resolve(j.result);
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

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    scanBusy: scanInProgress,
    uptime: process.uptime(),
  });
});

app.get("/", (req, res) => {
  res.render("index", {
    result: null,
    siteScan: null,
    error: null,
    submittedUrl: "",
    formFactor: "mobile",
    scanMode: "single",
    isProd,
  });
});

app.post("/scan", scanLimiter, async (req, res) => {
  const submittedUrl = (req.body.url || "").toString();
  const formFactor = normalizeFormFactor(req.body.formFactor);
  const scanMode = normalizeScanMode(req.body.scanMode);
  const target = normalizeTarget(submittedUrl);
  if (!target) {
    return res.status(400).render("index", {
      result: null,
      siteScan: null,
      error: "Please enter a valid http(s) URL without embedded credentials.",
      submittedUrl,
      formFactor,
      scanMode,
      isProd,
    });
  }

  try {
    await assertPublicScanTarget(target);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const code = "code" in e ? e.code : undefined;
    if (code === "BLOCKED_HOST") {
      return res.status(403).render("index", {
        result: null,
        siteScan: null,
        error: scanErrorMessage(e),
        submittedUrl: target,
        formFactor,
        scanMode,
        isProd,
      });
    }
    if (code === "DNS_FAILED") {
      return res.status(400).render("index", {
        result: null,
        siteScan: null,
        error: scanErrorMessage(e),
        submittedUrl: target,
        formFactor,
        scanMode,
        isProd,
      });
    }
    return res.status(400).render("index", {
      result: null,
      siteScan: null,
      error: `Invalid target: ${e.message}`,
      submittedUrl: target,
      formFactor,
      scanMode,
      isProd,
    });
  }

  const renderCtx = {
    submittedUrl: target,
    formFactor,
    scanMode,
    isProd,
  };

  try {
    if (scanMode === "site") {
      const siteScan = await runExclusiveScan(() => runSiteWideScan(target, formFactor));
      return res.render("index", { ...renderCtx, result: null, siteScan, error: null });
    }
    const result = await runExclusiveScan(() => runLighthouseScan(target, formFactor));
    return res.render("index", { ...renderCtx, result, siteScan: null, error: null });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code === "SCAN_BUSY") {
      return res.status(503).render("index", {
        ...renderCtx,
        result: null,
        siteScan: null,
        error: scanErrorMessage(err),
      });
    }
    console.error("Scan error:", err);
    return res.status(500).render("index", {
      ...renderCtx,
      result: null,
      siteScan: null,
      error: `Scan failed: ${scanErrorMessage(err)}`,
    });
  }
});

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
