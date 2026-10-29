import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("", { runScripts: "outside-only" });
dom.window.eval(fs.readFileSync(new URL("../public/vendor/report-markdown.js", import.meta.url), "utf8"));
const render = dom.window.ReportMarkdown.render;
const doc = dom.window.document;
doc.body.innerHTML = render("### Heading\n- **Bold**\n  - Nested\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```html\n<script>bad()</script>\n```");
assert.equal(doc.querySelector("h3").textContent, "Heading");
assert.equal(doc.querySelector("strong").textContent, "Bold");
assert.ok(doc.querySelector("ul ul li"));
assert.equal(doc.querySelectorAll("td").length, 2);
assert.ok(doc.querySelector("pre code").textContent.includes("<script>"));
doc.body.innerHTML = render('<script>bad()</script><img src=x onerror="bad()"><a href="javascript:bad()">bad</a><div onclick="bad()" style="position:fixed" id="app">text</div>');
assert.equal(doc.querySelectorAll("script,img,[onclick],[style],[id],[href^='javascript:']").length, 0);
const data = JSON.parse(fs.readFileSync(new URL("../public/data/site-data.json", import.meta.url)));
for (const report of data.reports.filter(r => r.slug === "liu-chengyue" && r.week >= "2026-10-18")) {
  doc.body.innerHTML = render(report.rawText);
  assert.ok([...doc.querySelectorAll("h3")].every(h => h.textContent.length < 100));
  assert.ok(doc.querySelector("strong"));
}
console.log("PASS: headings, nested lists, tables, code, unsafe HTML, three real reports");
