$ErrorActionPreference = "Stop"

$project = Resolve-Path "$PSScriptRoot\.."
$script = Join-Path $project "scripts\publish.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName "Weekrep Pages Hourly Publish" -Action $action -Trigger $trigger -Settings $settings -Description "Build and push weekly report Pages site every hour." -Force
