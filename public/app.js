const app = document.querySelector("#app");
const state = await fetch("data/site-data.json", { cache: "no-store" }).then((response) => response.json());
const analysisManifest = await fetch("data/analysis/manifest.json", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null);

const html = (strings, ...values) => strings.reduce((out, string, i) => out + string + (values[i] ?? ""), "");
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
const params = () => new URLSearchParams(location.hash.split("?")[1] || "");
const missingLabel = (week) => week?.pastDeadline ? "未交" : "待交";
const retiredLatePattern = /迟交|晚于(?:周一\s*)?08:00|晚于截止|超过截止|lateCount|lateNames|lateSubmissions/i;

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function reportSubmissionTime(report) {
  const value = report?.submittedAt || report?.updatedAt || report?.createdAt || "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function formatReportTimestamp(report) {
  const value = report?.submittedAt || report?.updatedAt || report?.createdAt || "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "未知";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date(time)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function sortReportsBySubmissionTime(reports) {
  return [...reports].sort((a, b) =>
    reportSubmissionTime(a) - reportSubmissionTime(b) ||
    String(a.name || "").localeCompare(String(b.name || ""))
  );
}

function valueScope(text) {
  const source = String(text || "");
  const match = source.search(/价值观总结|价值总结|估计价值|价值金额|值多少钱|为什么值这个钱|估值/i);
  if (match < 0) return "";
  return source.slice(match, match + 2600);
}

function normalizeMoneyAmount(amount, unit = "", currency = "") {
  const value = Number(String(amount || "").replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) return 0;
  const normalizedUnit = String(unit || "").trim().toLowerCase();
  const normalizedCurrency = String(currency || "").toLowerCase();
  let multiplier = 1;
  if (normalizedUnit.includes("亿")) multiplier = 100000000;
  else if (normalizedUnit.includes("千万")) multiplier = 10000000;
  else if (normalizedUnit.includes("百万")) multiplier = 1000000;
  else if (normalizedUnit.includes("万")) multiplier = 10000;
  else if (normalizedUnit.includes("千")) multiplier = 1000;
  else if (normalizedUnit === "b") multiplier = 1000000000;
  else if (normalizedUnit === "m") multiplier = 1000000;
  else if (normalizedUnit === "k") multiplier = 1000;
  const currencyMultiplier = /\$|usd|dollar/.test(normalizedCurrency) ? 7.2 : 1;
  return value * multiplier * currencyMultiplier;
}

function extractMoneyFromText(text) {
  let total = 0;
  let remaining = String(text || "");
  const rangePattern = /([¥￥$]?)\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:-|–|—|~|～|到|至)\s*(?:[¥￥$]?\s*)?(\d+(?:,\d{3})*(?:\.\d+)?)\s*(亿|千万|百万|万|千|元|块|人民币|rmb|usd)?/gi;
  remaining = remaining.replace(rangePattern, (full, currency, low, high, unit) => {
    if (!unit && !currency) return full;
    total += normalizeMoneyAmount((Number(low.replace(/,/g, "")) + Number(high.replace(/,/g, ""))) / 2, unit, currency);
    return " ";
  });
  const afterUnitPattern = /([¥￥$]?)\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(亿|千万|百万|万|千|元|块|人民币|rmb|usd)/gi;
  remaining = remaining.replace(afterUnitPattern, (full, currency, amount, unit) => {
    total += normalizeMoneyAmount(amount, unit, currency);
    return " ";
  });
  const beforeUnitPattern = /(人民币|rmb|usd|¥|￥|\$)\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(k|m|b)?/gi;
  remaining.replace(beforeUnitPattern, (full, currency, amount, unit) => {
    total += normalizeMoneyAmount(amount, unit, currency);
    return " ";
  });
  return total;
}

function extractMoneyValue(report) {
  const scope = valueScope(report?.rawText);
  if (!scope) return 0;
  const excluded = /终局|机会规模|市场规模|企业价值|估值|锚点|参考依据|防误读|交易额|买方|能力价值|占其|若做成|上限|Tricentis|Cursor|Cognition|GTCR/i;
  const preferred = /本周可归因价值|估计价值|价值金额|可归因价值|本周阶段贡献/i;
  const lines = scope.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const preferredLines = lines.filter((line) => preferred.test(line) && !excluded.test(line));
  const targetLines = preferredLines.length
    ? preferredLines
    : lines.filter((line) => /价值|金额|¥|￥|人民币|rmb|usd|\d+\s*(?:亿|千万|百万|万|千|元|块)/i.test(line) && !excluded.test(line));
  const total = targetLines.reduce((sum, line) => sum + extractMoneyFromText(line), 0);
  return Math.round(total);
}

function formatMoney(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return "无金额";
  if (amount >= 100000000) return `${(amount / 100000000).toFixed(amount >= 1000000000 ? 1 : 2).replace(/\.0+$/, "")} 亿`;
  if (amount >= 10000) return `${(amount / 10000).toFixed(amount >= 1000000 ? 1 : 0).replace(/\.0+$/, "")} 万`;
  return `${Math.round(amount)} 元`;
}

function reportsForWeek(week) {
  return state.reports.filter((report) => report.week === week);
}

function reportsForMonth(month) {
  return state.reports.filter((report) => report.week.startsWith(`${month}-`));
}

function personReportsUntil(person, week, windowSize = 4) {
  const weeks = person.weeks.filter((item) => item <= week).slice(-windowSize);
  return state.reports
    .filter((report) => report.slug === person.slug && weeks.includes(report.week))
    .sort((a, b) => a.week.localeCompare(b.week));
}

function personValueSeries(person, week, windowSize = 4) {
  return personReportsUntil(person, week, windowSize).map((report) => ({
    week: report.week,
    value: extractMoneyValue(report)
  }));
}

function weekValuePoints(week) {
  return reportsForWeek(week)
    .map((report) => ({ name: report.name, slug: report.slug, value: extractMoneyValue(report) }))
    .filter((item) => item.value > 0)
    .sort((a, b) => a.value - b.value);
}

function monthlyValueMetaPoints(month) {
  const byPerson = new Map();
  for (const report of reportsForMonth(month)) {
    const current = byPerson.get(report.slug) || { name: report.name, slug: report.slug, value: 0, scoreTotal: 0, scoreCount: 0 };
    current.value += extractMoneyValue(report);
    const score = Number(report.qualityScore ?? report.score);
    if (Number.isFinite(score)) {
      current.scoreTotal += score;
      current.scoreCount += 1;
    }
    byPerson.set(report.slug, current);
  }
  return [...byPerson.values()]
    .map((item) => ({
      ...item,
      metaScore: item.scoreCount ? item.scoreTotal / item.scoreCount : 0
    }))
    .filter((item) => item.value > 0 && item.metaScore > 0)
    .sort((a, b) => a.value - b.value);
}

function scaleValue(value, min, max, start, end) {
  if (!Number.isFinite(value)) return start;
  if (max <= min) return (start + end) / 2;
  return start + ((value - min) / (max - min)) * (end - start);
}

function valueLineChart(points, title = "价值曲线") {
  const valid = points.filter((point) => point.value > 0);
  if (!valid.length) {
    return `<section class="chart-panel"><div class="section-head"><h2>${esc(title)}</h2><p class="muted">这些周报里还没有可抽取的金额表达。</p></div></section>`;
  }
  const width = 720;
  const height = 240;
  const left = 56;
  const right = 24;
  const top = 24;
  const bottom = 50;
  const max = Math.max(...valid.map((point) => point.value));
  const all = points.map((point, index) => ({
    ...point,
    x: points.length <= 1 ? (left + width - right) / 2 : scaleValue(index, 0, points.length - 1, left, width - right),
    y: point.value > 0 ? scaleValue(point.value, 0, max, height - bottom, top) : height - bottom
  }));
  const path = all.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  return html`
    <section class="chart-panel">
      <div class="section-head">
        <h2>${esc(title)}</h2>
        <p class="muted">从周报价值部分抽取金额并按周合计；没有金额的周按 0 处理。</p>
      </div>
      <svg class="value-chart line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
        <line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" />
        <line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" />
        <text x="${left}" y="${top - 6}">${esc(formatMoney(max))}</text>
        <path d="${path}" />
        ${all.map((point) => `
          <g>
            <title>${esc(formatMoney(point.value))}</title>
            <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${point.value > 0 ? 5 : 3}" />
          </g>
        `).join("")}
      </svg>
      <div class="chart-foot">
        <span>最近 ${points.length} 周</span>
        <strong>${esc(formatMoney(points.reduce((sum, point) => sum + point.value, 0)))}</strong>
      </div>
    </section>
  `;
}

