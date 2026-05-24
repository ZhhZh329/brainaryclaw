$ErrorActionPreference = "Stop"

Push-Location $PSScriptRoot\..
try {
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

  npm run sync-full

  $repo = (Get-Location).Path
  $repoForWsl = $repo -replace "\\", "/"
  $wslRepo = (wsl wslpath -a "$repoForWsl").Trim()

  $pushEnv = ""
  $askpassSetup = ""
  $askpassCleanup = ""
  if ($env:GITHUB_TOKEN_PUSH) {
    $pushEnv = "GITHUB_TOKEN_PUSH='$($env:GITHUB_TOKEN_PUSH)' GIT_ASKPASS=.git/askpass.sh GIT_TERMINAL_PROMPT=0"
    $askpassSetup = "printf '%s\n' '#!/bin/sh' 'case ""`$1"" in' '  *Username*) printf '\''%s\n'\'' '\''x-access-token'\'' ;;' '  *) printf '\''%s\n'\'' ""`$GITHUB_TOKEN_PUSH"" ;;' 'esac' > .git/askpass.sh && chmod 700 .git/askpass.sh &&"
    $askpassCleanup = "rm -f .git/askpass.sh;"
  }

  wsl bash -lc "cd '$wslRepo' && git status --short && git add . && if git diff --cached --quiet; then echo 'No changes to publish.'; else git commit -m 'sync weekly reports' && $askpassSetup $pushEnv git push; $askpassCleanup fi"
}
finally {
  Pop-Location
}
