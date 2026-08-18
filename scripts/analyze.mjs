import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const dataPath = path.join(root, "public", "data", "site-data.json");
const analysisDir = path.join(root, "public", "data", "analysis");
const manifestPath = path.join(analysisDir, "manifest.json");
const promptsPath = path.join(root, "prompts", "weekrep-analysis-prompts.json");
const innovationDir = path.join(root, "public", "data", "innovation");

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
const weekFilter = new Set((process.env.WEEKREP_ANALYZE_WEEKS || "").split(",").map((item) => item.trim()).filter(Boolean));
const monthFilter = new Set((process.env.WEEKREP_ANALYZE_MONTHS || "").split(",").map((item) => item.trim()).filter(Boolean));
const rollingPersonAnalysis = process.env.WEEKREP_ANALYZE_ROLLING === "1";
const analysisTypes = new Set((process.env.WEEKREP_ANALYZE_TYPES || "longitudinal,weekly-score,person-horizontal,week-horizontal,week-briefing").split(",").map((item) => item.trim()).filter(Boolean));
const concurrency = Math.max(1, Number(process.env.WEEKREP_ANALYZE_CONCURRENCY || 4));
const apiRetries = Math.max(0, Number(process.env.WEEKREP_ANALYZE_RETRIES || 3));
const apiTimeoutMs = Math.max(1000, Number(process.env.WEEKREP_ANALYZE_TIMEOUT_MS || 90000));
const minValidReportChars = Number(process.env.WEEKREP_MIN_VALID_REPORT_CHARS || 10);
const personWeekPolicy = process.env.WEEKREP_PERSON_WEEK_ANALYSIS_POLICY || "on-change";
const reanalyzeOnPromptChange = process.env.WEEKREP_REANALYZE_ON_PROMPT_CHANGE === "1";
const maxGeneratedPerRun = Math.max(0, Number(process.env.WEEKREP_ANALYZE_MAX_GENERATED_PER_RUN || 0));
let generatedStarted = 0;

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

function compactForBriefing(report) {
  const text = String(report.rawText || "");
  const lines = text.split(/\r?\n/);
  const picked = [];
  const headings = [
    /^#{0,3}\s*1[.、]?\s*/,
    /^#{0,3}\s*2[.、]?\s*CoT/i,
    /^#{0,3}\s*3[.、]?\s*CoT/i,
    /^#{0,3}\s*4[.、]?\s*/,
    /^#{0,3}\s*5[.、]?\s*/,
    /^#{0,3}\s*6[.、]?\s*/,
    /^#{0,3}\s*7[.、]?\s*/
  ];
  for (let i = 0; i < lines.length; i += 1) {
    if (!headings.some((pattern) => pattern.test(lines[i].trim()))) continue;
    picked.push(lines.slice(i, Math.min(lines.length, i + 18)).join("\n"));
  }
  const extract = picked.join("\n\n---\n\n").slice(0, 4200);
  return {
    week: report.week,
    name: report.name,
    userId: report.userId || "",
    submittedAt: report.submittedAt || report.updatedAt || report.createdAt || "",
    excerpt: report.excerpt || "",
    extractedText: extract || text.slice(0, 1800)
  };
}

function compactForMonthly(report) {
  const text = String(report.rawText || "");
  return {
    week: report.week,
    name: report.name,
    slug: report.slug,
    userId: report.userId || "",
    submittedAt: report.submittedAt || report.updatedAt || report.createdAt || "",
    excerpt: report.excerpt || text.replace(/\s+/g, " ").slice(0, 900),
    keywords: report.keywords || [],
    qualityScore: report.qualityScore
  };
}

async function weeklyHorizontalForMonth(month, weeks) {
  const items = [];
  for (const week of weeks) {
    const payload = await readJson(path.join(analysisDir, "weeks", `${week.week}.json`));
    if (!payload?.result) continue;
    items.push({
      week: week.week,
      submitted: week.submitted,
      reportCount: week.reportCount || week.submitted,
      result: payload.result
    });
  }
  return { month, weeks: items };
}