function weeklyValueDistributionChart(week) {
  const points = weekValuePoints(week);
  if (!points.length) {
    return `<section class="chart-panel"><div class="section-head"><h2>价值分布</h2><p class="muted">本周周报里还没有可抽取的金额表达。</p></div></section>`;
  }
  const width = 760;
  const height = 220;
  const left = 48;
  const right = 26;
  const baseline = 120;
  const max = Math.max(...points.map((point) => point.value));
  return html`
    <section class="chart-panel">
      <div class="section-head">
        <h2>价值分布</h2>
        <p class="muted">横轴是每份周报中项目金额合计；点位不标姓名，只看本周价值判断的分布趋势。</p>
      </div>
      <svg class="value-chart scatter-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(week)} 价值分布">
        <line x1="${left}" y1="${baseline}" x2="${width - right}" y2="${baseline}" />
        <text x="${left}" y="${baseline + 32}">0</text>
        <text x="${width - right}" y="${baseline + 32}" text-anchor="end">${esc(formatMoney(max))}</text>
        ${points.map((point, index) => {
          const x = scaleValue(point.value, 0, max, left, width - right);
          const y = baseline + Math.sin(index * 1.7) * 34;
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6"><title>${esc(formatMoney(point.value))}</title></circle>`;
        }).join("")}
      </svg>
      <div class="chart-foot">
        <span>${points.length} 份包含金额</span>
        <strong>最高 ${esc(formatMoney(max))}</strong>
      </div>
    </section>
  `;
}

function monthlyValueMetaScatter(month) {
  const points = monthlyValueMetaPoints(month);
  if (!points.length) {
    return `<section class="chart-panel"><div class="section-head"><h2>价值 × 元认知成长</h2><p class="muted">这个月还没有足够的金额和评分数据。</p></div></section>`;
  }
  const width = 760;
  const height = 300;
  const left = 58;
  const right = 28;
  const top = 28;
  const bottom = 54;
  const maxValue = Math.max(...points.map((point) => point.value));
  const minScore = 0;
  const maxScore = Math.max(1, ...points.map((point) => point.metaScore));
  return html`
    <section class="chart-panel">
      <div class="section-head">
        <h2>价值 × 元认知成长</h2>
        <p class="muted">横轴复用周报质量评分近似元认知成长，纵轴是本月金额合计；鼠标悬停可看姓名。</p>
      </div>
      <svg class="value-chart scatter-chart monthly-value-meta" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(month)} 价值和元认知成长散点图">
        <line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" />
        <line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" />
        <text x="${left}" y="${top - 8}">钱价值</text>
        <text x="${(left + width - right) / 2}" y="${height - 12}" text-anchor="middle">元认知成长</text>
        <text x="${left}" y="${height - 34}">0</text>
        <text x="${width - right}" y="${height - 34}" text-anchor="end">${esc(maxScore.toFixed(1))}</text>
        <text x="${left - 8}" y="${top + 4}" text-anchor="end">${esc(formatMoney(maxValue))}</text>
        ${points.map((point, index) => {
          const x = scaleValue(point.metaScore, minScore, maxScore, left, width - right);
          const y = scaleValue(point.value, 0, maxValue, height - bottom, top);
          const radius = 5 + Math.min(7, Math.sqrt(point.value / Math.max(maxValue, 1)) * 7);
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(1)}" data-slug="${esc(point.slug)}"><title>${esc(point.name)}：${esc(formatMoney(point.value))}；元认知 ${point.metaScore.toFixed(1)}</title></circle>`;
        }).join("")}
      </svg>
      <div class="chart-foot">
        <span>${points.length} 人有金额和评分</span>
        <strong>最高 ${esc(formatMoney(maxValue))}</strong>
      </div>
    </section>
  `;
}

function hasRetiredLateContent(value) {
  if (value == null) return false;
  if (typeof value === "string") return retiredLatePattern.test(value);
  if (Array.isArray(value)) return value.some(hasRetiredLateContent);
  if (typeof value === "object") {
    return Object.entries(value).some(([key, item]) => retiredLatePattern.test(key) || hasRetiredLateContent(item));
  }
  return false;
}

function scrubRetiredLateContent(value) {
  if (typeof value === "string") return hasRetiredLateContent(value) ? "" : value;
  if (Array.isArray(value)) return value.map(scrubRetiredLateContent).filter((item) => item !== "" && item != null);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => !retiredLatePattern.test(key) && !hasRetiredLateContent(item))
      .map(([key, item]) => [key, scrubRetiredLateContent(item)]));
  }
  return value;
}

function route() {
  const hash = location.hash || "#/";
  const [path] = hash.slice(1).split("?");
  if (path === "/weeks") return renderWeeks();
  if (path === "/week") return renderWeek(params().get("week"));
  if (path === "/briefings") return renderBriefings();
  if (path === "/briefing") return renderBriefing(params().get("week"));
  if (path === "/briefing-section") return renderBriefingSection(params().get("week"), params().get("section"));
  if (path === "/monthlies") return renderMonthlies();
  if (path === "/monthly") return renderMonthly(params().get("month"));
  if (path === "/monthly-section") return renderMonthlySection(params().get("month"), params().get("section"));
  if (path === "/person-analysis") return renderPersonAnalysisHub();
  if (path === "/person-horizontal") return renderPersonHorizontal(params().get("week"));
  if (path === "/person-horizontal-detail") return renderPersonHorizontalDetail(params().get("week"), params().get("slug"));
  if (path === "/person-longitudinal") return renderPersonLongitudinalHub(params().get("week"));
  if (path === "/person-longitudinal-detail") return renderPersonLongitudinalDetail(params().get("week"), params().get("slug"));
  if (path === "/people") return renderPeople();
  if (path === "/person") return renderPerson(params().get("slug"));
  if (path === "/teacher-unknown") return renderTeacherUnknown(params().get("week"));
  if (path === "/search") return renderSearch();
  if (path === "/template") return renderTemplate();
  return renderHome();
}

function latestWeek() {
  return [...state.weeks].sort((a, b) => a.week.localeCompare(b.week)).at(-1);
}

function latestAvailableBriefingWeek() {
  return briefingWeeks().at(-1)?.week || latestWeek().week;
}

function md(text) {
  const blocks = esc(text || "").split(/\n{2,}/);
  return blocks.map((block) => {
    const line = block.trim();
    if (!line) return "";
    if (line.startsWith("### ")) return `<h3>${line.slice(4)}</h3>`;
    if (line.startsWith("## ")) return `<h2>${line.slice(3)}</h2>`;
    if (line.startsWith("# ")) return `<h1>${line.slice(2)}</h1>`;
    if (/^[-*•]\s/m.test(line)) {
      const items = line.split(/\n/).map((item) => item.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
      return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
    }
    return `<p>${line.replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

function reportCard(report, meta = "", options = {}) {
  const collapsed = options.collapsed === true;
  const submittedLabel = formatReportTimestamp(report);
  return html`
    <article class="report ${collapsed ? "collapsed" : ""}" id="${esc(report.id)}" data-report-id="${esc(report.id)}">
      <div class="report-header">
        <div>
          <h3>
            ${collapsed ? `<button class="twisty" data-report-toggle="${esc(report.id)}" aria-label="展开 ${esc(report.name)}">▸</button>` : ""}
            ${esc(report.name)}
          </h3>
          <div class="report-meta muted">
            <span>${esc(report.week)}</span>
            <span>提交时间：${esc(submittedLabel)}</span>
            ${meta}
          </div>
          ${collapsed ? `<p class="excerpt">${esc(report.excerpt)}</p>` : ""}
        </div>
        <a class="button" href="#/person?slug=${encodeURIComponent(report.slug)}">看这个人</a>
      </div>
      <div class="report-body markdown">${md(report.rawText)}</div>
    </article>
  `;
}

function renderHome() {
  const latest = latestWeek();
  const totalReports = state.reports.length;
  app.innerHTML = html`
    <section class="hero">
      <div>
        <h1>周报总览</h1>
        <p class="muted">上次生成：${esc(new Date(state.generatedAt).toLocaleString())}</p>
      </div>
      <div class="toolbar">
        <a class="button" href="#/week?week=${encodeURIComponent(latest.week)}">打开最新周</a>
        <a class="button" href="#/briefing?week=${encodeURIComponent(latestAvailableBriefingWeek())}">横向分析</a>
        <a class="button" href="#/monthlies">月度分析</a>
        <a class="button" href="#/person-analysis">个人分析</a>
        <a class="button" href="#/teacher-unknown">老师不知道</a>
        <a class="button" href="#/search">全文搜索</a>
      </div>
    </section>
    <section class="stats">
      <div class="stat"><strong>${state.weeks.length}</strong><span>周次</span></div>
      <div class="stat"><strong>${state.people.length}</strong><span>人员</span></div>
      <div class="stat"><strong>${totalReports}</strong><span>周报原件</span></div>
      <div class="stat"><strong>${latest.missingCount}</strong><span>最新周${missingLabel(latest)}</span></div>
    </section>
    <section class="panel" style="margin-top:16px">
      <h2>最新周状态</h2>
      <p>${esc(latest.analysis.summary)}</p>
      <div class="toolbar">
        <span class="badge ok">已交 ${latest.submitted} / 应交 ${latest.rosterSize}</span>
        <span class="badge">原件 ${latest.reportCount || latest.submitted}</span>
        <span class="badge danger">${missingLabel(latest)} ${latest.missingCount}</span>
      </div>
      <p class="muted">截止时间：${esc(latest.deadline)}。应交名单来自 registry.json 的 active + bound 成员。</p>
      ${latest.missing.length ? `<p class="muted">${missingLabel(latest)}：${latest.missing.map((item) => esc(item.name)).join("、")}</p>` : `<p class="muted">最新周没有${missingLabel(latest)}记录。</p>`}
    </section>
    <section class="cards" style="margin-top:16px">
      ${state.weeks.slice().reverse().map((week) => `
        <a class="card" href="#/week?week=${encodeURIComponent(week.week)}">
          <strong>${esc(week.week)}</strong>
          <span class="muted">已交 ${week.submitted} / 应交 ${week.rosterSize}，原件 ${week.reportCount || week.submitted}</span>
          <span class="${week.missingCount ? "badge danger" : "badge ok"}">${week.missingCount ? `${missingLabel(week)} ${week.missingCount}` : "全部提交"}</span>
        </a>
      `).join("")}
    </section>
  `;
}

function teacherUnknownWeeks() {
  const weeks = state.teacherUnknown?.weeks || [];
  return weeks.slice().sort((a, b) => a.week.localeCompare(b.week));
}

function latestTeacherUnknownWeek() {
  const weeks = teacherUnknownWeeks();
  return weeks.filter((week) => week.count > 0).at(-1) || weeks.at(-1);
}

function renderTeacherUnknown(weekId) {
  const weeks = teacherUnknownWeeks();
  const selected = weeks.find((week) => week.week === weekId) || latestTeacherUnknownWeek();
  if (!selected) {
    app.innerHTML = html`
      <section class="hero">
        <div>
          <h1>老师不知道</h1>
          <p class="muted">还没有从周报里抽到条目。</p>
        </div>
      </section>
    `;
    return;
  }
  app.innerHTML = html`
    <section class="hero">
      <div>
        <h1>老师不知道</h1>
        <p class="muted">从 ${esc(state.teacherUnknown.startWeek)} 开始，直接抽取周报模板里标明为“是”的原文条目。</p>
      </div>
      <div class="week-controls teacher-week-controls">
        <button data-teacher-week-step="-1" title="上一周">‹</button>
        <select data-teacher-week-select>
          ${weeks.slice().reverse().map((week) => `<option value="${esc(week.week)}" ${week.week === selected.week ? "selected" : ""}>${esc(week.week)} · ${week.count}</option>`).join("")}
        </select>
        <button data-teacher-week-step="1" title="下一周">›</button>
      </div>
    </section>
    <section class="panel teacher-summary">
      <div>
        <h2>${esc(selected.week)}</h2>
        <p class="muted">${selected.count ? `共 ${selected.count} 条，来自 ${selected.peopleCount} 个人` : "本周还没有人写“老师不知道”的条目。"}</p>
      </div>
      <a class="button" href="#/week?week=${encodeURIComponent(selected.week)}">打开本周周报</a>
    </section>
    <section class="teacher-grid">
      ${selected.items.map((item) => teacherUnknownCard(item)).join("")}
    </section>
  `;
  bindTeacherUnknownPicker();
}

function teacherUnknownCard(item) {
  const detailRows = [
    item.why ? ["为什么不知道", item.why] : null,
    item.gap ? ["信息差", item.gap] : null,
    item.insight ? ["新增认知", item.insight] : null,
    item.evidence ? ["证据等级", item.evidence] : null
  ].filter(Boolean);
  return html`
    <article class="teacher-card">
      <div class="teacher-card-head">
        <div>
          <a class="teacher-name" href="#/person?slug=${encodeURIComponent(item.slug)}">${esc(item.name)}</a>
          <div class="muted">${esc(item.week)} · ${esc(item.title)}</div>
        </div>
        <a class="button" href="#/week?week=${encodeURIComponent(item.week)}#${encodeURIComponent(item.reportId)}">原文</a>
      </div>
      <p class="teacher-content">${esc(item.content || item.text)}</p>
      ${detailRows.length ? `<dl class="teacher-details">${detailRows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("")}</dl>` : ""}
      <details>
        <summary>展开原文块</summary>
        <pre class="teacher-raw">${esc(item.text)}</pre>
      </details>
    </article>
  `;
}

function bindTeacherUnknownPicker() {
  const select = document.querySelector("[data-teacher-week-select]");
  if (!select) return;
  const weeks = teacherUnknownWeeks().map((week) => week.week).reverse();
  const go = () => {
    location.hash = `#/teacher-unknown?week=${encodeURIComponent(select.value)}`;
  };
  select.addEventListener("change", go);
  document.querySelectorAll("[data-teacher-week-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = weeks.indexOf(select.value);
      const next = Math.max(0, Math.min(weeks.length - 1, current + Number(button.dataset.teacherWeekStep)));
      select.value = weeks[next];
      go();
    });
  });
}

