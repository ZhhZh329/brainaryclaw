# Weekrep Pages

An isolated static publishing project for OpenClaw weekly reports.

OpenClaw is treated as a read-only source. This project generates a searchable GitHub Pages site from:

- `\\wsl.localhost\Ubuntu\home\brainary\.openclaw\weekly_reports`
- `\\wsl.localhost\Ubuntu\home\brainary\.openclaw\data\weekly_state`
- `\\wsl.localhost\Ubuntu\home\brainary\.openclaw\data\registry.json`
- `\\wsl.localhost\Ubuntu\home\brainary\.openclaw\WEEKLY_REPORT_TEMPLATE.md`

## Build

```powershell
npm run build
```

To generate cached DeepSeek/OpenAI analysis during local sync:

```powershell
$env:DEEPSEEK_API_KEY="..."
npm run sync-full
```

Without `DEEPSEEK_API_KEY` or `OPENAI_API_KEY`, analysis is skipped and existing cached analysis files are preserved.

You can also put secrets in `.env.local`, which is ignored by git:

```text
DEEPSEEK_API_KEY=...
LLM_PROVIDER=deepseek
```

Config knobs:

```text
LLM_PROVIDER=deepseek
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_REASONING_EFFORT=high
DEEPSEEK_THINKING=enabled

LLM_PROVIDER=openai
OPENAI_MODEL=gpt-5.2-codex
OPENAI_REASONING_EFFORT=medium

WEEKREP_LONGITUDINAL_WEEKS=4
WEEKREP_ANALYZE_FORCE=1
WEEKREP_ANALYZE_CONCURRENCY=100

# Default: analyze a person-week as soon as a valid report lands, and re-analyze when content changes.
WEEKREP_PERSON_WEEK_ANALYSIS_POLICY=on-change
WEEKREP_MIN_VALID_REPORT_CHARS=10

# Alternative: wait until the week deadline, then generate each person-week analysis once.
WEEKREP_PERSON_WEEK_ANALYSIS_POLICY=deadline-once
```

Open `public/index.html` or run:

```powershell
npm run serve
```

## Publish

After connecting this folder to a GitHub repository, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish.ps1
```

For hourly local publishing, register a Windows scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-hourly-task.ps1
```

GitHub Pages publishes from `public/` after each push.

## Analysis Prompts

Prompt drafts for LLM-based analysis live in:

```text
prompts/weekrep-analysis-prompts.md
```

They are based on the OpenClaw weekly report template and cover:

- Week horizontal ranking
- Person longitudinal analysis
- Person value-view change
- Single report deep read
