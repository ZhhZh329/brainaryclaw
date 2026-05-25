import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const publicDir = path.join(root, "public");
const dataDir = path.join(publicDir, "data");

const sourceRoot = process.env.OPENCLAW_ROOT || "\\\\wsl.localhost\\Ubuntu\\home\\brainary\\.openclaw";
const reportsDir = process.env.WEEKREP_REPORTS_DIR || path.join(sourceRoot, "weekly_reports");
const inboundDir = process.env.WEEKREP_INBOUND_DIR || path.join(sourceRoot, "media", "inbound");
const weeklyStateDir = process.env.WEEKREP_STATE_DIR || path.join(sourceRoot, "data", "weekly_state");
const registryPath = process.env.WEEKREP_REGISTRY_PATH || path.join(sourceRoot, "data", "registry.json");
const templatePath = process.env.WEEKREP_TEMPLATE_PATH || path.join(sourceRoot, "WEEKLY_REPORT_TEMPLATE.md");
const nameAliasesPath = process.env.WEEKREP_NAME_ALIASES_PATH || path.join(root, "config", "name-aliases.json");
const excludedWeeks = new Set((process.env.WEEKREP_EXCLUDED_WEEKS || "2026-03-08").split(",").map((week) => week.trim()).filter(Boolean));

async function readJson(file) {
  const text = await fs.readFile(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    const repaired = text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    try {
      return JSON.parse(repaired);
    } catch {
      error.message = `${error.message} in ${file}`;
      throw error;
    }
  }
}

async function readReportJson(file, week, fallbackName) {
  try {
    return await readJson(file);
  } catch {
    const text = await fs.readFile(file, "utf8");
    const field = (key) => {
      const match = text.match(new RegExp(`"${key}"\\s*:\\s*("([^"]*)"|[0-9]+|null)`));
      if (!match) return null;
      if (match[1] === "null") return null;
      if (/^[0-9]+$/.test(match[1])) return Number(match[1]);
      return match[2];
    };
    const rawStartToken = '"raw_text"';
    const rawStart = text.indexOf(rawStartToken);
    let rawText = "";
    if (rawStart >= 0) {
      const firstQuote = text.indexOf('"', text.indexOf(":", rawStart) + 1);
      const endMarker = text.indexOf('",\n  "updated_at"', firstQuote + 1);
      const rawEncoded = endMarker > firstQuote ? text.slice(firstQuote + 1, endMarker) : text.slice(firstQuote + 1);
      rawText = rawEncoded
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return {
      created_at: field("created_at"),
      cycle_sunday: field("cycle_sunday") || week,
      name: field("name") || fallbackName,
      parsed: null,
      raw_text: rawText || text,
      updated_at: field("updated_at"),
      user_id: field("user_id"),
      version: field("version") || 1
    };
  }
}
const exists = async (file) => fs.access(file).then(() => true, () => false);

function isSundayWeek(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) return false;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0;
}

function slugify(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return slug || `name-${Buffer.from(String(value || "unknown")).toString("hex").slice(0, 16)}`;
}

function stripMarkdown(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()]|---/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippet(text, length = 240) {
  const clean = stripMarkdown(text);
  return clean.length > length ? `${clean.slice(0, length)}...` : clean;
}

function section(text, heading) {
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(heading));
  if (start < 0) return "";
  const picked = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,3}\s+/.test(lines[i]) && picked.length) break;
    picked.push(lines[i]);
  }
  return picked.join("\n").trim();
}

