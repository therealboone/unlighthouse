import { launch as launchChrome } from "chrome-launcher";
import puppeteer from "puppeteer-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_FLAGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

const CSP_MESSAGE_PATTERNS = [
  /content security policy/i,
  /content-security-policy/i,
  /violates the following content security policy directive/i,
  /refused to (?:apply inline style|execute inline script|load|connect to|frame|use|run|eval)/i,
  /because it violates the following directive/i,
  /report-only policy/i,
];

/**
 * @param {string} text
 */
export function isCspConsoleMessage(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/content security policy/i.test(value)) return true;
  if (/content-security-policy/i.test(value)) return true;
  if (/violates the following/i.test(value) && /directive/i.test(value)) return true;
  if (/refused to/i.test(value) && /(?:csp|content security|directive)/i.test(value)) return true;
  return CSP_MESSAGE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * @param {unknown} item
 * @param {string} [pageUrl]
 */
function violationFromLighthouseItem(item, pageUrl) {
  if (!item || typeof item !== "object") return null;
  const message = String(item.description || item.text || item.message || "").trim();
  if (!isCspConsoleMessage(message)) return null;
  return {
    message,
    source: "lighthouse",
    level: "error",
    url: String(item.url || pageUrl || ""),
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} audits
 * @param {string} [pageUrl]
 */
export function extractCspFromLighthouseAudits(audits, pageUrl = "") {
  if (!audits || typeof audits !== "object") return [];
  const audit = audits["errors-in-console"] || audits["errors-in-page"] || null;
  const items = audit?.details?.items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => violationFromLighthouseItem(item, pageUrl)).filter(Boolean);
}

/**
 * @param {Array<{ message: string, source?: string, level?: string, url?: string }>} lists
 */