function teacherUnknownForWeek(site, week) {
  return site.teacherUnknown?.weeks?.find((item) => item.week === week)?.items?.map((item) => ({
    name: item.name,
    title: item.title,
    content: item.content,
    why: item.why,
    gap: item.gap,
    insight: item.insight,
    evidence: item.evidence
  })) || [];
}

function isValidReport(report) {
  return String(report?.rawText || "").trim().length > minValidReportChars;
}

function compactInnovationIdea(idea) {
  return {
    ideaId: idea.ideaId,
    project: idea.project || "",
    idea: idea.idea || "",
    startingProblem: idea.startingProblem || "",
    formationProcess: idea.formationProcess || "",
    innovationPoint: idea.innovationPoint || "",
    rawText: idea.rawText || ""
  };
}

function validInnovationPersonOutput(result, expectedIdeaIds) {
  const ideas = result?.ideas;
  if (!Array.isArray(ideas) || !ideas.length) return false;
  const returned = new Set(ideas.map((idea) => idea?.ideaId).filter(Boolean));
  return expectedIdeaIds.every((ideaId) => returned.has(ideaId));
}

function validInnovationWeekOutput(result, input) {
  const methods = result?.methods;
  if (!Array.isArray(methods) || !methods.length) return false;
  const methodIds = new Set(methods.map((method) => method?.id).filter(Boolean));
  const inputIdeaIds = new Set(input.people.flatMap((person) => person.result.ideas.map((idea) => idea.ideaId)));
  if (methods.some((method) => !method?.id || !Array.isArray(method.ideaIds) || method.ideaIds.some((ideaId) => !inputIdeaIds.has(ideaId)))) return false;
  return asArrayForValidation(result.relations).every((relation) => (
    methodIds.has(relation?.source)
    && methodIds.has(relation?.target)
    && asArrayForValidation(relation?.ideaIds).every((ideaId) => inputIdeaIds.has(ideaId))
  ));
}

function asArrayForValidation(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(label, url, options) {
  let lastError = null;
  for (let attempt = 0; attempt <= apiRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), apiTimeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (response.ok) return response;
      const text = await response.text();
      const transient = response.status === 429 || response.status >= 500;
      lastError = new Error(`${label} API error ${response.status}: ${text}`);
      if (!transient || attempt >= apiRetries) throw lastError;
    } catch (error) {
      lastError = error?.name === "AbortError"
        ? new Error(`${label} API request timed out after ${apiTimeoutMs}ms`)
        : error;
      if (attempt >= apiRetries) throw lastError;
    } finally {
      clearTimeout(timeout);
    }
    const jitter = Math.floor(Math.random() * 500);
    await sleep(1000 * 2 ** attempt + jitter);
  }
  throw lastError;
}

