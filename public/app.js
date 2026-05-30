const app = document.querySelector("#app");
const state = await fetch("data/site-data.json").then((response) => response.json());
const analysisManifest = await fetch("data/analysis/manifest.json").then((response) => response.ok ? response.json() : null).catch(() => null);

const html = (strings, ...values) => strings.reduce((out, string, i) => out + string + (values[i] ?? ""), "");
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
const params = () => new URLSearchParams(location.hash.split("?")[1] || "");
const missingLabel = (week) => week?.pastDeadline ? "未交" : "待交";

function route() {
  const hash = location.hash || "#/";
  const [path] = hash.slice(1).split("?");
  if (path === "/weeks") return renderWeeks();
  if (path === "/week") return renderWeek(params().get("week"));
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
  return html`
    <article class="report ${collapsed ? "collapsed" : ""}" id="${esc(report.id)}" data-report-id="${esc(report.id)}">
      <div class="report-header">
        <div>
          <h3>
            ${collapsed ? `<button class="twisty" data-report-toggle="${esc(report.id)}" aria-label="展开 ${esc(report.name)}">▸</button>` : ""}
            ${esc(report.name)}
          </h3>
          <div class="muted">${esc(report.week)} ${meta}</div>
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
        <span class="badge">迟交 ${latest.lateCount || 0}</span>
      </div>
      <p class="muted">截止时间：${esc(latest.deadline)}。应交名单来自 registry.json 的 active + bound 成员。</p>
      ${latest.missing.length ? `<p class="muted">${missingLabel(latest)}：${latest.missing.map((item) => esc(item.name)).join("、")}</p>` : `<p class="muted">最新周没有${missingLabel(latest)}记录。</p>`}
    </section>
    <section class="cards" style="margin-top:16px">
      ${state.weeks.slice().reverse().map((week) => `
        <a class="card" href="#/week?week=${encodeURIComponent(week.week)}">
          <strong>${esc(week.week)}</strong>
          <span class="muted">已交 ${week.submitted} / 应交 ${week.rosterSize}，原件 ${week.reportCount || week.submitted}，迟交 ${week.lateCount || 0}</span>
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
          <span>已交 ${week.submitted} / 应交 ${week.rosterSize}，原件 ${week.reportCount || week.submitted}，迟交 ${week.lateCount || 0}</span>
          <span class="${week.missingCount ? "badge danger" : "badge ok"}">${week.missingCount ? `${missingLabel(week)} ${week.missingCount}` : "全部提交"}</span>
        </a>
      `).join("")}
    </div>
  `;
}

function renderWeek(weekId) {
  const week = state.weeks.find((item) => item.week === weekId) || latestWeek();
  const reports = state.reports.filter((report) => report.week === week.week).sort((a, b) => a.name.localeCompare(b.name));
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
        <span class="badge">迟交 ${week.lateCount || 0}</span>
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
        <p><span class="badge">迟交 ${week.lateCount || 0}</span></p>
        <p class="muted">截止：${esc(week.deadline)}</p>
        <h3>已交</h3>
        <div class="name-list">
          ${reports.map((report) => `<button class="name-jump" data-jump-report="${esc(report.id)}">${esc(report.name)}</button>`).join("")}
        </div>
        <h3>${missingLabel(week)}</h3>
        ${week.missing.length ? `<div class="name-list muted">${week.missing.map((item) => `<span>${esc(item.name)}</span>`).join("")}</div>` : `<p class="muted">没有${missingLabel(week)}记录。</p>`}
        ${week.late?.length ? `<h3>迟交</h3><p class="muted">${week.late.map((item) => `${esc(item.name)}<br>${esc(item.submittedAt)}`).join("<br>")}</p>` : ""}
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
        <span class="badge">${esc(report.week)}</span>
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
        <button data-analysis="person:${person.slug}:${week}:longitudinal" data-target="rolling-analysis">纵向</button>
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
  const result = payload.result || {};
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