export function mergeCspViolations(lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item?.message) continue;
      const key = `${item.url || ""}::${item.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        message: item.message,
        source: item.source || "unknown",
        level: item.level || "error",
        url: item.url || "",
      });
    }
  }
  return merged;
}

/**
 * @param {Array<{ message: string, source?: string, level?: string, url?: string }>} violations
 */
/**
 * @param {{ message: string, url?: string, source?: string, level?: string }} violation
 */
export function enrichCspViolation(violation) {
  const message = String(violation?.message || "").trim();
  let blockedHost = "";
  const urlMatch = message.match(/['"](https?:\/\/[^'"]+)['"]/i);
  if (urlMatch) {
    try {
      blockedHost = new URL(urlMatch[1]).hostname;
    } catch {
      blockedHost = "";
    }
  }
  const directiveMatch =
    message.match(/violates the following (?:content security policy )?directive:\s*['"]?([\w-]+)/i) ||
    message.match(/\b(script-src|style-src|connect-src|img-src|font-src|frame-src|default-src|worker-src|manifest-src)\b/i);
  return {
    ...violation,
    message,
    blockedHost: blockedHost || (message.includes("inline") ? "(inline)" : ""),
    directive: directiveMatch?.[1] || "unknown",
  };
}

/**
 * @param {Array<{ message: string, blockedHost?: string, directive?: string }>} violations
 */
export function groupCspViolations(violations) {
  const enriched = violations.map(enrichCspViolation);
  const byBlockedHost = new Map();
  const byDirective = new Map();
  for (const item of enriched) {
    const host = item.blockedHost || "(unknown)";
    const directive = item.directive || "unknown";
    byBlockedHost.set(host, (byBlockedHost.get(host) || 0) + 1);
    byDirective.set(directive, (byDirective.get(directive) || 0) + 1);
  }
  const sortEntries = (map) =>
    [...map.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  return {
    byBlockedHost: sortEntries(byBlockedHost).map(({ key, count }) => ({ host: key, count })),
    byDirective: sortEntries(byDirective).map(({ key, count }) => ({ directive: key, count })),
  };
}

/**
 * @param {Array<{ message: string, url?: string }>} violations
 * @param {number} [maxAllowed]
 */
export function buildCspRunSummary(violations, maxAllowed = 0) {
  const merged = mergeCspViolations([Array.isArray(violations) ? violations : []]);
  const enriched = merged.map(enrichCspViolation);
  const pages = new Set(enriched.map((item) => item.url).filter(Boolean));
  const groups = groupCspViolations(enriched);
  const count = enriched.length;
  const allowed = Number.isFinite(maxAllowed) ? maxAllowed : 0;
  return {
    count,
    pageCount: pages.size || (count ? 1 : 0),
    violations: enriched.slice(0, 50),
    groups,
    status: count <= allowed ? "pass" : "fail",
    maxAllowed: allowed,
  };
}

export function summarizeCspViolations(violations) {
  return buildCspRunSummary(violations, 0);
}

/**
 * @param {Array<{ message: string, url?: string }>} current
 * @param {Array<{ message: string, url?: string }>} previous
 */
export function diffCspViolations(current = [], previous = []) {
  const key = (item) => `${item.url || ""}::${item.message || ""}`;
  const prevKeys = new Set(previous.map(key));
  const currKeys = new Set(current.map(key));
  const newViolations = current.filter((item) => !prevKeys.has(key(item)));
  const resolvedViolations = previous.filter((item) => !currKeys.has(key(item)));
  return {
    newViolations: newViolations.slice(0, 30),
    resolvedViolations: resolvedViolations.slice(0, 30),
    newCount: newViolations.length,
    resolvedCount: resolvedViolations.length,
  };
}

/**
 * @param {Array<{ message: string, url?: string, source?: string, level?: string, blockedHost?: string, directive?: string }>} violations
 */
export function violationsToCsv(violations) {
  const esc = (value) => {
    const str = value == null ? "" : String(value);
    if (str.includes('"') || str.includes(",") || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const lines = [
    ["page_url", "source", "level", "directive", "blocked_host", "message"].join(","),
  ];
  for (const row of violations) {
    lines.push(
      [
        esc(row.url),
        esc(row.source),
        esc(row.level),
        esc(row.directive),
        esc(row.blockedHost),
        esc(row.message),
      ].join(",")
    );
  }
  return lines.join("\n");
}

/**
 * @param {Array<{ url?: string, cspCount?: number, cspViolations?: unknown[] }>} pageResults
 */
export function aggregateSiteCsp(pageResults = [], maxAllowed = 0) {
  const allViolations = [];
  for (const row of pageResults) {
    for (const item of row.cspViolations || []) {
      allViolations.push({ ...item, url: item.url || row.url });
    }
  }
  const summary = buildCspRunSummary(allViolations, maxAllowed);
  const pagesWithViolations = pageResults.filter((row) => (row.cspCount || 0) > 0);
  const topPages = [...pagesWithViolations]
    .sort((a, b) => (b.cspCount || 0) - (a.cspCount || 0))
    .slice(0, 8)
    .map((row) => ({
      url: row.url,
      count: row.cspCount || 0,
      sample: (row.cspViolations || [])[0]?.message || "",
    }));
  return {
    ...summary,
    topPages,
  };
}

/**
 * @param {number} port
 * @param {string} url
 * @param {"mobile" | "desktop"} formFactor
 */
export async function collectConsoleCspOnChrome(port, url, formFactor) {
  const violations = [];
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: null,
  });

  try {
    const page = await browser.newPage();
    if (formFactor === "desktop") {
      await page.setViewport({ width: 1350, height: 940, deviceScaleFactor: 1 });
    } else {
      await page.setViewport({ width: 412, height: 823, deviceScaleFactor: 2.625, isMobile: true });
    }

    const pushMessage = (text, source, level = "error") => {
      if (!isCspConsoleMessage(text)) return;
      violations.push({
        message: String(text).trim(),
        source,
        level,
        url: page.url() || url,
      });
    };

    page.on("console", (msg) => {
      pushMessage(msg.text(), "browser-console", msg.type());
    });

    page.on("pageerror", (err) => {
      pushMessage(err?.message || String(err), "page-error", "error");
    });

    const client = await page.createCDPSession();
    await client.send("Log.enable");
    client.on("Log.entryAdded", (event) => {
      const entry = event?.entry;
      pushMessage(entry?.text || "", "browser-log", entry?.level || "error");
    });

    const timeoutMs = Number(process.env.CSP_CONSOLE_TIMEOUT_MS) || 60_000;
    await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs });
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.CSP_CONSOLE_SETTLE_MS) || 2000));

    await page.close().catch(() => {});
  } finally {
    await browser.disconnect().catch(() => {});
  }

  return mergeCspViolations([violations]);
}

/**
 * Standalone console audit (launches its own Chrome instance).
 * @param {string} url
 * @param {"mobile" | "desktop"} formFactor
 */
export async function auditPageConsole(url, formFactor) {
  const userDataDir = await mkdtemp(join(tmpdir(), "lhs-csp-console-"));
  const chrome = await launchChrome({
    chromePath: process.env.CHROME_PATH || undefined,
    userDataDir,
    chromeFlags: CHROME_FLAGS,
    maxConnectionRetries: 100,
    connectionPollInterval: 100,
  });

  try {
    return await collectConsoleCspOnChrome(chrome.port, url, formFactor);
  } finally {
    await chrome.kill();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {Record<string, unknown> | null | undefined} audits
 * @param {string} url
 * @param {"mobile" | "desktop"} formFactor
 */
export async function collectCspViolationsForPage(url, formFactor, audits = null) {
  const fromLighthouse = extractCspFromLighthouseAudits(audits, url);
  if (process.env.CSP_CONSOLE_AUDIT === "false") {
    return mergeCspViolations([fromLighthouse]);
  }
  const fromBrowser = await auditPageConsole(url, formFactor);
  return mergeCspViolations([fromLighthouse, fromBrowser]);
}