function renderWeeks() {
  app.innerHTML = html`
    <h1>周视图</h1>
    <p class="muted">每一周页面都以原件阅读为主，顶部显示提交/未交状态，分析按钮按需展开。</p>
    <div class="list">
      ${state.weeks.slice().reverse().map((week) => `
        <a class="row" href="#/week?week=${encodeURIComponent(week.week)}">
          <strong>${esc(week.week)}</strong>
          <span>已交 ${week.submitted} / 应交 ${week.rosterSize}，原件 ${week.reportCount || week.submitted}</span>
          <span class="${week.missingCount ? "badge danger" : "badge ok"}">${week.missingCount ? `${missingLabel(week)} ${week.missingCount}` : "全部提交"}</span>
        </a>
      `).join("")}
    </div>
  `;
}

function briefingWeeks() {
  return state.weeks
    .filter((week) => analysisManifest?.items?.[briefingKey(week.week)])
    .slice()
    .sort((a, b) => a.week.localeCompare(b.week));
}

function briefingKey(week) {
  return `week:${week}:briefing`;
}

function monthlyKey(month) {
  return `month:${month}:horizontal`;
}

function monthlyMonths() {
  const items = analysisManifest?.items || {};
  const months = Object.keys(items)
    .map((key) => key.match(/^month:(\d{4}-\d{2}):horizontal$/)?.[1])
    .filter(Boolean);
  return [...new Set(months)].sort().map((month) => ({
    month,
    weeks: state.weeks.filter((week) => week.week.startsWith(`${month}-`))
  }));
}

async function loadMonthly(month) {
  const key = monthlyKey(month);
  const file = analysisManifest?.items?.[key]?.file || `data/analysis/months/${month}.json`;
  const response = await fetch(file, { cache: "no-store" });
  if (!response.ok) throw new Error(`missing monthly analysis ${month}`);
  return response.json();
}

async function loadBriefing(week) {
  const key = briefingKey(week);
  const file = analysisManifest?.items?.[key]?.file || `data/analysis/briefings/${week}.json`;
  const response = await fetch(file, { cache: "no-store" });
  if (!response.ok) throw new Error(`missing briefing ${week}`);
  return response.json();
}

const briefingSectionMeta = {
  "key-progress": { title: "关键进展", field: "keyProgress" },
  "teacher-unknown": { title: "老师不知道", field: "teacherUnknown" },
  risks: { title: "风险与阻塞", field: "risks" },
  "follow-ups": { title: "下周追问", field: "followUps" },
  assets: { title: "可沉淀资产", field: "assets" },
  "people-to-read": { title: "值得细读的人", field: "peopleToRead" }
};

const monthlySectionMeta = {
  "relationship-map": { title: "人际关联图", field: "relationshipMap" },
  "pairwise-comparison": { title: "人物横向对比", field: "pairwiseComparison" },
  "shared-projects": { title: "共同项目", field: "sharedProjects" },
  "role-differences": { title: "角色互补", field: "roleDifferences" },
  "merge-opportunities": { title: "合并与协作机会", field: "mergeOpportunities" },
  "gaps-overlaps": { title: "重复与断点", field: "gapsOverlaps" },
  "teacher-actions": { title: "老师动作", field: "teacherActions" }
};

function renderMonthlies() {
  const months = monthlyMonths().reverse();
  app.innerHTML = html`
    <section class="hero">
      <div>
        <h1>月度分析</h1>
        <p class="muted">按周次所属月份聚合全体周报，做跨周、跨人的横向阅读。</p>
      </div>
    </section>
    <section class="cards">
      ${months.map((month) => `
        <a class="card" href="#/monthly?month=${encodeURIComponent(month.month)}">
          <strong>${esc(month.month)}</strong>
          <span class="muted">${month.weeks.length} 个周次，${state.reports.filter((report) => report.week.startsWith(`${month.month}-`)).length} 份周报</span>
          <span class="badge">月度横向</span>
        </a>
      `).join("") || `<div class="panel"><p class="muted">还没有生成月度分析。</p></div>`}
    </section>
  `;
}

async function renderMonthly(monthId) {
  const month = monthlyMonths().find((item) => item.month === monthId) || monthlyMonths().at(-1);
  if (!month) {
    app.innerHTML = `<section class="panel"><h1>月度分析</h1><p class="muted">还没有生成月度分析。</p></section>`;
    return;
  }
  app.innerHTML = `<section class="panel"><h1>${esc(month.month)} 月度分析</h1><p class="muted">正在加载离线分析...</p></section>`;
  try {
    const payload = await loadMonthly(month.month);
    const result = payload.result || {};
    const cards = normalizedMonthlyCards(result);
    app.innerHTML = html`
      <section class="hero">
        <div>
          <h1>${esc(month.month)} 月度分析</h1>
          <p class="muted">${esc(result.headline || "这个月的横向摘要还没有完整标题。")}</p>
        </div>
        <div class="toolbar">
          ${monthlyControls(month.month, "monthly")}
          <a class="button" href="#/monthlies">全部月度分析</a>
        </div>
      </section>
      <section class="briefing-summary">
        ${asArray(result.executiveSummary).filter((item) => !hasRetiredLateContent(item)).map((item) => `<div class="briefing-point">${esc(item)}</div>`).join("")}
      </section>
      ${monthlyValueMetaScatter(month.month)}
      <section class="briefing-card-grid">
        ${cards.map((card) => `
          <a class="briefing-card" href="#/monthly-section?month=${encodeURIComponent(month.month)}&section=${encodeURIComponent(card.id)}">
            <span class="badge">${esc(monthlySectionItems(result, card.id).length)} 条</span>
            <strong>${esc(card.title || monthlySectionMeta[card.id]?.title || card.id)}</strong>
            <span class="muted">${esc(card.oneLine || "")}</span>
          </a>
        `).join("")}
      </section>
      <section class="panel" style="margin-top:16px">
        <h2>下月追问</h2>
        <div class="list">
          ${asArray(result.closingAdvice).map((item) => `<div class="row"><strong>建议</strong><span>${esc(item)}</span><span></span></div>`).join("")}
        </div>
      </section>
    `;
    bindMonthlyPicker();
  } catch {
    app.innerHTML = `<section class="panel"><h1>${esc(month.month)} 月度分析</h1><p class="muted">这个月的月度分析还没有生成。</p></section>`;
  }
}

async function renderMonthlySection(monthId, sectionId) {
  const month = monthlyMonths().find((item) => item.month === monthId) || monthlyMonths().at(-1);
  const meta = monthlySectionMeta[sectionId] || monthlySectionMeta["monthly-signals"];
  if (!month) {
    app.innerHTML = `<section class="panel"><h1>${esc(meta.title)}</h1><p class="muted">还没有生成月度分析。</p></section>`;
    return;
  }
  app.innerHTML = `<section class="panel"><h1>${esc(meta.title)}</h1><p class="muted">正在加载...</p></section>`;
  try {
    const payload = await loadMonthly(month.month);
    const result = payload.result || {};
    const items = monthlySectionItems(result, sectionId);
    app.innerHTML = html`
      <section class="hero">
        <div>
          <h1>${esc(meta.title)}</h1>
          <p class="muted">${esc(month.month)} · ${items.length} 条 · ${esc(result.headline || "")}</p>
        </div>
        <div class="toolbar">
          ${monthlyControls(month.month, "monthly-section", sectionId)}
          <a class="button" href="#/monthly?month=${encodeURIComponent(month.month)}">返回月度分析</a>
        </div>
      </section>
      <section class="briefing-section-list">
        ${items.length ? items.map((item) => briefingSectionItem(item)).join("") : `<div class="panel"><p class="muted">这个分区暂无条目。</p></div>`}
      </section>
    `;
    bindMonthlyPicker();
  } catch {
    app.innerHTML = `<section class="panel"><h1>${esc(meta.title)}</h1><p class="muted">月度分析文件还没有生成。</p></section>`;
  }
}