function keywordScore(text) {
  const words = [
    "实验", "评测", "benchmark", "论文", "系统", "数据", "接口", "agent", "RAG",
    "memory", "模型", "开源", "架构", "API", "自动化", "复现", "指标", "工具"
  ];
  return words
    .map((word) => ({ word, count: (String(text).match(new RegExp(word, "gi")) || []).length }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function reportQuality(report) {
  const text = report.raw_text || "";
  let score = 0;
  const signals = [
    "硬进展", "新实验发现", "卡点", "下周", "CoT", "证据等级", "自动化潜力",
    "benchmark", "评测", "实验", "沉淀", "系统", "论文"
  ];
  for (const signal of signals) {
    if (text.includes(signal)) score += 1;
  }
  score += Math.min(6, Math.floor(text.length / 1200));
  return score;
}

function deadlineForWeek(week) {
  const [year, month, day] = week.split("-").map(Number);
  const sundayUtcMs = Date.UTC(year, month - 1, day);
  const monday0800Plus8 = new Date(sundayUtcMs + 24 * 60 * 60 * 1000);
  return `${monday0800Plus8.toISOString().slice(0, 10)}T08:00:00+08:00`;
}

function sundayFromDate(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  const delta = 7 - date.getUTCDay();
  const sunday = new Date(date.getTime() + (delta === 7 ? 0 : delta) * 24 * 60 * 60 * 1000);
  return sunday.toISOString().slice(0, 10);
}

function parseInboundReportFileName(fileName) {
  const baseName = path.basename(fileName, path.extname(fileName));
  const match = baseName.match(/^(.+?)-周报-(\d{4}-\d{2}-\d{2})至(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  return {
    originalName: match[1].trim(),
    week: sundayFromDate(match[3])
  };
}

function parseTime(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function isLate(report, deadline) {
  const submittedAt = parseTime(report.submittedAt || report.updatedAt || report.createdAt);
  const deadlineAt = parseTime(deadline);
  return submittedAt !== null && deadlineAt !== null && submittedAt > deadlineAt;
}

function identityKeyFromParts(userId, name) {
  return userId ? `id:${userId}` : `name:${slugify(name)}`;
}

function registryIndexes(registry) {
  const members = registry.members || [];
  return {
    byId: Object.fromEntries(members.filter((member) => member.user_id).map((member) => [String(member.user_id), member])),
    byName: Object.fromEntries(members.filter((member) => member.name).map((member) => [slugify(member.name), member]))
  };
}

function isCountableMember(member) {
  if (!member) return true;
  if (member.active === false) return false;
  if (member.role === "teacher") return false;
  return true;
}

function buildRoster(registry, reports, latestWeek) {
  const { byId, byName } = registryIndexes(registry);
  const identities = new Map();

  const upsert = (key, value) => {
    const existing = identities.get(key) || {};
    identities.set(key, {
      ...existing,
      ...value,
      weeks: [...new Set([...(existing.weeks || []), ...(value.weeks || [])])].sort()
    });
  };

  for (const member of registry.members || []) {
    if (!isCountableMember(member)) continue;
    const userId = member.user_id ? String(member.user_id) : "";
    const key = identityKeyFromParts(userId, member.name);
    upsert(key, {
      key,
      userId,
      name: member.name,
      role: member.role,
      isAdmin: Boolean(member.is_admin),
      fromRegistry: true,
      weeks: []
    });
  }

  for (const report of reports) {
    const member = (report.userId ? byId[report.userId] : null) || byName[report.slug];
    if (!isCountableMember(member)) continue;
    const userId = report.userId || (member?.user_id ? String(member.user_id) : "");
    const name = member?.name || report.name;
    const key = identityKeyFromParts(userId, name);
    report.identityKey = key;
    upsert(key, {
      key,
      userId,
      name,
      role: member?.role || "student",
      isAdmin: Boolean(member?.is_admin),
      fromRegistry: Boolean(member),
      weeks: [report.week]
    });
  }

  return [...identities.values()]
    .map((identity) => ({
      ...identity,
      activeFrom: identity.weeks[0] || latestWeek
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function analyzeWeek(week, reports, roster, submittedRoster, missing, late, pastDeadline) {
  const sorted = [...reports].sort((a, b) => reportQuality(b) - reportQuality(a));
  const allText = reports.map((report) => report.raw_text || "").join("\n");
  const missingLabel = pastDeadline ? "未提交" : "待提交";
  return {
    summary: `${week} 应交 ${roster.length} 人，已交 ${submittedRoster.length} 人，收录原件 ${reports.length} 份。${missing.length ? `仍有 ${missing.length} 人${missingLabel}。` : "全部已提交。"}${late.length ? ` ${late.length} 人晚于周一 08:00 截止线提交。` : ""} 从文本信号看，本周更值得先看的报告集中在硬进展、实验发现、卡点和可沉淀方向写得更完整的人。`,
    topPerformers: sorted.slice(0, 8).map((report) => ({
      name: report.name,
      score: reportQuality(report),
      reason: snippet(section(report.raw_text, "本周核心任务") || report.raw_text, 180)
    })),
    themes: keywordScore(allText),
    missingUserIds: missing.map((item) => item.userId),
    lateUserIds: late.map((item) => item.userId)
  };
}

function analyzePerson(name, reports) {
  const chronological = [...reports].sort((a, b) => a.week.localeCompare(b.week));
  const valuesText = chronological
    .map((report) => `${report.week}\n${section(report.raw_text, "对 meta-cognition 的新理解")}\n${section(report.raw_text, "题目是否值得做")}`)
    .join("\n\n");
  const repeatedBlocks = chronological.map((report) => ({
    week: report.week,
    valueSnippet: snippet(section(report.raw_text, "对 meta-cognition 的新理解") || section(report.raw_text, "CoT’s CoT") || report.raw_text, 220),
    blockerSnippet: snippet(section(report.raw_text, "当前卡点") || report.raw_text, 160),
    score: reportQuality(report)
  }));
  const first = repeatedBlocks[0]?.valueSnippet || "";
  const latest = repeatedBlocks.at(-1)?.valueSnippet || "";
  return {
    summary: `${name} 共有 ${reports.length} 份周报。纵向看，可以优先比较早期和最近两周的“meta-cognition / 题目价值 / CoT's CoT”部分，判断研究判断是否从任务执行转向问题定义、评测和系统沉淀。`,
    valueShift: {
      early: first,
      latest,
      reading: valuesText ? snippet(valuesText, 520) : "没有抽到稳定的价值观字段，建议直接看时间线原文。"
    },
    timeline: repeatedBlocks
  };
}

async function collectReports(registry, nameAliases) {
  const { byId, byName } = registryIndexes(registry);
  const weeks = (await fs.readdir(reportsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((week) => !excludedWeeks.has(week))
    .sort();
  const reports = [];
  for (const week of weeks) {
    const weekDir = path.join(reportsDir, week);
    const files = (await fs.readdir(weekDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
    for (const file of files) {
      const sourcePath = path.join(weekDir, file);
      const fallbackName = path.basename(file, ".json");
      const data = await readReportJson(sourcePath, week, fallbackName);
      const name = data.name || fallbackName;
      const rawText = data.raw_text || "";
      reports.push({
        id: `${week}/${slugify(name)}`,
        week,
        name,
        slug: slugify(name),
        userId: data.user_id ? String(data.user_id) : "",
        createdAt: data.created_at || "",
        updatedAt: data.updated_at || "",
        submittedAt: "",
        version: data.version || 1,
        rawText,
        excerpt: snippet(rawText, 260),
        keywords: keywordScore(rawText).map((item) => item.word),
        qualityScore: reportQuality(data)
      });
    }
  }
  if (await exists(inboundDir)) {
    const existingByWeekAndIdentity = new Set(reports.map((report) => {
      const member = (report.userId ? byId[report.userId] : null) || byName[report.slug];
      const userId = report.userId || (member?.user_id ? String(member.user_id) : "");
      const name = member?.name || report.name;
      return `${report.week}/${identityKeyFromParts(userId, name)}`;
    }));
    const inboundFiles = (await fs.readdir(inboundDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    for (const file of inboundFiles) {
      const parsed = parseInboundReportFileName(file);
      if (!parsed?.week || excludedWeeks.has(parsed.week) || !isSundayWeek(parsed.week)) continue;
      const canonicalName = nameAliases[parsed.originalName] || parsed.originalName;
      const member = byName[slugify(canonicalName)];
      if (!member || !isCountableMember(member)) continue;
      const userId = member.user_id ? String(member.user_id) : "";
      const identityKey = identityKeyFromParts(userId, member.name);
      if (existingByWeekAndIdentity.has(`${parsed.week}/${identityKey}`)) continue;
      const sourcePath = path.join(inboundDir, file);
      const rawText = await fs.readFile(sourcePath, "utf8");
      const stats = await fs.stat(sourcePath);
      reports.push({
        id: `${parsed.week}/${slugify(member.name)}`,
        week: parsed.week,
        name: member.name,
        slug: slugify(member.name),
        userId,
        createdAt: stats.birthtime.toISOString(),
        updatedAt: stats.mtime.toISOString(),
        submittedAt: stats.mtime.toISOString(),
        version: 1,
        rawText,
        excerpt: snippet(rawText, 260),
        keywords: keywordScore(rawText).map((item) => item.word),
        qualityScore: reportQuality({ raw_text: rawText }),
        sourceKind: "inbound-md",
        sourceName: parsed.originalName
      });
      existingByWeekAndIdentity.add(`${parsed.week}/${identityKey}`);
    }
  }
  return reports;
}

async function collectStates() {
  if (!(await exists(weeklyStateDir))) return {};
  const files = (await fs.readdir(weeklyStateDir)).filter((file) => file.endsWith(".json")).sort();
  const states = {};
  for (const file of files) {
    const week = path.basename(file, ".json");
    if (excludedWeeks.has(week) || !isSundayWeek(week)) continue;
    const state = await readJson(path.join(weeklyStateDir, file));
    states[week] = state;
  }
  return states;
}

async function main() {
  await fs.mkdir(dataDir, { recursive: true });
  const [states, registry, nameAliases] = await Promise.all([
    collectStates(),
    exists(registryPath).then((ok) => ok ? readJson(registryPath) : { members: [] }),
    exists(nameAliasesPath).then((ok) => ok ? readJson(nameAliasesPath) : {})
  ]);
  const reports = await collectReports(registry, nameAliases);
  const templateText = await exists(templatePath).then((ok) => ok ? fs.readFile(templatePath, "utf8") : "");

  const weeks = Object.keys({
    ...Object.fromEntries(reports.map((report) => [report.week, true])),
    ...Object.fromEntries(Object.keys(states).map((week) => [week, true]))
  }).sort();
  const latestWeek = weeks.at(-1);
  const roster = buildRoster(registry, reports, latestWeek);
  const visibleReports = reports.filter((report) => report.identityKey);
  const people = [...new Map(visibleReports.map((report) => [report.slug, report])).values()]
    .map((report) => {
      const personReports = visibleReports.filter((item) => item.slug === report.slug);
      return {
        name: report.name,
        slug: report.slug,
        userId: report.userId,
        count: personReports.length,
        weeks: personReports.map((item) => item.week).sort(),
        latestWeek: personReports.map((item) => item.week).sort().at(-1)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const weekSummaries = weeks.map((week) => {
    const weekReports = visibleReports.filter((report) => report.week === week);
    const stateStudents = states[week]?.students || {};
    const weekRoster = roster.filter((member) => member.activeFrom <= week);
    const reportsByIdentity = Object.fromEntries(weekReports.filter((report) => report.identityKey).map((report) => [report.identityKey, report]));
    const enrichedReports = weekReports.map((report) => {
      const weeklyState = report.userId ? stateStudents[report.userId] : null;
      report.submittedAt = weeklyState?.submitted_at || report.updatedAt || report.createdAt;
      return report;
    });
    const deadline = deadlineForWeek(week);
    const pastDeadline = Date.now() > parseTime(deadline);
    const submittedRoster = weekRoster
      .filter((member) => reportsByIdentity[member.key])
      .map((member) => ({
        userId: member.userId,
        name: member.name,
        status: "submitted"
      }));
    const submittedKeys = new Set(weekRoster.filter((member) => reportsByIdentity[member.key]).map((member) => member.key));
    const missing = weekRoster
      .filter((member) => !reportsByIdentity[member.key])
      .map((member) => ({
        userId: member.userId,
        name: member.name,
        status: "not_submitted"
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const late = enrichedReports
      .filter((report) => submittedKeys.has(report.identityKey) && isLate(report, deadline))
      .map((report) => ({
        userId: report.userId,
        name: report.name,
        submittedAt: report.submittedAt
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      week,
      deadline,
      submitted: submittedRoster.length,
      reportCount: enrichedReports.length,
      rosterSize: weekRoster.length,
      missingCount: missing.length,
      missing,
      pastDeadline,
      lateCount: late.length,
      late,
      analysis: analyzeWeek(week, enrichedReports, weekRoster, submittedRoster, missing, late, pastDeadline)
    };
  });

  const personAnalyses = Object.fromEntries(people.map((person) => [
    person.slug,
    analyzePerson(person.name, visibleReports.filter((report) => report.slug === person.slug))
  ]));

  const siteData = {
    generatedAt: new Date().toISOString(),
    source: {
      reportsDir,
      inboundDir,
      weeklyStateDir,
      registryPath,
      nameAliasesPath,
      templatePath
    },
    template: {
      generatedAt: new Date().toISOString(),
      text: templateText
    },
    excludedWeeks: [...excludedWeeks],
    reports: visibleReports,
    people,
    weeks: weekSummaries,
    personAnalyses
  };

  await fs.writeFile(path.join(dataDir, "site-data.json"), JSON.stringify(siteData));
  await fs.writeFile(path.join(dataDir, "weekly-report-template.md"), templateText, "utf8");
  await fs.writeFile(path.join(dataDir, "weekly-report-template.json"), JSON.stringify({
    generatedAt: siteData.generatedAt,
    source: templatePath,
    text: templateText
  }, null, 2), "utf8");
  console.log(`Generated ${reports.length} reports, ${people.length} people, ${weeks.length} weeks.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
