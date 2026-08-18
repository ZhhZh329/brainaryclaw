const sectionHeadingPattern = /最近三个\s*(?:重要)?(?:工作\s*)?Idea\s*是怎么想到的|创新方法论/i;
const ideaHeadingPattern = /^#{1,6}\s*Idea\s*(\d+)/i;

const fields = [
  ["project", /^(?:工作\s*\/\s*项目|工作|项目)\s*[:：]?\s*(.*)$/i],
  ["idea", /^Idea\s*是什么\s*[:：]?\s*(.*)$/i],
  ["startingProblem", /^最初遇到的问题\s*[:：]?\s*(.*)$/i],
  ["formationProcess", /^是怎么一步步想到的\s*[:：]?\s*(.*)$/i],
  ["innovationPoint", /^最终创新点\s*[:：]?\s*(.*)$/i]
];

function headingLevel(line) {
  return String(line || "").match(/^\s*(#{1,6})\s+/)?.[1].length || 0;
}

function cleanLine(line) {
  return String(line || "")
    .trim()
    .replace(/^[-*+]\s*/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
}

function sectionLines(text) {
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((line) => sectionHeadingPattern.test(cleanLine(line)));
  if (start < 0) return [];
  const level = headingLevel(lines[start]) || 2;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const nextLevel = headingLevel(lines[index]);
    if (nextLevel && nextLevel <= level && !ideaHeadingPattern.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function ideaBlocks(text) {
  const lines = sectionLines(text);
  const starts = lines
    .map((line, index) => ({ index, match: line.trim().match(ideaHeadingPattern) }))
    .filter((item) => item.match)
    .slice(0, 3);
  return starts.map((item, index) => ({
    ideaIndex: Number(item.match[1]) || index + 1,
    lines: lines.slice(item.index + 1, starts[index + 1]?.index ?? lines.length),
    rawText: lines.slice(item.index, starts[index + 1]?.index ?? lines.length).join("\n").trim()
  }));
}

function parsedFields(lines) {
  const result = Object.fromEntries(fields.map(([key]) => [key, ""]));
  let activeKey = "";
  for (const rawLine of lines) {
    const line = cleanLine(rawLine);
    if (!line) continue;
    const match = fields.map(([key, pattern]) => ({ key, match: line.match(pattern) })).find((item) => item.match);
    if (match) {
      activeKey = match.key;
      const value = match.match[1]?.trim() || "";
      if (value) result[activeKey] = value;
      continue;
    }
    if (activeKey && !headingLevel(rawLine)) {
      result[activeKey] = [result[activeKey], line].filter(Boolean).join("\n");
    }
  }
  return result;
}

function hasMeaningfulContent(item) {
  const text = [item.idea, item.startingProblem, item.formationProcess, item.innovationPoint]
    .join(" ")
    .replace(/同上|待填写|无|暂无/g, "")
    .replace(/\s+/g, "")
    .trim();
  return text.length >= 10;
}

export function extractInnovationIdeas(report, startWeek = "2026-08-23") {
  if (!report || String(report.week || "") < startWeek) return [];
  return ideaBlocks(report.rawText).map((block, index) => {
    const values = parsedFields(block.lines);
    return {
      ideaId: `${report.id}:idea-${block.ideaIndex || index + 1}`,
      reportId: report.id,
      ideaIndex: block.ideaIndex || index + 1,
      name: report.name,
      slug: report.slug,
      week: report.week,
      submittedAt: report.submittedAt || report.updatedAt || report.createdAt || "",
      ...values,
      rawText: block.rawText
    };
  }).filter(hasMeaningfulContent);
}

export function buildInnovationDataset(reports, weeks, startWeek = "2026-08-23") {
  const ideas = reports.flatMap((report) => extractInnovationIdeas(report, startWeek))
    .sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name) || a.ideaIndex - b.ideaIndex);
  const availableWeeks = weeks.filter((week) => week >= startWeek);
  return {
    startWeek,
    ideas,
    weeks: availableWeeks.map((week) => {
      const items = ideas.filter((idea) => idea.week === week);
      return {
        week,
        count: items.length,
        peopleCount: new Set(items.map((item) => item.slug)).size,
        items
      };
    })
  };
}