function monthlyControls(currentMonth, target, sectionId = "") {
  const months = monthlyMonths();
  const index = Math.max(0, months.findIndex((item) => item.month === currentMonth));
  const previous = months[Math.max(0, index - 1)]?.month || currentMonth;
  const next = months[Math.min(months.length - 1, index + 1)]?.month || currentMonth;
  const hrefFor = (month) => target === "monthly-section"
    ? `#/monthly-section?month=${encodeURIComponent(month)}&section=${encodeURIComponent(sectionId)}`
    : `#/monthly?month=${encodeURIComponent(month)}`;
  return `
    <span class="week-controls inline-week-controls">
      <a class="button" href="${hrefFor(previous)}" title="上个月">‹</a>
      <select data-monthly-select data-monthly-target="${esc(target)}" data-monthly-section="${esc(sectionId)}">
        ${months.slice().reverse().map((item) => `<option value="${esc(item.month)}" ${item.month === currentMonth ? "selected" : ""}>${esc(item.month)}</option>`).join("")}
      </select>
      <a class="button" href="${hrefFor(next)}" title="下个月">›</a>
    </span>
  `;
}

function bindMonthlyPicker() {
  document.querySelectorAll("[data-monthly-select]").forEach((select) => {
    select.addEventListener("change", () => {
      const target = select.dataset.monthlyTarget;
      const section = select.dataset.monthlySection || "";
      location.hash = target === "monthly-section"
        ? `#/monthly-section?month=${encodeURIComponent(select.value)}&section=${encodeURIComponent(section)}`
        : `#/monthly?month=${encodeURIComponent(select.value)}`;
    });
  });
}

function monthlySectionItems(result, id) {
  const meta = monthlySectionMeta[id];
  const value = meta ? result.sections?.[meta.field] : null;
  const items = Array.isArray(value) ? value : (value ? [value] : []);
  return items.filter((item) => !hasRetiredLateContent(item));
}

function defaultMonthlyCards(result) {
  return Object.entries(monthlySectionMeta).map(([id, meta]) => ({
    id,
    title: meta.title,
    oneLine: "",
    count: (result.sections?.[meta.field] || []).length
  }));
}

function normalizedMonthlyCards(result) {
  const aliases = {
    signals: "monthly-signals",
    people: "people-to-read",
    themes: "project-themes",
    actions: "teacher-actions",
    monthlySignals: "relationship-map",
    peopleToRead: "pairwise-comparison",
    projectThemes: "shared-projects",
    collaboration: "merge-opportunities",
    risks: "gaps-overlaps",
    assets: "role-differences",
    relationship: "relationship-map",
    comparisons: "pairwise-comparison",
    shared: "shared-projects",
    roles: "role-differences",
    merge: "merge-opportunities",
    gaps: "gaps-overlaps"
  };
  const byId = Object.fromEntries((result.sectionCards || []).map((card) => [aliases[card.id] || card.id, card]));
  return defaultMonthlyCards(result).map((card) => ({
    ...card,
    title: byId[card.id]?.title || card.title,
    oneLine: byId[card.id]?.oneLine || card.oneLine
  }));
}

function renderBriefings() {
  const weeks = briefingWeeks().reverse();
  app.innerHTML = html`
    <section class="hero">
      <div>
        <h1>横向分析</h1>
        <p class="muted">每周截止后生成；每个分区都有独立页面，方便快速读。</p>
      </div>
    </section>
    <section class="cards">
      ${weeks.map((week) => `
        <a class="card" href="#/briefing?week=${encodeURIComponent(week.week)}">
          <strong>${esc(week.week)}</strong>
          <span class="muted">已交 ${week.submitted} / 应交 ${week.rosterSize}，原件 ${week.reportCount || week.submitted}</span>
          <span class="badge">横向分析</span>
        </a>
      `).join("")}
    </section>
  `;
}

async function renderBriefing(weekId) {
  const week = briefingWeeks().find((item) => item.week === weekId) || briefingWeeks().at(-1) || latestWeek();
  app.innerHTML = `<section class="panel"><h1>${esc(week.week)} 横向分析</h1><p class="muted">正在加载离线分析...</p></section>`;
  try {
    const payload = await loadBriefing(week.week);
    const result = payload.result || {};
    const cards = Array.isArray(result.sectionCards) ? result.sectionCards : defaultBriefingCards(result);
    app.innerHTML = html`
      <section class="hero">
        <div>
          <h1>${esc(week.week)} 横向分析</h1>
          <p class="muted">${esc(result.headline || "这一周摘要还没有生成完整标题。")}</p>
        </div>
        <div class="toolbar">
          ${briefingWeekControls(week.week, "briefing")}
          <a class="button" href="#/week?week=${encodeURIComponent(week.week)}">本周原文</a>
          <a class="button" href="#/briefings">全部横向分析</a>
        </div>
      </section>
      <section class="briefing-summary">
        ${asArray(result.executiveSummary).filter((item) => !hasRetiredLateContent(item)).map((item) => `<div class="briefing-point">${esc(item)}</div>`).join("")}
      </section>
      ${weeklyValueDistributionChart(week.week)}
      <section class="briefing-card-grid">
        ${cards.map((card) => `
          <a class="briefing-card" href="#/briefing-section?week=${encodeURIComponent(week.week)}&section=${encodeURIComponent(card.id)}">
            <span class="badge">${esc(briefingSectionCount(result, card.id))} 条</span>
            <strong>${esc(card.title || briefingSectionMeta[card.id]?.title || card.id)}</strong>
            <span class="muted">${esc(hasRetiredLateContent(card.oneLine) ? "" : (card.oneLine || ""))}</span>
          </a>
        `).join("")}
      </section>
      <section class="panel" style="margin-top:16px">
        <h2>下一步追问</h2>
        <div class="list">
          ${asArray(result.closingAdvice).filter((item) => !hasRetiredLateContent(item)).map((item) => `<div class="row"><strong>建议</strong><span>${esc(item)}</span><span></span></div>`).join("")}
        </div>
      </section>
    `;
    bindBriefingWeekPicker();
  } catch (error) {
    console.error("Failed to render briefing", error);
    app.innerHTML = html`
      <section class="panel">
        <h1>${esc(week.week)} 横向分析</h1>
        <p class="muted">这一周的横向分析还没有生成。它会在周一 08:00 截止后由同步任务生成。</p>
      </section>
    `;
  }
}

async function renderBriefingSection(weekId, sectionId) {
  const week = briefingWeeks().find((item) => item.week === weekId) || briefingWeeks().at(-1) || latestWeek();
  const meta = briefingSectionMeta[sectionId] || briefingSectionMeta["key-progress"];
  app.innerHTML = `<section class="panel"><h1>${esc(meta.title)}</h1><p class="muted">正在加载...</p></section>`;
  try {
    const payload = await loadBriefing(week.week);
    const result = payload.result || {};
    const items = sectionItems(result, sectionId);
    app.innerHTML = html`
      <section class="hero">
        <div>
          <h1>${esc(meta.title)}</h1>
          <p class="muted">${esc(week.week)} · ${esc(briefingSectionCount(result, sectionId))} 条 · ${esc(result.headline || "")}</p>
        </div>
        <div class="toolbar">
          ${briefingWeekControls(week.week, "briefing-section", sectionId)}
          <a class="button" href="#/briefing?week=${encodeURIComponent(week.week)}">返回横向分析</a>
          <a class="button" href="#/week?week=${encodeURIComponent(week.week)}">本周原文</a>
        </div>
      </section>
      <section class="briefing-section-list">
        ${items.length ? items.map((item) => briefingSectionItem(item)).join("") : `<div class="panel"><p class="muted">这个分区暂无条目。</p></div>`}
      </section>
    `;
    bindBriefingWeekPicker();
  } catch {
    app.innerHTML = `<section class="panel"><h1>${esc(meta.title)}</h1><p class="muted">横向分析文件还没有生成。</p></section>`;
  }
}

function briefingWeekControls(currentWeek, target, sectionId = "") {
  const weeks = briefingWeeks();
  const index = Math.max(0, weeks.findIndex((week) => week.week === currentWeek));
  const previous = weeks[Math.max(0, index - 1)]?.week || currentWeek;
  const next = weeks[Math.min(weeks.length - 1, index + 1)]?.week || currentWeek;
  const hrefFor = (week) => target === "briefing-section"
    ? `#/briefing-section?week=${encodeURIComponent(week)}&section=${encodeURIComponent(sectionId)}`
    : `#/briefing?week=${encodeURIComponent(week)}`;
  return `
    <span class="week-controls inline-week-controls">
      <a class="button" href="${hrefFor(previous)}" title="上一周">‹</a>
      <select data-briefing-week-select data-briefing-target="${esc(target)}" data-briefing-section="${esc(sectionId)}">
        ${weeks.slice().reverse().map((week) => `<option value="${esc(week.week)}" ${week.week === currentWeek ? "selected" : ""}>${esc(week.week)}</option>`).join("")}
      </select>
      <a class="button" href="${hrefFor(next)}" title="下一周">›</a>
    </span>
  `;
}

function bindBriefingWeekPicker() {
  document.querySelectorAll("[data-briefing-week-select]").forEach((select) => {
    select.addEventListener("change", () => {
      const target = select.dataset.briefingTarget;
      const section = select.dataset.briefingSection || "";
      location.hash = target === "briefing-section"
        ? `#/briefing-section?week=${encodeURIComponent(select.value)}&section=${encodeURIComponent(section)}`
        : `#/briefing?week=${encodeURIComponent(select.value)}`;
    });
  });
}

