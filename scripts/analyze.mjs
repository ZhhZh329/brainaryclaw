import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const dataPath = path.join(root, "public", "data", "site-data.json");
const analysisDir = path.join(root, "public", "data", "analysis");
const manifestPath = path.join(analysisDir, "manifest.json");
const promptsPath = path.join(root, "prompts", "weekrep-analysis-prompts.json");

await loadLocalEnv();

const provider = process.env.LLM_PROVIDER || (process.env.DEEPSEEK_API_KEY ? "deepseek" : "openai");
const model = provider === "deepseek"
  ? (process.env.DEEPSEEK_MODEL || "deepseek-v4-pro")
  : (process.env.OPENAI_MODEL || "gpt-5.2-codex");
const reasoningEffort = provider === "deepseek"
  ? (process.env.DEEPSEEK_REASONING_EFFORT || "high")
  : (process.env.OPENAI_REASONING_EFFORT || "medium");
const longitudinalWindow = Number(process.env.WEEKREP_LONGITUDINAL_WEEKS || 4);
const force = process.env.WEEKREP_ANALYZE_FORCE === "1";
const apiKey = provider === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
const analyzeLimit = Number(process.env.WEEKREP_ANALYZE_LIMIT || 0);
const personFilter = new Set((process.env.WEEKREP_ANALYZE_PERSON_SLUGS || "").split(",").map((item) => item.trim()).filter(Boolean));
const rollingPersonAnalysis = process.env.WEEKREP_ANALYZE_ROLLING === "1";
const analysisTypes = new Set((process.env.WEEKREP_ANALYZE_TYPES || "longitudinal,weekly-score,week-horizontal").split(",").map((item) => item.trim()).filter(Boolean));
const concurrency = Math.max(1, Number(process.env.WEEKREP_ANALYZE_CONCURRENCY || 4));
const personWeekPolicy = process.env.WEEKREP_PERSON_WEEK_ANALYSIS_POLICY || "deadline-once";

async function loadLocalEnv() {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(root, name);
    let text = "";
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 0) continue;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

const readJson = async (file, fallback = null) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const slug = (value) => {
  const result = String(value || "").normalize("NFKD").replace(/[^\p{Letter}\p{Number}\s-]/gu, "").trim().replace(/\s+/g, "-").toLowerCase();
  return result || `name-${Buffer.from(String(value || "unknown")).toString("hex").slice(0, 16)}`;
};
const pastDeadline = (week) => week?.pastDeadline === true || Date.now() > Date.parse(week?.deadline || "");

function compactReport(report) {
  return {
    week: report.week,
    name: report.name,
    userId: report.userId || "",
    submittedAt: report.submittedAt || report.updatedAt || report.createdAt || "",
    rawText: report.rawText
  };
}

function textFromResponse(payload) {
  if (payload.output_text) return payload.output_text;
  const parts = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function callModel({ system, prompt, input }) {
  if (!apiKey) {
    return {
      skipped: true,
      reason: provider === "deepseek" ? "DEEPSEEK_API_KEY is not set" : "OPENAI_API_KEY is not set"
    };
  }

  if (provider === "deepseek") {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${prompt}\n\nINPUT JSON:\n${JSON.stringify(input)}` }
        ],
        thinking: { type: process.env.DEEPSEEK_THINKING || "enabled" },
        reasoning_effort: reasoningEffort,
        response_format: { type: "json_object" },
        stream: false
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${text}`);
    }

    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content || "";
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: reasoningEffort },
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: system }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: `${prompt}\n\nINPUT JSON:\n${JSON.stringify(input)}` }]
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const payload = await response.json();
  const text = textFromResponse(payload);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function analyzeItem({ key, file, input, prompt, system, manifest, cachePolicy = "hash" }) {
  const inputHash = hash({ input, prompt, system, model, reasoningEffort });
  const previous = manifest.items[key];
  const fileExists = await fs.access(file).then(() => true, () => false);
  if (!force && cachePolicy === "once" && fileExists) {
    if (!previous) {
      manifest.items[key] = {
        inputHash,
        file: path.relative(path.join(root, "public"), file).replace(/\\/g, "/"),
        generatedAt: new Date().toISOString()
      };
    }
    return { key, status: "cached" };
  }
  if (!force && previous?.inputHash === inputHash && fileExists) {
    return { key, status: "cached" };
  }

    const result = await callModel({ system, prompt, input });
    const payload = {
      key,
      generatedAt: new Date().toISOString(),
      provider,
      model,
      reasoningEffort,
      inputHash,
    result
  };
  await writeJson(file, payload);
  manifest.items[key] = {
    inputHash,
    file: path.relative(path.join(root, "public"), file).replace(/\\/g, "/"),
    generatedAt: payload.generatedAt
  };
  return { key, status: result.skipped ? "skipped" : "generated" };
}

