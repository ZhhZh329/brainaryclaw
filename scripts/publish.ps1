$ErrorActionPreference = "Stop"

Push-Location $PSScriptRoot\..
try {
  npm run sync-full

  $repo = (Get-Location).Path
  $wslRepo = (wsl wslpath -a "$repo").Trim()

  wsl bash -lc "cd '$wslRepo' && git status --short && git add . && if git diff --cached --quiet; then echo 'No changes to publish.'; else git commit -m 'sync weekly reports' && git push; fi"
}
finally {
  Pop-Location
}