function sectionItems(result, id) {
  const meta = briefingSectionMeta[id];
  const sections = result.sections;
  let value = meta && !Array.isArray(sections) ? sections?.[meta.field] : null;

  if (Array.isArray(sections)) {
    const cards = Array.isArray(result.sectionCards) ? result.sectionCards : [];
    const cardIndex = cards.findIndex((card) => card.id === id);
    const cardTitle = cards[cardIndex]?.title;
    const metaIndex = Object.keys(briefingSectionMeta).indexOf(id);
    value = sections.find((section) => section?.id === id)
      || sections.find((section) => cardTitle && section?.title === cardTitle)
      || sections[cardIndex >= 0 ? cardIndex : metaIndex];
  }

  const items = Array.isArray(value) ? value : (value ? [value] : []);
  return items.filter((item) => !hasRetiredLateContent(item));
}

function briefingSectionCount(result, id) {
  const card = Array.isArray(result.sectionCards)
    ? result.sectionCards.find((item) => item.id === id)
    : null;
  const count = Number(card?.count);
  return Number.isFinite(count) && count >= 0 ? count : sectionItems(result, id).length;
}

function defaultBriefingCards(result) {
  return Object.entries(briefingSectionMeta).map(([id, meta]) => ({
    id,
    title: meta.title,
    oneLine: "",
    count: (result.sections?.[meta.field] || []).length
  }));
}

function briefingSectionItem(item) {
  const people = Array.isArray(item.people) ? item.people.join("、") : (item.people || "");
  const evidence = asArray(item.evidence).filter(Boolean);
  return html`
    <article class="briefing-section-item">
      <div class="briefing-section-head">
        <strong>${esc(item.title || "未命名条目")}</strong>
        ${people ? `<span class="badge">${esc(people)}</span>` : ""}
      </div>
      <p>${esc(item.whyItMatters || evidence[0] || "")}</p>
      ${evidence.length ? `
        <div class="muted">
          <strong>证据：</strong>
          <ul>${evidence.map((entry) => `<li>${esc(entry)}</li>`).join("")}</ul>
        </div>
      ` : ""}
      ${item.action ? `<p class="muted"><strong>动作：</strong>${esc(item.action)}</p>` : ""}
    </article>
  `;
}

function renderWeek(weekId) {
  const week = state.weeks.find((item) => item.week === weekId) || latestWeek();
  const reports = sortReportsBySubmissionTime(state.reports.filter((report) => report.week === week.week));
  app.innerHTML = html`
    <section class="hero">
      <div>
        <h1>${esc(week.week)} 横向阅读</h1>
        <p class="muted">这一页重点是展开看每个人本周原件；分析只在你需要时打开。</p>
      </div>
      <div class="toolbar">
        <span class="badge ok">已交 ${week.submitted} / 应交 ${week.rosterSize}</span>
        <span class="badge">原件 ${week.reportCount || week.submitted}</span>
        <span class="badge danger">${missingLabel(week)} ${week.missingCount}</span>
        <a class="button" href="#/briefing?week=${encodeURIComponent(week.week)}">横向分析</a>
        <button data-analysis="week:${week.week}:horizontal" data-target="week-analysis">横向分析</button>
      </div>
    </section>
    <section class="analysis" id="week-analysis">${fallbackWeekAnalysis(week)}</section>
    <section class="split">
      <aside class="side panel">
        <h2>提交状态</h2>
        <p><span class="badge ok">已交 ${week.submitted} / 应交 ${week.rosterSize}</span></p>
        <p><span class="badge">原件 ${week.reportCount || week.submitted}</span></p>
        <p><span class="badge danger">${missingLabel(week)} ${week.missingCount}</span></p>
        <p class="muted">截止：${esc(week.deadline)}</p>
        <h3>已交</h3>
        <div class="name-list">
          ${reports.map((report) => `
            <button class="name-jump" data-jump-report="${esc(report.id)}">
              <span>${esc(report.name)}</span>
              <small>提交时间：${esc(formatReportTimestamp(report))}</small>
            </button>
          `).join("")}
        </div>
        <h3>${missingLabel(week)}</h3>
        ${week.missing.length ? `<div class="name-list muted">${week.missing.map((item) => `<span>${esc(item.name)}</span>`).join("")}</div>` : `<p class="muted">没有${missingLabel(week)}记录。</p>`}
      </aside>
      <div class="grid">
        ${reports.map((report) => reportCard(report, "", { collapsed: true })).join("")}
      </div>
    </section>
  `;
  bindToggles();
  bindReportToggles();
  bindReportJumps();
}

function renderPeople() {
  app.innerHTML = html`
    <h1>个人视图</h1>
    <p class="muted">进入某个人页面后，可以按周纵向读原件，并点按钮查看价值观/研究判断变化。</p>
    <div class="cards">
      ${state.people.map((person) => `
        <a class="card" href="#/person?slug=${encodeURIComponent(person.slug)}">
          <strong>${esc(person.name)}</strong>
          <span class="muted">${person.count} 份周报</span>
          <span class="badge">最新 ${esc(person.latestWeek || "无")}</span>
        </a>
      `).join("")}
    </div>
  `;
}

function personHorizontalKey(person, week) {
  return `person:${person.slug}:${week}:horizontal`;
}

function personHorizontalWeeks() {
  const keys = Object.keys(analysisManifest?.items || {});
  return state.weeks
    .filter((week) => keys.some((key) => key.endsWith(`:${week.week}:horizontal`)))
    .slice()
    .sort((a, b) => a.week.localeCompare(b.week));
}

function renderPersonAnalysisHub() {
  const horizontalWeek = personHorizontalWeeks().at(-1)?.week || latestWeek().week;
  app.innerHTML = html`
    <section class="hero">
      <div>
        <h1>个人分析</h1>
        <p class="muted">把“这个人自己有没有进步”和“这个人本周相对同伴有什么独特信号”分开看。</p>
      </div>
    </section>
    <section class="briefing-card-grid person-analysis-menu">
      <a class="briefing-card feature" href="#/person-horizontal?week=${encodeURIComponent(horizontalWeek)}">
        <span class="badge">同周定位</span>
        <strong>个人横向</strong>
        <span class="muted">按周查看每个人相对同周提交者的正向画像，突出价值判断、项目管理和元认知。</span>
      </a>
      <a class="briefing-card feature" href="#/person-longitudinal">
        <span class="badge">跨周轨迹</span>
        <strong>个人纵向</strong>
        <span class="muted">按周查看每个人截至该周的 4 周纵向卡片，重点看元认知、价值观和项目管理。</span>
      </a>
    </section>
  `;
}

function personLongitudinalWeeks() {
  const keys = Object.keys(analysisManifest?.items || {});
  return state.weeks
    .filter((week) => keys.some((key) => key.endsWith(`:${week.week}:longitudinal`)))
    .slice()
    .sort((a, b) => a.week.localeCompare(b.week));
}

function personLongitudinalWeekControls(currentWeek) {
  const weeks = personLongitudinalWeeks();
  const index = Math.max(0, weeks.findIndex((week) => week.week === currentWeek));
  const previous = weeks[Math.max(0, index - 1)]?.week || currentWeek;
  const next = weeks[Math.min(weeks.length - 1, index + 1)]?.week || currentWeek;
  return `
    <span class="week-controls inline-week-controls">
      <a class="button" href="#/person-longitudinal?week=${encodeURIComponent(previous)}" title="上一周">‹</a>
      <select data-person-longitudinal-week-select>
        ${weeks.slice().reverse().map((week) => `<option value="${esc(week.week)}" ${week.week === currentWeek ? "selected" : ""}>${esc(week.week)}</option>`).join("")}
      </select>
      <a class="button" href="#/person-longitudinal?week=${encodeURIComponent(next)}" title="下一周">›</a>
    </span>
  `;
}

function bindPersonLongitudinalWeekPicker() {
  document.querySelectorAll("[data-person-longitudinal-week-select]").forEach((select) => {
    select.addEventListener("change", () => {
      location.hash = `#/person-longitudinal?week=${encodeURIComponent(select.value)}`;
    });
  });
}

function isStructuredLongitudinal(payload) {
  const result = payload?.result || {};
  return Boolean(result.metacognitionChange && result.valueGrowth && result.projectManagementReview);
}

async function renderPersonLongitudinalHub(weekId) {
  const weeks = personLongitudinalWeeks();
  const selectedWeek = weeks.find((item) => item.week === weekId) || weeks.at(-1);
  if (!selectedWeek) {
    app.innerHTML = html`
      <section class="hero">
        <div>
          <h1>个人纵向</h1>
          <p class="muted">还没有生成新版个人纵向分析。</p>
        </div>
        <a class="button" href="#/person-analysis">返回个人分析</a>
      </section>
    `;
    return;
  }
  app.innerHTML = `<section class="panel"><h1>${esc(selectedWeek.week)} 个人纵向</h1><p class="muted">正在加载个人纵向卡片...</p></section>`;
  const people = state.people.filter((person) => person.weeks.includes(selectedWeek.week));
  const payloads = await Promise.all(people.map(async (person) => ({
    person,
    payload: await loadAnalysisByKey(personLongitudinalKey(person, selectedWeek.week))
  })));
  const available = payloads.filter((item) => isStructuredLongitudinal(item.payload));
  app.innerHTML = html`
    <section class="hero">
      <div>
        <h1>${esc(selectedWeek.week)} 个人纵向</h1>
        <p class="muted">按周查看每个人截至该周的 4 周轨迹；只展示新版纵向分析结果。</p>
      </div>
      <div class="toolbar">
        ${personLongitudinalWeekControls(selectedWeek.week)}
        <a class="button" href="#/person-analysis">返回个人分析</a>
      </div>
    </section>
    <section class="stats">
      <div class="stat"><strong>${available.length}</strong><span>新版纵向</span></div>
      <div class="stat"><strong>${people.length}</strong><span>本周提交者</span></div>
      <div class="stat"><strong>${selectedWeek.submitted}</strong><span>已交</span></div>
      <div class="stat"><strong>${selectedWeek.reportCount || selectedWeek.submitted}</strong><span>原件</span></div>
    </section>
    <section class="person-horizontal-grid">
      ${available.length ? available.map(({ person, payload }) => personLongitudinalCard(person, selectedWeek.week, payload)).join("") : `<article class="panel"><p class="muted">这一周还没有新版个人纵向分析文件。</p></article>`}
    </section>
  `;
  bindPersonLongitudinalWeekPicker();
}

