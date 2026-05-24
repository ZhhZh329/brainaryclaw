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
  $askpassCleanup = ""
  if ($env:GITHUB_TOKEN_PUSH) {
    $askpassPath = Join-Path $repo ".git\askpass.sh"
    @(
      "#!/bin/sh",
      'case "$1" in',
      "  *Username*) printf '%s\n' 'x-access-token' ;;",
      "  *) printf '%s\n' ""`$GITHUB_TOKEN_PUSH"" ;;",
      "esac"
    ) | Set-Content -Encoding ASCII -Path $askpassPath
    wsl bash -lc "sed -i 's/\r$//' '$wslRepo/.git/askpass.sh' && chmod 700 '$wslRepo/.git/askpass.sh'"
    $pushEnv = "GITHUB_TOKEN_PUSH='$($env:GITHUB_TOKEN_PUSH)' GIT_ASKPASS='$wslRepo/.git/askpass.sh' GIT_TERMINAL_PROMPT=0"
    $askpassCleanup = "rm -f .git/askpass.sh;"
  }

  wsl bash -lc "cd '$wslRepo' && git status --short && git add . && if git diff --cached --quiet; then echo 'No changes to publish.'; else git commit -m 'sync weekly reports' && $pushEnv git push; $askpassCleanup fi"
}
finally {
  Pop-Location
}
