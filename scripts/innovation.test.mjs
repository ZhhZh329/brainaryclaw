import assert from "node:assert/strict";
import { buildInnovationDataset, extractInnovationIdeas } from "./innovation.mjs";

const report = {
  id: "2026-08-23/test-person",
  week: "2026-08-23",
  name: "Test Person",
  slug: "test-person",
  submittedAt: "2026-08-22T10:11:12+08:00",
  rawText: `# 周报

## 最近三个 Idea 是怎么想到的

### Idea 1
- **工作 / 项目：** Memory Evaluator
- **Idea 是什么：** 用失败轨迹反推记忆质量
- **最初遇到的问题：** 静态准确率无法解释 Agent 为什么失败
- **是怎么一步步想到的：** 先比较成功与失败轨迹
  再定位首次决策分叉
  最后把分叉前使用的记忆作为评价对象
- **最终创新点：** 从结果评分改为决策分叉归因

### Idea 2
- **工作 / 项目：** Scanner
- **Idea 是什么：** 把未知技能识别改成关系恢复
- **最初遇到的问题：** 标签分类无法覆盖新技能
- **是怎么一步步想到的：** 观察到新技能仍复用旧动作关系
- **最终创新点：** 预测关系而不是预测固定类别

### Idea 3
- **工作 / 项目：**
- **Idea 是什么：**
- **最初遇到的问题：**
- **是怎么一步步想到的：**
- **最终创新点：**

## 下一节
不应被读取`
};

const ideas = extractInnovationIdeas(report);
assert.equal(ideas.length, 2);
assert.equal(ideas[0].project, "Memory Evaluator");
assert.match(ideas[0].formationProcess, /首次决策分叉/);
assert.equal(ideas[1].ideaId, "2026-08-23/test-person:idea-2");
assert.ok(!ideas.some((idea) => idea.rawText.includes("不应被读取")));

const oldReport = { ...report, id: "2026-08-16/test-person", week: "2026-08-16" };
assert.deepEqual(extractInnovationIdeas(oldReport), []);

const dataset = buildInnovationDataset([report, oldReport], ["2026-08-16", "2026-08-23"]);
assert.equal(dataset.ideas.length, 2);
assert.deepEqual(dataset.weeks.map((week) => week.week), ["2026-08-23"]);
assert.equal(dataset.weeks[0].peopleCount, 1);

console.log("Innovation extraction tests passed.");