function personLongitudinalCard(person, week, payload) {
  const result = payload.result || {};
  const meta = result.metacognitionChange || {};
  const value = result.valueGrowth || {};
  const management = result.projectManagementReview || {};
  const overview = plainText(result.overviewSentence || result.headline || result.overallTrajectory || "已生成个人纵向分析");
  return html`
    <a class="person-horizontal-card longitudinal-summary-card" href="#/person-longitudinal-detail?week=${encodeURIComponent(week)}&slug=${encodeURIComponent(person.slug)}">
      <div class="person-horizontal-head">
        <div>
          <strong>${esc(person.name)}</strong>
          <span class="muted">${esc(week)} · 最近 4 周</span>
        </div>
        <span class="level-pill">纵向</span>
      </div>
      <p class="overview-line">${esc(overview)}</p>
      <div class="mini-dimensions">
        <span><strong>元认知：</strong>${esc(plainText(meta.summary || meta.currentLevel || ""))}</span>
        <span><strong>价值观：</strong>${esc(plainText(value.summary || value.currentValueFunction || ""))}</span>
        <span><strong>项目管理：</strong>${esc(plainText(management.summary || management.managementPattern || ""))}</span>
      </div>
      <div class="person-horizontal-foot">
        <span class="badge">查看纵向详情</span>
        <span class="muted">${esc(payload.model || "")}</span>
      </div>
    </a>
  `;
}

function personLongitudinalKey(person, week) {
  return `person:${person.slug}:${week}:longitudinal`;
}

async function renderPersonLongitudinalDetail(weekId, slugValue) {
  const person = state.people.find((item) => item.slug === slugValue) || state.people[0];
  const weeks = person.weeks.slice().reverse();
  const week = weekId || person.latestWeek || weeks[0];
  const payload = await loadAnalysisByKey(personLongitudinalKey(person, week));
  if (!payload || payload.result?.skipped) {
    app.innerHTML = html`
      <section class="panel">
        <h1>${esc(person.name)} 个人纵向</h1>
        <p class="muted">${esc(week)} 的个人纵向分析还没有生成。</p>
        <div class="toolbar">
          <a class="button" href="#/person-longitudinal?week=${encodeURIComponent(week)}">返回个人纵向</a>
          <a class="button" href="#/person?slug=${encodeURIComponent(person.slug)}">个人原文</a>
        </div>
      </section>
    `;
    return;
  }
  const result = payload.result || {};
  const meta = result.metacognitionChange || {};
  const value = result.valueGrowth || result.valueFunctionChange || {};
  const management = result.projectManagementReview || {};
  app.innerHTML = html`
    <section class="hero">
      <div>
        <h1>${esc(person.name)} · ${esc(week)} 个人纵向</h1>
        <p class="muted">${esc(plainText(result.headline || result.overviewSentence || "最近四周研究能力轨迹"))}</p>
      </div>
      <div class="toolbar">
        <span class="week-controls inline-week-controls">
          <button data-longitudinal-week-step="-1" title="上一周">‹</button>
          <select data-longitudinal-week-select>
            ${weeks.map((item) => `<option value="${esc(item)}" ${item === week ? "selected" : ""}>${esc(item)}</option>`).join("")}
          </select>
          <button data-longitudinal-week-step="1" title="下一周">›</button>
        </span>
        <a class="button" href="#/person?slug=${encodeURIComponent(person.slug)}">个人原文</a>
        <a class="button" href="#/person-longitudinal?week=${encodeURIComponent(week)}">返回列表</a>
      </div>
    </section>
    <section class="longitudinal-hero">
      <div>
        <span class="badge">四周轨迹</span>
        <h2>${esc(plainText(result.overviewSentence || result.overallTrajectory || ""))}</h2>
        <p>${esc(plainText(result.overallTrajectory || result.headline || ""))}</p>
      </div>
      <div class="teacher-box">
        <strong>老师下一次可以问</strong>
        ${analysisList(result.teacherQuestions || result.professorShouldAsk || [], "meeting-questions")}
      </div>
    </section>
    ${valueLineChart(personValueSeries(person, week, 4), "个人价值曲线")}
    <section class="focus-grid longitudinal-focus">
      ${longitudinalFocusCard("元认知变化", meta)}
      ${longitudinalFocusCard("价值观提升", value)}
      ${longitudinalFocusCard("项目管理质量", management)}
    </section>
    <section class="timeline-panel">
      <div class="section-head">
        <h2>四周时间线</h2>
        <p class="muted">每周分别看元认知、价值判断和项目管理。</p>
      </div>
      <div class="longitudinal-timeline">
        ${(result.fourWeekTimeline || result.stageByWeek || []).map((item) => longitudinalTimelineItem(item)).join("") || `<p class="muted">暂无时间线。</p>`}
      </div>
    </section>
    <section class="detail-grid">
      ${detailPanel("项目拆解", management.projects)}
      ${detailPanel("反复卡点", result.repeatedBlockers)}
      ${detailPanel("下一步干预", result.nextIntervention)}
      ${detailPanel("给学生的反馈", result.studentFeedback)}
      ${detailPanel("证据入口", result.evidenceLinks)}
    </section>
  `;
  bindLongitudinalWeekPicker(person, weeks);
}

function longitudinalFocusCard(title, value = {}) {
  return html`
    <article class="focus-card longitudinal-card">
      <span class="badge">${esc(title)}</span>
      <h3>${esc(plainText(value.summary || value.currentLevel || value.currentValueFunction || value.managementPattern || ""))}</h3>
      ${value.strongestSignal ? `<p><strong>最强信号：</strong>${esc(plainText(value.strongestSignal))}</p>` : ""}
      ${value.improvementSignals ? `<p><strong>提升信号：</strong>${esc(plainText(value.improvementSignals))}</p>` : ""}
      ${value.nextLift || value.nextValueQuestion || value.nextManagementMove ? `<p class="muted"><strong>下一步：</strong>${esc(plainText(value.nextLift || value.nextValueQuestion || value.nextManagementMove))}</p>` : ""}
    </article>
  `;
}

function longitudinalTimelineItem(item = {}) {
  return html`
    <article class="timeline-item">
      <strong>${esc(item.week || item.date || "周次")}</strong>
      <p><span>元认知</span>${esc(plainText(item.metacognition || item.cognition || ""))}</p>
      <p><span>价值判断</span>${esc(plainText(item.valueJudgment || item.valueFunction || ""))}</p>
      <p><span>项目管理</span>${esc(plainText(item.projectManagement || item.management || ""))}</p>
      ${item.evidence ? `<p class="muted"><span>证据</span>${esc(plainText(item.evidence))}</p>` : ""}
    </article>
  `;
}

function bindLongitudinalWeekPicker(person, weeks) {
  const select = document.querySelector("[data-longitudinal-week-select]");
  if (!select) return;
  const go = () => {
    location.hash = `#/person-longitudinal-detail?week=${encodeURIComponent(select.value)}&slug=${encodeURIComponent(person.slug)}`;
  };
  document.querySelectorAll("[data-longitudinal-week-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = weeks.indexOf(select.value);
      const next = Math.max(0, Math.min(weeks.length - 1, current + Number(button.dataset.longitudinalWeekStep)));
      select.value = weeks[next];
      go();
    });
  });
  select.addEventListener("change", go);
}

function personHorizontalWeekControls(currentWeek) {
  const weeks = personHorizontalWeeks();
  const index = Math.max(0, weeks.findIndex((week) => week.week === currentWeek));
  const previous = weeks[Math.max(0, index - 1)]?.week || currentWeek;
  const next = weeks[Math.min(weeks.length - 1, index + 1)]?.week || currentWeek;
  return `
    <span class="week-controls inline-week-controls">
      <a class="button" href="#/person-horizontal?week=${encodeURIComponent(previous)}" title="上一周">‹</a>
      <select data-person-horizontal-week-select>
        ${weeks.slice().reverse().map((week) => `<option value="${esc(week.week)}" ${week.week === currentWeek ? "selected" : ""}>${esc(week.week)}</option>`).join("")}
      </select>
      <a class="button" href="#/person-horizontal?week=${encodeURIComponent(next)}" title="下一周">›</a>
    </span>
  `;
}

function bindPersonHorizontalWeekPicker() {
  document.querySelectorAll("[data-person-horizontal-week-select]").forEach((select) => {
    select.addEventListener("change", () => {
      location.hash = `#/person-horizontal?week=${encodeURIComponent(select.value)}`;
    });
  });
}

