param(
  [string]$Branch = "codex/autosave-avi",
  [string]$TaskName = "MenuVoice Autosave Avi",
  [int]$Minutes = 30
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AutosaveScript = Join-Path $ScriptDir "autosave-github.ps1"

if (-not (Test-Path -LiteralPath $AutosaveScript)) {
  throw "Autosave script not found: $AutosaveScript"
}

$PowerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$Action = New-ScheduledTaskAction `
  -Execute $PowerShellPath `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$AutosaveScript`" -Branch `"$Branch`""

$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $Minutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "Commits and pushes MenuVoice checkpoint changes to $Branch every $Minutes minutes." `
  -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' for branch '$Branch' every $Minutes minutes."
