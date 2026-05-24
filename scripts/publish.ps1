$ErrorActionPreference = "Stop"

Push-Location $PSScriptRoot\..
try {
  $logDir = Join-Path (Get-Location).Path "logs"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $logFile = Join-Path $logDir "hourly-sync.log"
  function Write-Step($message) {
    $line = "[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $message
    $line | Tee-Object -FilePath $logFile -Append
  }

  Write-Step "Starting hourly OpenClaw sync."

  $envFile = Join-Path (Get-Location).Path ".env.local"
  if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
      $line = $_.Trim()
      if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
      $key, $value = $line.Split("=", 2)
      if (-not [Environment]::GetEnvironmentVariable($key, "Process")) {
        [Environment]::SetEnvironmentVariable($key, $value, "Process")
      }
    }
  }

  if (-not $env:WEEKREP_ANALYZE_TYPES) { $env:WEEKREP_ANALYZE_TYPES = "weekly-score,longitudinal,week-horizontal" }
  if (-not $env:WEEKREP_ANALYZE_ROLLING) { $env:WEEKREP_ANALYZE_ROLLING = "1" }
  if (-not $env:WEEKREP_ANALYZE_CONCURRENCY) { $env:WEEKREP_ANALYZE_CONCURRENCY = "100" }
  if (-not $env:WEEKREP_PERSON_WEEK_ANALYSIS_POLICY) { $env:WEEKREP_PERSON_WEEK_ANALYSIS_POLICY = "on-change" }
  if (-not $env:WEEKREP_MIN_VALID_REPORT_CHARS) { $env:WEEKREP_MIN_VALID_REPORT_CHARS = "10" }

  Write-Step "Running build -> analyze missing/changed reports -> build."
  npm run sync-full
  Write-Step "Local sync and analysis finished."

  $repo = (Get-Location).Path
  $repoForWsl = $repo -replace "\\", "/"
  $wslRepo = (wsl wslpath -a "$repoForWsl").Trim()

  $hasToken = -not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN_PUSH)
  if ($env:GITHUB_TOKEN_PUSH) {
    $askpassSource = Join-Path $repo ".git\weekrep-askpass-source.sh"
    @(
      "#!/bin/sh",
      'case "$1" in',
      "  *Username*) printf '%s\n' 'x-access-token' ;;",
      "  *) printf '%s\n' ""`$GITHUB_TOKEN_PUSH"" ;;",
      "esac"
    ) | Set-Content -Encoding ASCII -Path $askpassSource
    wsl bash -lc "cd '$wslRepo' && sed -i 's/\r$//' .git/weekrep-askpass-source.sh && cp .git/weekrep-askpass-source.sh /tmp/weekrep-pages-askpass.sh && chmod 700 /tmp/weekrep-pages-askpass.sh"
  }

  Write-Step "Committing and pushing changed site artifacts."
  $pushCommand = if ($hasToken) {
    "GITHUB_TOKEN_PUSH='$($env:GITHUB_TOKEN_PUSH)' GIT_ASKPASS=/tmp/weekrep-pages-askpass.sh GIT_TERMINAL_PROMPT=0 git push"
  } else {
    "git push"
  }
  wsl bash -lc "cd '$wslRepo' && git status --short && git add . && if git diff --cached --quiet; then echo 'No changes to publish.'; else git commit -m 'sync weekly reports' && $pushCommand; fi; rm -f /tmp/weekrep-pages-askpass.sh .git/weekrep-askpass-source.sh"
  Write-Step "Hourly OpenClaw sync finished."
}
finally {
  Pop-Location
}