async function loadAnalysisByKey(key) {
  const item = analysisManifest?.items?.[key];
  if (!item?.file) return null;
  return fetch(item.file, { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null);
}

async function renderPersonHorizontal(weekId) {
  const weeks = personHorizontalWeeks();
  const selectedWeek = weeks.find((item) => item.week === weekId) || weeks.at(-1);
  if (!selectedWeek) {
    app.innerHTML = html`
      <section class="hero">
        <div>
          <h1>个人横向</h1>
          <p class="muted">还没有生成个人横向分析。</p>
        </div>
        <a class="button" href="#/person-analysis">返回个人分析</a>
      </section>
    `;
    return;
  }
  app.innerHTML = `<section class="panel"><h1>${esc(selectedWeek.week)} 个人横向</h1><p class="muted">正在加载个人画像...</p></section>`;
  const people = state.people.filter((person) => person.weeks.includes(selectedWeek.week));
  const payloads = await Promise.all(people.map(async (person) => ({
    person,
    payload: await loadAnalysisByKey(personHorizontalKey(person, selectedWeek.week))
  })));
  const available = payloads.filter((item) => item.payload && !item.payload.result?.skipped);
  app.innerHTML = html`
    <section class="hero">
      <div>
        <h1>${esc(selectedWeek.week)} 个人横向</h1>
        <p class="muted">按本周研究管理标准生成的个人反馈，不展示具体同学对标。评价只使用“好 / 很好 / 非常好 / 特别值得读”。</p>
      </div>
      <div class="toolbar">
        ${personHorizontalWeekControls(selectedWeek.week)}
        <a class="button" href="#/briefing?week=${encodeURIComponent(selectedWeek.week)}">本周横向分析</a>
        <a class="button" href="#/person-analysis">返回个人分析</a>
      </div>
    </section>
    <section class="stats">
      <div class="stat"><strong>${available.length}</strong><span>已生成画像</span></div>
      <div class="stat"><strong>${people.length}</strong><span>本周提交者</span></div>
      <div class="stat"><strong>${selectedWeek.submitted}</strong><span>已交</span></div>
      <div class="stat"><strong>${selectedWeek.reportCount || selectedWeek.submitted}</strong><span>原件</span></div>
    </section>
    <section class="person-horizontal-grid">
      ${available.length ? available.map(({ person, payload }) => personHorizontalCard(person, selectedWeek.week, payload)).join("") : `<article class="panel"><p class="muted">这一周还没有个人横向分析文件。</p></article>`}
    </section>
  `;
  bindPersonHorizontalWeekPicker();
}

function personHorizontalCard(person, week, payload) {
  const result = payload.result || {};
  const feedback = result.studentFeedback || {};
  const overview = plainText(result.overviewSentence || result.shortRead || result.sameWeekPosition || result.headline || "已生成个人横向画像");
  return html`
    <a class="person-horizontal-card" href="#/person-horizontal-detail?week=${encodeURIComponent(week)}&slug=${encodeURIComponent(person.slug)}">
      <div class="person-horizontal-head">
        <div>
          <strong>${esc(person.name)}</strong>
          <span class="muted">${esc(week)}</span>
        </div>
        <span class="level-pill">${esc(result.overallLevel || "好")}</span>
      </div>
      <p class="overview-line">${esc(overview)}</p>
      ${feedback.summary ? `<p class="student-feedback-line">${esc(plainText(feedback.summary))}</p>` : ""}
      <div class="person-horizontal-foot">
        <span class="badge">查看反馈</span>
        <span class="muted">${esc(payload.model || "")}</span>
      </div>
    </a>
  `;
}

async function renderPersonHorizontalDetail(weekId, slugValue) {
  const person = state.people.find((item) => item.slug === slugValue) || state.people[0];
  const week = weekId || person.latestWeek;
  const payload = await loadAnalysisByKey(personHorizontalKey(person, week));
  if (!payload || payload.result?.skipped) {
    app.innerHTML = html`
      <section class="panel">
        <h1>${esc(person.name)} 个人横向</h1>
        <p class="muted">${esc(week)} 的个人横向分析还没有生成。</p>
      </section>
    `;
    return;
  }
  const result = payload.result || {};
  const legacyActionKey = ["bo", "ssAction"].join("");
  const action = result.teacherAction || result[legacyActionKey] || {};
  const feedback = result.studentFeedback || {};
  app.innerHTML = html`
    <section class="hero">
      <div>
        <h1>${esc(person.name)} · ${esc(week)} 个人横向</h1>
        <p class="muted">${esc(plainText(result.headline || result.shortRead || "本周标准下的个人反馈"))}</p>
      </div>
      <div class="toolbar">
        <a class="button" href="#/person-horizontal?week=${encodeURIComponent(week)}">返回个人横向</a>
        <a class="button" href="#/person?slug=${encodeURIComponent(person.slug)}">个人原文</a>
        <a class="button" href="#/week?week=${encodeURIComponent(week)}">本周原文</a>
      </div>
    </section>
    <section class="person-profile-hero">
      <div>
        <span class="level-pill large">${esc(result.overallLevel || "好")}</span>
        <h2>${esc(plainText(result.shortRead || result.sameWeekPosition || ""))}</h2>
        <p>${esc(plainText(result.sameWeekPosition || ""))}</p>
      </div>
      <div class="teacher-box">
        <strong>老师动作</strong>
        <p>${action.readOriginal ? "建议优先读原文。" : "可以按需阅读原文。"}</p>
        ${analysisList(action.meetingQuestions, "meeting-questions")}
      </div>
    </section>
    <section class="focus-grid">
      ${focusDimension("价值判断", result.focusDimensions?.valueJudgment)}
      ${focusDimension("项目管理", result.focusDimensions?.projectManagement)}
      ${focusDimension("元认知", result.focusDimensions?.metacognition)}
    </section>
    <section class="student-feedback-panel">
      <div>
        <span class="badge">给学生的反馈</span>
        <h2>${esc(plainText(feedback.summary || "这份周报已经有清楚的横向信号，下一步可以把证据和行动写得更可验证。"))}</h2>
      </div>
      <div class="feedback-columns">
        ${detailPanel("做得好的地方", feedback.whatYouDidWell)}
        ${detailPanel("下一步可以更好", feedback.nextStep)}
        ${detailPanel("下周可以这样写", feedback.suggestedRewrite)}
      </div>
    </section>
    <section class="detail-grid">
      ${detailPanel("为什么是这个评价", result.levelRationale)}
      ${detailPanel("本周突出信号", result.highlightedSignals)}
      ${detailPanel("下一步提升空间", result.growthOpportunities)}
      ${detailPanel("下周观察点", action.nextWeekWatch)}
      ${detailPanel("证据入口", result.evidenceLinks)}
    </section>
  `;
}

function focusDimension(title, value = {}) {
  return html`
    <article class="focus-card">
      <span class="badge">${esc(title)}</span>
      <p>${esc(plainText(value.read || ""))}</p>
      ${value.evidence ? `<p class="muted"><strong>证据：</strong>${esc(plainText(value.evidence))}</p>` : ""}
      ${value.nextLift ? `<p class="muted"><strong>下一步：</strong>${esc(plainText(value.nextLift))}</p>` : ""}
    </article>
  `;
}

function detailPanel(title, value) {
  return html`
    <article class="detail-panel">
      <h3>${esc(title)}</h3>
      ${renderValue(value)}
    </article>
  `;
}

function renderValue(value) {
  if (value == null || value === "") return `<p class="muted">暂无</p>`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return `<p>${esc(value)}</p>`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return `<p class="muted">暂无</p>`;
    return `<ul>${value.map((item) => `<li>${renderInlineValue(item)}</li>`).join("")}</ul>`;
  }
  if (typeof value === "object") {
    return `<dl class="analysis-kv">${Object.entries(value).map(([key, item]) => `
      <dt>${esc(labelize(key))}</dt>
      <dd>${renderInlineValue(item)}</dd>
    `).join("")}</dl>`;
  }
  return `<p>${esc(String(value))}</p>`;
}

function plainText(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => plainText(item)).filter(Boolean).join("；");
  if (typeof value === "object") {
    const preferred = [
      "summary",
      "headline",
      "overviewSentence",
      "read",
      "readPriority",
      "oneLine",
      "shortRead",
      "sameWeekPosition",
      "evidence",
      "why",
      "reason",
      "text",
      "content",
      "action",
      "nextLift"
    ];
    const parts = [];
    for (const key of preferred) {
      if (value[key] != null && value[key] !== "") parts.push(plainText(value[key]));
    }
    if (!parts.length) {
      for (const [key, item] of Object.entries(value)) {
        const rendered = plainText(item);
        if (rendered) parts.push(`${labelize(key)}：${rendered}`);
      }
    }
    return parts.join("；");
  }
  return String(value);
}

function renderInlineValue(value) {
  if (value == null || value === "") return `<span class="muted">暂无</span>`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return esc(value);
  if (Array.isArray(value)) {
    return value.map((item) => renderInlineValue(item)).join("；");
  }
  if (typeof value === "object") {
    const preferred = ["title", "name", "week", "evidence", "why", "reason", "action", "read", "text", "summary", "content"];
    const parts = [];
    for (const key of preferred) {
      if (value[key] != null && value[key] !== "") parts.push(`${labelize(key)}：${renderInlineValue(value[key])}`);
    }
    if (!parts.length) {
      for (const [key, item] of Object.entries(value)) {
        if (item != null && item !== "") parts.push(`${labelize(key)}：${renderInlineValue(item)}`);
      }
    }
    return parts.join("；");
  }
  return esc(String(value));
}

