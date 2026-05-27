function scoreBand(score) {
  if (!Number.isFinite(score)) return "unknown";
  if (score >= 90) return "strong";
  if (score >= 75) return "mixed";
  return "weak";
}

function summarizeTopIssue(issue) {
  if (!issue) return null;
  return `${issue.title} appears across ${issue.pages} scanned pages.`;
}

function buildHeuristicInsights(run, artifact, pageResults = []) {
  if (run.scanMode === "site") {
    const avg = run.summary?.avgScores || {};
    const worstPages = (run.summary?.lowPages || []).slice(0, 3);
    const summary = [];
    summary.push(
      `Site-wide health is ${scoreBand(avg.overall)} with an average score of ${avg.overall ?? "n/a"} across ${run.summary?.routeCount || pageResults.length} pages.`
    );
    if (run.diff?.regressedPages) {
      summary.push(`${run.diff.regressedPages} pages regressed compared with the previous saved run.`);
    }
    if (artifact?.topIssues?.length) {
      summary.push(summarizeTopIssue(artifact.topIssues[0]));
    }

    const priorities = [];
    for (const issue of artifact?.topIssues || []) {
      priorities.push({
        title: issue.title,
        rationale: `Fixing ${issue.title.toLowerCase()} could improve many pages at once because it appears on ${issue.pages} pages.`,
        effort: issue.pages > 10 ? "template-level" : "page-level",
      });
    }
    if (!priorities.length && worstPages.length) {
      priorities.push({
        title: "Stabilize lowest-performing templates",
        rationale: `Start with ${worstPages.map((page) => page.url).join(", ")} because they are dragging down the site average.`,
        effort: "template-level",
      });
    }

    const patterns = [
      ...worstPages.map((page) => ({
        label: "Low-performing page",
        detail: `${page.url} scored ${page.overall}.`,
      })),
      ...(artifact?.topIssues || []).slice(0, 3).map((issue) => ({
        label: "Cross-page issue",
        detail: `${issue.title} is shared across ${issue.pages} pages.`,
      })),
    ];

    return {
      source: "heuristic",
      executiveSummary: summary.filter(Boolean),
      priorities: priorities.slice(0, 5),
      patterns: patterns.slice(0, 6),
      stakeholderSummary:
        "Use this run to brief the client on the handful of issues affecting many pages rather than walking through every URL one by one.",
    };
  }

  const categories = run.summary?.categories || {};
  const metrics = run.summary?.metrics || {};
  const topOpportunities = artifact?.topOpportunities || [];
  const summary = [
    `The page is in ${scoreBand(run.summary?.overall)} shape overall with a blended score of ${run.summary?.overall ?? "n/a"}.`,
    `Performance is ${categories.performance ?? "n/a"}, accessibility is ${categories.accessibility ?? "n/a"}, and SEO is ${categories.seo ?? "n/a"}.`,
  ];
  if (run.diff?.overallDelta) {
    const direction = run.diff.overallDelta > 0 ? "improved" : "declined";
    summary.push(`Overall quality ${direction} by ${Math.abs(run.diff.overallDelta)} points since the previous saved run.`);
  }
  if (Number.isFinite(metrics.lcpMs) && metrics.lcpMs > 2500) {
    summary.push(`Largest Contentful Paint is ${metrics.lcpMs}ms, so above-the-fold loading should be the first performance discussion point.`);
  }

  const priorities = topOpportunities.slice(0, 5).map((item) => ({
    title: item.title,
    rationale: item.displayValue
      ? `${item.title} is currently reported as ${item.displayValue}.`
      : `${item.title} is one of the lowest-scoring audits in this run.`,
    effort:
      item.id.includes("unused") || item.id.includes("render-blocking") || item.id.includes("image")
        ? "front-end"
        : "content",
  }));

  return {
    source: "heuristic",
    executiveSummary: summary,
    priorities,
    patterns: priorities.slice(0, 3).map((item) => ({
      label: item.title,
      detail: item.rationale,
    })),
    stakeholderSummary:
      "This page can be explained to the client as a short list of fix themes: loading speed, content hygiene, and technical SEO completeness.",
  };
}

async function generateOpenAIInsights(run, artifact, pageResults, heuristic) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const input = {
    run: {
      id: run.id,
      scanMode: run.scanMode,
      formFactor: run.formFactor,
      url: run.url,
      summary: run.summary,
      diff: run.diff,
    },
    artifact: run.scanMode === "single"
      ? {
          topOpportunities: artifact?.topOpportunities || [],
        }
      : {
          topIssues: artifact?.topIssues || [],
          lowPages: run.summary?.lowPages || [],
        },
    pageResults: run.scanMode === "site" ? pageResults.slice(0, 15) : [],
    heuristic,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You are generating concise agency-ready website audit insights. Return strict JSON with keys executiveSummary (array of strings), priorities (array of {title,rationale,effort}), patterns (array of {label,detail}), stakeholderSummary (string). Keep outputs grounded in the supplied scan data only.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(input),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "audit_insights",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["executiveSummary", "priorities", "patterns", "stakeholderSummary"],
            properties: {
              executiveSummary: {
                type: "array",
                items: { type: "string" },
              },
              priorities: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["title", "rationale", "effort"],
                  properties: {
                    title: { type: "string" },
                    rationale: { type: "string" },
                    effort: { type: "string" },
                  },
                },
              },
              patterns: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "detail"],
                  properties: {
                    label: { type: "string" },
                    detail: { type: "string" },
                  },
                },
              },
              stakeholderSummary: { type: "string" },
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status})`);
  }
  const json = await response.json();
  const text = json.output?.[0]?.content?.[0]?.text || json.output_text;
  if (!text) return null;
  const parsed = JSON.parse(text);
  return {
    ...parsed,
    source: "openai",
  };
}

export async function generateAiInsights(run, artifact, pageResults = []) {
  const heuristic = buildHeuristicInsights(run, artifact, pageResults);
  try {
    const llm = await generateOpenAIInsights(run, artifact, pageResults, heuristic);
    return llm || heuristic;
  } catch (err) {
    return {
      ...heuristic,
      source: `heuristic_fallback:${err instanceof Error ? err.message : "error"}`,
    };
  }
}