async function callModel({ system, prompt, input }) {
  if (!apiKey) {
    return {
      skipped: true,
      reason: provider === "deepseek" ? "DEEPSEEK_API_KEY is not set" : "OPENAI_API_KEY is not set"
    };
  }

  if (provider === "deepseek") {
    const response = await fetchWithRetry("DeepSeek", "https://api.deepseek.com/chat/completions", {
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

    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content || "";
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  const response = await fetchWithRetry("OpenAI", "https://api.openai.com/v1/responses", {
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

  const payload = await response.json();
  const text = textFromResponse(payload);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function analyzeItem({ key, file, input, prompt, system, manifest, cachePolicy = "hash", validateResult = null }) {
  const contentHash = hash({ input });
  const promptHash = hash({ prompt, system, model, reasoningEffort });
  const inputHash = reanalyzeOnPromptChange ? hash({ contentHash, promptHash }) : contentHash;
  const previous = manifest.items[key];
  const fileExists = await fs.access(file).then(() => true, () => false);
  const existingPayload = fileExists && validateResult ? await readJson(file) : null;
  const validFile = fileExists && (!validateResult || validateResult(existingPayload?.result, input));
  if (!force && cachePolicy === "once" && validFile) {
    if (!previous) {
      manifest.items[key] = {
        inputHash,
        contentHash,
        promptHash,
        file: path.relative(path.join(root, "public"), file).replace(/\\/g, "/"),
        generatedAt: new Date().toISOString()
      };
    } else if (!previous.contentHash) {
      previous.contentHash = contentHash;
      previous.promptHash = previous.promptHash || promptHash;
    }
    return { key, status: "cached" };
  }
  if (!force && validFile && previous && !previous.contentHash) {
    previous.contentHash = contentHash;
    previous.promptHash = previous.promptHash || promptHash;
    previous.inputHash = inputHash;
    return { key, status: "cached" };
  }
  if (!force && previous?.inputHash === inputHash && validFile) {
    return { key, status: "cached" };
  }
  if (maxGeneratedPerRun && generatedStarted >= maxGeneratedPerRun) {
    return { key, status: "skipped" };
  }
  generatedStarted += 1;

  let result;
  try {
    result = await callModel({ system, prompt, input });
    if (validateResult && !result?.skipped && !validateResult(result, input)) {
      throw new Error(`Analysis returned invalid structured output for ${key}`);
    }
  } catch (error) {
    manifest.items[key] = {
      inputHash: previous?.inputHash || "",
      contentHash: previous?.contentHash || contentHash,
      promptHash: previous?.promptHash || promptHash,
      file: path.relative(path.join(root, "public"), file).replace(/\\/g, "/"),
      failedAt: new Date().toISOString(),
      error: error?.message || String(error)
    };
    console.warn(`Analysis failed for ${key}: ${error?.message || error}`);
    return { key, status: "failed" };
  }

  const payload = {
    key,
    generatedAt: new Date().toISOString(),
    provider,
    model,
    reasoningEffort,
    inputHash,
    contentHash,
    promptHash,
    result
  };
  await writeJson(file, payload);
  manifest.items[key] = {
    inputHash,
    contentHash,
    promptHash,
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
  const innovationCandidates = [];
  const system = prompts.sharedSystemPrompt;
  const weeksById = Object.fromEntries(site.weeks.map((week) => [week.week, week]));
  const shouldQueuePersonWeek = (week) => {
    if (weekFilter.size && !weekFilter.has(week)) return false;
    if (personWeekPolicy === "on-change") return true;
    if (personWeekPolicy === "immediate-once") return true;
    return weeksById[week]?.pastDeadline === true || Date.now() > Date.parse(weeksById[week]?.deadline || "");
  };
  const personWeekCachePolicy = personWeekPolicy.endsWith("once") ? "once" : "hash";

  const reportsByPerson = Map.groupBy(site.reports, (report) => report.slug);
  for (const person of site.people) {
    if (personFilter.size && !personFilter.has(person.slug)) continue;
    const allReports = (reportsByPerson.get(person.slug) || []).filter(isValidReport).sort((a, b) => a.week.localeCompare(b.week));
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

    if (analysisTypes.has("person-horizontal")) {
      for (const report of allReports) {
        if (!shouldQueuePersonWeek(report.week)) continue;
        const weekInfo = weeksById[report.week] || {};
        const targetReport = compactReport(report);
        const weekContext = {
          submitted: weekInfo.submitted,
          rosterSize: weekInfo.rosterSize,
          reportCount: weekInfo.reportCount || weekInfo.submitted,
          deadline: weekInfo.deadline,
          themes: (weekInfo.analysis?.themes || []).slice(0, 12),
          standard: {
            levels: ["好", "很好", "非常好", "特别值得读"],
            focus: ["硬进展", "认知增量", "价值判断", "项目管理", "元认知变化", "Brainary 映射", "证据质量", "下周动作质量"],
            note: "不要点名比较同学，只按本周研究管理标准给目标学生反馈。"
          }
        };
        jobs.push({
          key: `person:${person.slug}:${report.week}:horizontal`,
          file: path.join(analysisDir, "people", person.slug, `${report.week}-horizontal.json`),
          system,
          prompt: prompts.prompts.personHorizontal.prompt,
          input: {
            week: report.week,
            targetPerson: {
              name: person.name,
              slug: person.slug,
              report: targetReport
            },
            weekContext
          },
          latestReportHash: hash({
            target: targetReport,
            weekContext
          }),
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

  const pastDeadlineWeeks = site.weeks
    .filter(pastDeadline)
    .sort((a, b) => String(a.week).localeCompare(String(b.week)));
  const latestBriefingWeek = pastDeadlineWeeks.at(-1)?.week || "";

  for (const week of pastDeadlineWeeks) {
    if (weekFilter.size && !weekFilter.has(week.week)) continue;
    if (personFilter.size) continue;
    const reports = site.reports
      .filter((report) => report.week === week.week)
      .filter(isValidReport);
    const compactReports = reports.map(compactReport);
    const roster = [
      ...compactReports.map((report) => ({
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
    ];
    if (analysisTypes.has("week-horizontal")) {
      jobs.push({
        key: `week:${week.week}:horizontal`,
        file: path.join(analysisDir, "weeks", `${week.week}.json`),
        system,
        prompt: prompts.prompts.weekHorizontalRanking.prompt,
        input: {
          week: week.week,
          deadline: week.deadline,
          roster,
          reports: compactReports
        }
      });
    }
    if (analysisTypes.has("week-briefing") && (weekFilter.size || week.week === latestBriefingWeek)) {
      jobs.push({
        key: `week:${week.week}:briefing`,
        file: path.join(analysisDir, "briefings", `${week.week}.json`),
        system,
        prompt: prompts.prompts.weekBriefing.prompt,
        input: {
          week: week.week,
          deadline: week.deadline,
          status: {
            submitted: week.submitted,
            rosterSize: week.rosterSize,
            missingCount: week.missingCount
          },
          roster,
          teacherUnknown: teacherUnknownForWeek(site, week.week),
          reports: reports.map(compactForBriefing)
        }
      });
    }
  }

  if (analysisTypes.has("innovation-week")) {
    const innovationStartWeek = site.innovation?.startWeek || "2026-08-23";
    const eligibleWeeks = pastDeadlineWeeks.filter((week) => (
      week.week >= innovationStartWeek
      && (!weekFilter.size || weekFilter.has(week.week))
    ));
    for (const week of eligibleWeeks) {
      const rawWeek = await readJson(path.join(innovationDir, "weeks", `${week.week}.json`));
      if (!rawWeek?.items?.length) continue;
      const byPerson = Map.groupBy(rawWeek.items, (idea) => idea.slug);
      const people = [...byPerson.entries()].map(([personSlug, ideas]) => ({
        slug: personSlug,
        name: ideas[0]?.name || personSlug,
        ideas: ideas.slice().sort((a, b) => a.ideaIndex - b.ideaIndex)
      })).sort((a, b) => a.name.localeCompare(b.name));
      innovationCandidates.push({ week: week.week, rawWeek, people });
      for (const person of people) {
        jobs.push({
          key: `innovation:person:${person.slug}:${week.week}`,
          file: path.join(analysisDir, "innovation", "people", person.slug, `${week.week}.json`),
          system,
          prompt: prompts.prompts.innovationPerson.prompt,
          input: {
            week: week.week,
            name: person.name,
            ideas: person.ideas.map(compactInnovationIdea)
          },
          cachePolicy: "once",
          validateResult: (result) => validInnovationPersonOutput(result, person.ideas.map((idea) => idea.ideaId))
        });
      }
    }
  }

  if (analysisTypes.has("month-horizontal") && !personFilter.size) {
    const monthGroups = Map.groupBy(pastDeadlineWeeks, (week) => String(week.week).slice(0, 7));
    for (const [month, monthWeeks] of monthGroups) {
      if (monthFilter.size && !monthFilter.has(month)) continue;
      if (weekFilter.size && !monthWeeks.some((week) => weekFilter.has(week.week))) continue;
      const monthReports = site.reports
        .filter((report) => String(report.week).startsWith(`${month}-`))
        .filter(isValidReport);
      if (!monthReports.length) continue;
      const reportsBySlug = Map.groupBy(monthReports, (report) => report.slug);
      const people = [...reportsBySlug.entries()]
        .map(([slug, reports]) => ({
          slug,
          name: reports[0]?.name || slug,
          submittedWeeks: reports.map((report) => report.week).sort(),
          reportCount: reports.length,
          reports: reports
            .slice()
            .sort((a, b) => a.week.localeCompare(b.week))
            .map(compactForMonthly)
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      jobs.push({
        key: `month:${month}:horizontal`,
        file: path.join(analysisDir, "months", `${month}.json`),
        system,
        prompt: prompts.prompts.monthHorizontal.prompt,
        input: {
          month,
          weeks: monthWeeks.map((week) => ({
            week: week.week,
            deadline: week.deadline,
            submitted: week.submitted,
            rosterSize: week.rosterSize,
            reportCount: week.reportCount || week.submitted
          })),
          weeklyHorizontal: await weeklyHorizontalForMonth(month, monthWeeks),
          people
        }
      });
    }
  }

  const selectedJobs = analyzeLimit > 0 ? jobs.slice(0, analyzeLimit) : jobs;
  const results = await runConcurrent(
    selectedJobs,
    (job) => analyzeItem({ ...job, manifest }),
    concurrency
  );

  const innovationWeekJobs = [];
  for (const candidate of innovationCandidates) {
    const personalSummaries = [];
    let complete = true;
    for (const person of candidate.people) {
      const file = path.join(analysisDir, "innovation", "people", person.slug, `${candidate.week}.json`);
      const payload = await readJson(file);
      const expectedIdeaIds = person.ideas.map((idea) => idea.ideaId);
      if (!validInnovationPersonOutput(payload?.result, expectedIdeaIds)) {
        complete = false;
        break;
      }
      personalSummaries.push({
        name: person.name,
        slug: person.slug,
        result: payload.result
      });
    }
    if (!complete) {
      console.warn(`Innovation week ${candidate.week} is waiting for complete personal summaries.`);
      continue;
    }
    innovationWeekJobs.push({
      key: `innovation:week:${candidate.week}`,
      file: path.join(analysisDir, "innovation", "weeks", `${candidate.week}.json`),
      system,
      prompt: prompts.prompts.innovationWeek.prompt,
      input: {
        week: candidate.week,
        ideaCount: candidate.rawWeek.count,
        peopleCount: candidate.rawWeek.peopleCount,
        people: personalSummaries
      },
      cachePolicy: "once",
      validateResult: validInnovationWeekOutput
    });
  }
  const innovationWeekResults = await runConcurrent(
    innovationWeekJobs,
    (job) => analyzeItem({ ...job, manifest }),
    concurrency
  );
  const allResults = [...results, ...innovationWeekResults];

  manifest.summary = {
    total: selectedJobs.length + innovationWeekJobs.length,
    available: jobs.length + innovationWeekJobs.length,
    concurrency,
    types: [...analysisTypes],
    generated: allResults.filter((item) => item.status === "generated").length,
    cached: allResults.filter((item) => item.status === "cached").length,
    skipped: allResults.filter((item) => item.status === "skipped").length,
    failed: allResults.filter((item) => item.status === "failed").length
  };
  await writeJson(manifestPath, manifest);
  console.log(`Analysis jobs: ${manifest.summary.generated} generated, ${manifest.summary.cached} cached, ${manifest.summary.skipped} skipped, ${manifest.summary.failed} failed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