function labelize(key) {
  const labels = {
    title: "标题",
    name: "姓名",
    week: "周次",
    evidence: "证据",
    why: "原因",
    reason: "原因",
    action: "动作",
    read: "读法",
    text: "内容",
    summary: "摘要",
    content: "内容",
    source: "来源",
    section: "部分",
    quote: "原文",
    nextLift: "下一步",
    suggestedRewrite: "改写示例",
    whatYouDidWell: "做得好的地方",
    nextStep: "下一步"
  };
  return labels[key] || String(key).replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function analysisList(items = [], className = "") {
  if (!Array.isArray(items) || !items.length) return "";
  return `<ul class="${esc(className)}">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function renderPerson(slugValue) {
  const person = state.people.find((item) => item.slug === slugValue) || state.people[0];
  const reports = state.reports.filter((report) => report.slug === person.slug).sort((a, b) => b.week.localeCompare(a.week));
  const analysis = state.personAnalyses[person.slug];
  app.innerHTML = html`
    <section class="hero">
      <div>
        <h1>${esc(person.name)} 纵向阅读</h1>
        <p class="muted">${person.count} 份周报，按时间倒序展示原件。</p>
      </div>
      <div class="toolbar">
        <button data-analysis="${personAnalysisKey(person, "longitudinal")}" data-target="person-values">价值观变化</button>
        <button data-analysis="${personAnalysisKey(person, "longitudinal")}" data-target="person-timeline">纵向摘要</button>
      </div>
    </section>
    <section class="analysis" id="person-values">${fallbackValueAnalysis(analysis)}</section>
    <section class="analysis" id="person-timeline">${fallbackPersonAnalysis(analysis)}</section>
    <div class="grid">
      <section class="panel">
        <div class="analysis-picker" data-person-slug="${esc(person.slug)}">
          <div>
            <h2>每周分析</h2>
            <p class="muted">选择一个周次，查看该周评分或截至该周的 4 周纵向分析。</p>
          </div>
          <div class="week-controls">
            <button data-week-step="-1" title="上一周">‹</button>
            <select data-week-select>
              ${person.weeks.slice().reverse().map((week) => `<option value="${esc(week)}">${esc(week)}</option>`).join("")}
            </select>
            <button data-week-step="1" title="下一周">›</button>
          </div>
        </div>
        <div class="selected-week-actions" data-selected-week-actions>
          ${selectedWeekActions(person, person.latestWeek)}
        </div>
        <div class="analysis" id="rolling-analysis"></div>
      </section>
      <section class="panel">
        <div class="analysis-picker report-picker">
          <div>
            <h2>周报原文</h2>
            <p class="muted">选择一个周次，只展开当前周的原件。</p>
          </div>
          <div class="week-controls">
            <button data-report-week-step="-1" title="上一周">‹</button>
            <select data-report-week-select>
              ${person.weeks.slice().reverse().map((week) => `<option value="${esc(week)}">${esc(week)}</option>`).join("")}
            </select>
            <button data-report-week-step="1" title="下一周">›</button>
          </div>
        </div>
        <div data-selected-report>
          ${selectedReport(person, reports, person.latestWeek)}
        </div>
      </section>
    </div>
  `;
  bindToggles();
  bindWeekPicker(person);
  bindReportWeekPicker(person, reports);
}

function renderSearch() {
  app.innerHTML = html`
    <h1>全文搜索</h1>
    <div class="toolbar">
      <input class="searchbox" id="q" placeholder="搜索姓名、周次、原文、关键词">
    </div>
    <div id="results" class="list"></div>
  `;
  const input = document.querySelector("#q");
  const results = document.querySelector("#results");
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const matched = state.reports.filter((report) => !q || `${report.name} ${report.week} ${report.rawText} ${report.keywords.join(" ")}`.toLowerCase().includes(q)).slice(0, 80);
    results.innerHTML = matched.map((report) => `
      <a class="row" href="#/week?week=${encodeURIComponent(report.week)}">
        <strong>${esc(report.name)}</strong>
        <span>${esc(report.excerpt)}</span>
        <span class="report-search-meta">
          <span class="badge">${esc(report.week)}</span>
          <small>提交时间：${esc(formatReportTimestamp(report))}</small>
        </span>
      </a>
    `).join("");
  };
  input.addEventListener("input", draw);
  draw();
}

function renderTemplate() {
  app.innerHTML = html`
    <section class="hero">
      <div>
        <h1>周报模板</h1>
        <p class="muted">同步自 OpenClaw 的 WEEKLY_REPORT_TEMPLATE.md。</p>
      </div>
      <a class="button" href="data/weekly-report-template.md">打开原始 Markdown</a>
    </section>
    <article class="report">
      <div class="report-body markdown">${md(state.template?.text || "模板尚未同步。")}</div>
    </article>
  `;
}

function bindToggles() {
  document.querySelectorAll("[data-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector(`#${button.dataset.toggle}`)?.classList.toggle("open");
    });
  });
  document.querySelectorAll("[data-analysis]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.querySelector(`#${button.dataset.target}`);
      if (!target) return;
      const nextKey = button.dataset.analysis;
      const sameOpen = target.classList.contains("open") && target.dataset.analysisKey === nextKey;
      if (sameOpen) {
        target.classList.remove("open");
        return;
      }
      target.classList.add("open");
      if (target.dataset.analysisKey === nextKey && target.dataset.loaded === "1") return;
      target.dataset.analysisKey = nextKey;
      target.dataset.loaded = "0";
      const item = analysisManifest?.items?.[button.dataset.analysis];
      if (!item?.file) {
        target.innerHTML = `<p class="muted">离线 Codex 分析还没有生成。</p>`;
        target.dataset.loaded = "1";
        return;
      }
      const payload = await fetch(item.file).then((response) => response.ok ? response.json() : null).catch(() => null);
      if (!payload || payload.result?.skipped) {
        target.innerHTML = `<p class="muted">离线 Codex 分析尚未生成。</p>`;
        target.dataset.loaded = "1";
        return;
      }
      target.innerHTML = renderAnalysisPayload(payload);
      target.dataset.loaded = "1";
    });
  });
}

function personAnalysisKey(person, type) {
  const rollingKey = `person:${person.slug}:${person.latestWeek}:${type}`;
  if (analysisManifest?.items?.[rollingKey]) return rollingKey;
  return `person:${person.slug}:${type}`;
}

function bindReportToggles() {
  document.querySelectorAll("[data-report-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const report = document.querySelector(`[data-report-id="${CSS.escape(button.dataset.reportToggle)}"]`);
      if (!report) return;
      report.classList.toggle("collapsed");
      button.textContent = report.classList.contains("collapsed") ? "▸" : "▾";
      button.setAttribute("aria-label", `${report.classList.contains("collapsed") ? "展开" : "收起"} ${report.querySelector("h3")?.textContent?.trim() || "周报"}`);
    });
  });
}

function bindReportJumps() {
  document.querySelectorAll("[data-jump-report]").forEach((button) => {
    button.addEventListener("click", () => {
      const report = document.querySelector(`[data-report-id="${CSS.escape(button.dataset.jumpReport)}"]`);
      if (!report) return;
      report.scrollIntoView({ behavior: "smooth", block: "start" });
      report.classList.add("focus-flash");
      setTimeout(() => report.classList.remove("focus-flash"), 900);
    });
  });
}

function bindWeekPicker(person) {
  const picker = document.querySelector(".analysis-picker");
  const select = picker?.querySelector("[data-week-select]");
  const actions = document.querySelector("[data-selected-week-actions]");
  if (!picker || !select || !actions) return;
  const weeks = person.weeks.slice().reverse();
  const render = () => {
    actions.innerHTML = selectedWeekActions(person, select.value);
    bindToggles();
  };
  picker.querySelectorAll("[data-week-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = weeks.indexOf(select.value);
      const next = Math.max(0, Math.min(weeks.length - 1, current + Number(button.dataset.weekStep)));
      select.value = weeks[next];
      render();
    });
  });
  select.addEventListener("change", render);
}

function bindReportWeekPicker(person, reports) {
  const picker = document.querySelector(".report-picker");
  const select = picker?.querySelector("[data-report-week-select]");
  const target = document.querySelector("[data-selected-report]");
  if (!picker || !select || !target) return;
  const weeks = person.weeks.slice().reverse();
  const render = () => {
    target.innerHTML = selectedReport(person, reports, select.value);
    bindReportToggles();
  };
  picker.querySelectorAll("[data-report-week-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = weeks.indexOf(select.value);
      const next = Math.max(0, Math.min(weeks.length - 1, current + Number(button.dataset.reportWeekStep)));
      select.value = weeks[next];
      render();
    });
  });
  select.addEventListener("change", render);
}

function selectedWeekActions(person, week) {
  return `
    <div class="row analysis-row compact">
      <strong>${esc(week)}</strong>
      <span>截至这一周，向前最多看 4 周；评分只看当前周。</span>
      <span class="inline-actions">
        <a class="button" href="#/person-longitudinal-detail?week=${encodeURIComponent(week)}&slug=${encodeURIComponent(person.slug)}">纵向</a>
        <button data-analysis="person:${person.slug}:${week}:weekly-score" data-target="rolling-analysis">评分</button>
      </span>
    </div>
  `;
}

function selectedReport(person, reports, week) {
  const report = reports.find((item) => item.week === week);
  if (!report) return `<p class="muted">${esc(person.name)} 在 ${esc(week)} 没有周报原件。</p>`;
  return reportCard(report, `<span class="badge">version ${report.version}</span>`, { collapsed: false });
}

function fallbackWeekAnalysis(week) {
  return `
    <h2>横向分析</h2>
    <p>${esc(week.analysis.summary)}</p>
    <h3>表现靠前</h3>
    <div class="list">
      ${week.analysis.topPerformers.map((item) => `
        <a class="row" href="#/person?slug=${encodeURIComponent(slug(item.name))}">
          <strong>${esc(item.name)}</strong>
          <span>${esc(item.reason)}</span>
          <span class="badge">score ${item.score}</span>
        </a>
      `).join("")}
    </div>
    <h3>高频主题</h3>
    <p>${week.analysis.themes.map((item) => `${esc(item.word)}(${item.count})`).join("、") || "暂无"}</p>
  `;
}

function fallbackValueAnalysis(analysis) {
  return `
    <h2>价值观变化</h2>
    <p><strong>早期：</strong>${esc(analysis.valueShift.early)}</p>
    <p><strong>最近：</strong>${esc(analysis.valueShift.latest)}</p>
    <p><strong>读法：</strong>${esc(analysis.valueShift.reading)}</p>
  `;
}

function fallbackPersonAnalysis(analysis) {
  return `
    <h2>纵向摘要</h2>
    <p>${esc(analysis.summary)}</p>
    <div class="list">
      ${analysis.timeline.slice().reverse().map((item) => `
        <div class="row">
          <strong>${esc(item.week)}</strong>
          <span>${esc(item.valueSnippet)}</span>
          <span class="badge">score ${item.score}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderAnalysisPayload(payload) {
  const result = scrubRetiredLateContent(payload.result || {});
  const body = typeof result.text === "string" ? result.text : JSON.stringify(result, null, 2);
  return `
    <h2>Codex 离线分析</h2>
    <p class="muted">生成时间：${esc(payload.generatedAt)}；模型：${esc(payload.model)}</p>
    <pre class="analysis-text">${esc(body)}</pre>
  `;
}

function slug(value) {
  const result = String(value || "").normalize("NFKD").replace(/[^\p{Letter}\p{Number}\s-]/gu, "").trim().replace(/\s+/g, "-").toLowerCase();
  return result || `name-${Array.from(String(value || "unknown")).map((char) => char.codePointAt(0).toString(16)).join("").slice(0, 16)}`;
}

window.addEventListener("hashchange", route);
route();