async function runConcurrent(items, worker, limit) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const site = await readJson(dataPath);
  if (!site) throw new Error("Run npm run build before npm run analyze.");
  const prompts = await readJson(promptsPath);
  if (!prompts) throw new Error("Missing prompts/weekrep-analysis-prompts.json.");

  await fs.mkdir(analysisDir, { recursive: true });
  const manifest = await readJson(manifestPath, { version: "0.1.0", items: {} });
  manifest.provider = provider;
  manifest.model = model;
  manifest.reasoningEffort = reasoningEffort;
  manifest.longitudinalWindow = longitudinalWindow;
  manifest.updatedAt = new Date().toISOString();

  const jobs = [];
  const system = prompts.sharedSystemPrompt;
  const weeksById = Object.fromEntries(site.weeks.map((week) => [week.week, week]));
  const shouldQueuePersonWeek = (week) => {
    if (personWeekPolicy === "on-change") return true;
    if (personWeekPolicy === "immediate-once") return true;
    return weeksById[week]?.pastDeadline === true || Date.now() > Date.parse(weeksById[week]?.deadline || "");
  };
  const personWeekCachePolicy = personWeekPolicy.endsWith("once") ? "once" : "hash";

  const reportsByPerson = Map.groupBy(site.reports, (report) => report.slug);
  for (const person of site.people) {
    if (personFilter.size && !personFilter.has(person.slug)) continue;
    const allReports = (reportsByPerson.get(person.slug) || []).sort((a, b) => a.week.localeCompare(b.week));
    if (!allReports.length) continue;
    const windows = rollingPersonAnalysis
      ? allReports.map((report, index) => ({
        week: report.week,
        reports: allReports.slice(Math.max(0, index + 1 - longitudinalWindow), index + 1).map(compactReport),
        latestReport: report
      }))
      : [{
        week: "latest",
        reports: allReports.slice(-longitudinalWindow).map(compactReport),
        latestReport: allReports.at(-1)
      }];

    for (const window of windows) {
      const policyWeek = window.week === "latest" ? window.latestReport.week : window.week;
      const suffix = window.week === "latest" ? "" : `-${window.week}`;
      if (analysisTypes.has("longitudinal")) {
        if (!shouldQueuePersonWeek(policyWeek)) continue;
        jobs.push({
          key: window.week === "latest" ? `person:${person.slug}:longitudinal` : `person:${person.slug}:${window.week}:longitudinal`,
          file: window.week === "latest"
            ? path.join(analysisDir, "people", `${person.slug}-longitudinal.json`)
            : path.join(analysisDir, "people", person.slug, `${window.week}-longitudinal.json`),
          system,
          prompt: prompts.prompts.personLongitudinal.prompt,
          input: {
            name: person.name,
            asOfWeek: window.week,
            windowWeeks: longitudinalWindow,
            reports: window.reports
          },
          personHash: hash(window.reports),
          latestReportHash: hash(compactReport(window.latestReport)),
          suffix,
          cachePolicy: personWeekCachePolicy
        });
      }

      if (analysisTypes.has("value-shift")) {
        if (!shouldQueuePersonWeek(policyWeek)) continue;
        jobs.push({
          key: window.week === "latest" ? `person:${person.slug}:value-shift` : `person:${person.slug}:${window.week}:value-shift`,
          file: window.week === "latest"
            ? path.join(analysisDir, "people", `${person.slug}-value-shift.json`)
            : path.join(analysisDir, "people", person.slug, `${window.week}-value-shift.json`),
          system,
          prompt: prompts.prompts.personValueShift.prompt,
          input: {
            name: person.name,
            asOfWeek: window.week,
            windowWeeks: longitudinalWindow,
            reports: window.reports
          },
          personHash: hash(window.reports),
          latestReportHash: hash(compactReport(window.latestReport)),
          suffix,
          cachePolicy: personWeekCachePolicy
        });
      }
    }

    const latestReport = allReports.at(-1);
    if (analysisTypes.has("weekly-score")) {
      for (const report of allReports) {
        if (!shouldQueuePersonWeek(report.week)) continue;
        jobs.push({
          key: `person:${person.slug}:${report.week}:weekly-score`,
          file: path.join(analysisDir, "people", person.slug, `${report.week}-weekly-score.json`),
          system,
          prompt: prompts.prompts.weeklyScore.prompt,
          input: compactReport(report),
          latestReportHash: hash(compactReport(report)),
          cachePolicy: personWeekCachePolicy
        });
      }
    }

    if (analysisTypes.has("deep-read")) {
      jobs.push({
        key: `report:${latestReport.week}:${person.slug}:deep-read`,
        file: path.join(analysisDir, "reports", latestReport.week, `${person.slug}.json`),
        system,
        prompt: prompts.prompts.singleReportDeepRead.prompt,
        input: compactReport(latestReport),
        latestReportHash: hash(compactReport(latestReport))
      });
    }
  }

  for (const week of site.weeks.filter(pastDeadline)) {
    if (!analysisTypes.has("week-horizontal")) continue;
    if (personFilter.size) continue;
    const reports = site.reports
      .filter((report) => report.week === week.week)
      .map(compactReport);
    jobs.push({
      key: `week:${week.week}:horizontal`,
      file: path.join(analysisDir, "weeks", `${week.week}.json`),
      system,
      prompt: prompts.prompts.weekHorizontalRanking.prompt,
      input: {
        week: week.week,
        deadline: week.deadline,
        roster: [
          ...reports.map((report) => ({
            name: report.name,
            userId: report.userId,
            status: "submitted",
            submittedAt: report.submittedAt
          })),
          ...week.missing.map((item) => ({
            name: item.name,
            userId: item.userId || "",
            status: week.pastDeadline ? "missing" : "pending"
          }))
        ],
        reports
      }
    });
  }

  const selectedJobs = analyzeLimit > 0 ? jobs.slice(0, analyzeLimit) : jobs;
  const results = await runConcurrent(
    selectedJobs,
    (job) => analyzeItem({ ...job, manifest }),
    concurrency
  );

  manifest.summary = {
    total: selectedJobs.length,
    available: jobs.length,
    concurrency,
    types: [...analysisTypes],
    generated: results.filter((item) => item.status === "generated").length,
    cached: results.filter((item) => item.status === "cached").length,
    skipped: results.filter((item) => item.status === "skipped").length
  };
  await writeJson(manifestPath, manifest);
  console.log(`Analysis jobs: ${manifest.summary.generated} generated, ${manifest.summary.cached} cached, ${manifest.summary.skipped} skipped.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
