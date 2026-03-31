/**
 * Runs in a fresh Node process so @unlighthouse/core's unctx singletons do not conflict
 * with a second scan in the parent server.
 *
 * Usage: node scripts/run-site-scan-worker.mjs <siteUrl> <mobile|desktop> <outputJsonPath>
 */
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { availableParallelism } from "node:os";
import { createUnlighthouse } from "@unlighthouse/core";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const DEFAULT_MAX_SITE_ROUTES = 50;
const SITE_SCAN_TIMEOUT_MS = Number(process.env.SITE_SCAN_TIMEOUT_MS) || 45 * 60 * 1000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.PROJECT_ROOT || join(scriptDir, "..");

function defaultUnlighthouseConcurrency() {
  const raw = process.env.UNLIGHTHOUSE_CONCURRENCY;
  if (raw !== undefined && raw !== "") {
    return Math.min(4, Math.max(1, Number(raw) || 1));
  }
  const cpus = availableParallelism();
  return Math.min(4, Math.max(1, Math.floor(cpus / 2) || 1));
}

/** @param {any} report */
function scoresFromUnlighthouseReport(report) {
  if (!report?.categories) {
    return { performance: null, accessibility: null, bestPractices: null, seo: null, overall: null };
  }
  const list = Array.isArray(report.categories) ? report.categories : Object.values(report.categories);
  const byId = Object.fromEntries(
    list.filter(Boolean).map((c) => [c.id || c.key, c.score])
  );
  const pct = (id) => (typeof byId[id] === "number" ? Math.round(byId[id] * 100) : null);
  return {
    performance: pct("performance"),
    accessibility: pct("accessibility"),
    bestPractices: pct("best-practices"),
    seo: pct("seo"),
    overall: typeof report.score === "number" ? Math.round(report.score * 100) : null,
  };
}

async function main() {
  const siteUrl = process.argv[2];
  const formFactor = process.argv[3] === "desktop" ? "desktop" : "mobile";
  const outPath = process.argv[4];
  if (!siteUrl || !outPath) {
    console.error("Usage: node run-site-scan-worker.mjs <siteUrl> <mobile|desktop> <outputJsonPath>");
    process.exit(1);
  }

  const maxRoutes = Math.min(
    Math.max(1, Number(process.env.UNLIGHTHOUSE_MAX_ROUTES) || DEFAULT_MAX_SITE_ROUTES),
    500
  );
  const concurrency = defaultUnlighthouseConcurrency();
  const outputPath = join(tmpdir(), `unlighthouse-${Date.now()}`);

  const writeResult = async (payload) => {
    await writeFile(outPath, JSON.stringify(payload), "utf8");
  };

  try {
    const ctx = await createUnlighthouse(
      {
        site: siteUrl,
        root: PROJECT_ROOT,
        outputPath,
        cache: false,
        scanner: {
          sitemap: true,
          crawler: true,
          maxRoutes,
          device: formFactor === "desktop" ? "desktop" : "mobile",
        },
        lighthouseOptions: {
          onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
          throttlingMethod: "simulate",
        },
        puppeteerClusterOptions: {
          maxConcurrency: concurrency,
        },
      },
      { name: "ci" }
    );

    await ctx.setCiContext();
    await ctx.start();

    if (!ctx.routes?.length) {
      try {
        await ctx.worker.cluster.close();
      } catch {
        /* ignore */
      }
      await rm(outputPath, { recursive: true, force: true }).catch(() => {});
      await writeResult({
        ok: true,
        result: {
          formFactor,
          siteUrl,
          maxRoutes,
          routeCount: 0,
          rows: [],
          capped: false,
          note: "No pages were discovered (check sitemap, robots.txt, or try the homepage URL).",
        },
      });
      process.exit(0);
      return;
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      /** @type {ReturnType<typeof setInterval> | null} */
      let poll = null;

      const t = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (poll) clearInterval(poll);
          reject(new Error(`Site scan timed out after ${SITE_SCAN_TIMEOUT_MS / 60000} minutes`));
        }
      }, SITE_SCAN_TIMEOUT_MS);

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        if (poll) clearInterval(poll);
        resolve();
      };

      ctx.hooks.hookOnce("worker-finished", finish);

      poll = setInterval(() => {
        if (ctx.worker.monitor().status === "completed") finish();
      }, 2000);
    });

    const capped = ctx.worker.exceededMaxRoutes?.() === true;
    const raw = ctx.worker.reports();

    const rows = raw
      .map((r) => {
        const url = r.route.url;
        const lh = r.tasks.runLighthouseTask;
        if (lh !== "completed" || !r.report) {
          return {
            url,
            status: lh,
            performance: null,
            accessibility: null,
            bestPractices: null,
            seo: null,
            overall: null,
          };
        }
        const s = scoresFromUnlighthouseReport(r.report);
        return {
          url,
          status: "completed",
          performance: s.performance,
          accessibility: s.accessibility,
          bestPractices: s.bestPractices,
          seo: s.seo,
          overall: s.overall,
        };
      })
      .sort((a, b) => a.url.localeCompare(b.url));

    try {
      await ctx.worker.cluster.close();
    } catch {
      /* ignore */
    }

    await rm(outputPath, { recursive: true, force: true }).catch(() => {});

    await writeResult({
      ok: true,
      result: {
        formFactor,
        siteUrl,
        maxRoutes,
        rows,
        capped,
        routeCount: ctx.routes.length,
      },
    });
    process.exit(0);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    await writeResult({
      ok: false,
      error: e.message,
      code: "code" in e ? e.code : undefined,
    }).catch(() => {});
    process.exit(1);
  }
}

main();
