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

  function Invoke-GitHubApi($method, $uri, $token) {
    $headers = @{
      Authorization = "Bearer $token"
      Accept = "application/vnd.github+json"
      "X-GitHub-Api-Version" = "2022-11-28"
      "User-Agent" = "weekrep-pages-publish"
    }
    if ($method -eq "GET") {
      return Invoke-RestMethod -Method Get -Headers $headers -Uri $uri
    }
    return Invoke-RestMethod -Method $method -Headers $headers -Uri $uri -ContentType "application/json"
  }

  function Wait-GitHubPagesDeploy($commitSha, $token, $maxReruns = 2) {
    if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($commitSha)) {
      Write-Step "Skipping Pages deploy verification because token or commit SHA is missing."
      return
    }

    $encodedSha = [System.Uri]::EscapeDataString($commitSha)
    $run = $null
    for ($attempt = 0; $attempt -lt 24; $attempt++) {
      $runs = Invoke-GitHubApi "GET" "https://api.github.com/repos/ZhhZh329/brainaryclaw/actions/runs?head_sha=$encodedSha&event=push&per_page=5" $token
      $run = @($runs.workflow_runs | Where-Object { $_.name -eq "Deploy GitHub Pages" } | Select-Object -First 1)[0]
      if ($run) { break }
      Start-Sleep -Seconds 5
    }

    if (-not $run) {
      Write-Step "No GitHub Pages workflow run found yet for $($commitSha.Substring(0, 7)); skipping verification."
      return
    }

    for ($rerun = 0; $rerun -le $maxReruns; $rerun++) {
      while ($run.status -ne "completed") {
        Write-Step "Pages deploy $($run.id) is $($run.status); waiting."
        Start-Sleep -Seconds 10
        $run = Invoke-GitHubApi "GET" "https://api.github.com/repos/ZhhZh329/brainaryclaw/actions/runs/$($run.id)" $token
      }

      if ($run.conclusion -eq "success") {
        Write-Step "Pages deploy succeeded for $($commitSha.Substring(0, 7))."
        return
      }

      Write-Step "Pages deploy $($run.id) finished with $($run.conclusion)."
      if ($rerun -ge $maxReruns) { break }

      Write-Step "Rerunning failed Pages deploy jobs for $($commitSha.Substring(0, 7)); retry $($rerun + 1) of $maxReruns."
      Invoke-GitHubApi "POST" "https://api.github.com/repos/ZhhZh329/brainaryclaw/actions/runs/$($run.id)/rerun-failed-jobs" $token | Out-Null
      Start-Sleep -Seconds 15

      for ($attempt = 0; $attempt -lt 24; $attempt++) {
        $runs = Invoke-GitHubApi "GET" "https://api.github.com/repos/ZhhZh329/brainaryclaw/actions/runs?head_sha=$encodedSha&event=push&per_page=5" $token
        $run = @($runs.workflow_runs | Where-Object { $_.name -eq "Deploy GitHub Pages" } | Sort-Object run_attempt -Descending | Select-Object -First 1)[0]
        if ($run -and $run.status -ne "completed") { break }
        Start-Sleep -Seconds 5
      }
    }

    throw "GitHub Pages deploy did not succeed for $($commitSha.Substring(0, 7)) after retries."
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

  if (-not $env:WEEKREP_ANALYZE_TYPES) { $env:WEEKREP_ANALYZE_TYPES = "weekly-score,longitudinal,person-horizontal,week-horizontal,week-briefing,month-horizontal" }
  if (-not $env:WEEKREP_ANALYZE_ROLLING) { $env:WEEKREP_ANALYZE_ROLLING = "1" }
  if (-not $env:WEEKREP_ANALYZE_CONCURRENCY) { $env:WEEKREP_ANALYZE_CONCURRENCY = "5" }
  if (-not $env:WEEKREP_ANALYZE_RETRIES) { $env:WEEKREP_ANALYZE_RETRIES = "0" }
  if (-not $env:WEEKREP_ANALYZE_MAX_GENERATED_PER_RUN) { $env:WEEKREP_ANALYZE_MAX_GENERATED_PER_RUN = "20" }
  if (-not $env:WEEKREP_ANALYZE_TIMEOUT_MS) { $env:WEEKREP_ANALYZE_TIMEOUT_MS = "60000" }
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
    $env:WSLENV = if ([string]::IsNullOrWhiteSpace($env:WSLENV)) {
      "GITHUB_TOKEN_PUSH"
    } elseif ($env:WSLENV -notmatch "(^|:)GITHUB_TOKEN_PUSH(:|$)") {
      "$env:WSLENV`:GITHUB_TOKEN_PUSH"
    } else {
      $env:WSLENV
    }
  }

  Write-Step "Committing and pushing changed site artifacts."
  $beforeHead = (wsl bash -lc "cd '$wslRepo' && git rev-parse HEAD").Trim()
  $pushCommand = if ($hasToken) {
    'GIT_TERMINAL_PROMPT=0 git push "https://x-access-token:${GITHUB_TOKEN_PUSH}@github.com/ZhhZh329/brainaryclaw.git" main && git fetch origin main'
  } else {
    "git push && git fetch origin main"
  }
  wsl bash -lc "cd '$wslRepo' && git status --short && git add . && if git diff --cached --quiet; then echo 'No changes to publish.'; else git commit -m 'sync weekly reports' && $pushCommand; fi; rc=`$?; rm -f .git/weekrep-askpass.sh; exit `$rc"
  $afterHead = (wsl bash -lc "cd '$wslRepo' && git rev-parse HEAD").Trim()
  if ($afterHead -ne $beforeHead) {
    Write-Step "Verifying GitHub Pages deploy for $($afterHead.Substring(0, 7))."
    Wait-GitHubPagesDeploy $afterHead $env:GITHUB_TOKEN_PUSH
  } else {
    Write-Step "No new commit was created; skipping Pages deploy verification."
  }
  Write-Step "Hourly OpenClaw sync finished."
}
finally {
  Pop-Location
}
