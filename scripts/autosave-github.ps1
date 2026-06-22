param(
  [string]$Branch = "codex/autosave-avi",
  [string[]]$ExcludePathspecs = @(":!.codex", ":!.agents")
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$SafeDirectory = ($RepoRoot -replace "\\", "/")
$LogRoot = Join-Path $env:LOCALAPPDATA "MenuVoiceAutosave"
$LockPath = Join-Path $env:TEMP "menuvoice2-autosave.lock"

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

function Write-Log {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
  Add-Content -LiteralPath (Join-Path $LogRoot "autosave.log") -Value "[$timestamp] $Message"
}

function Invoke-Git {
  & git -c "safe.directory=$SafeDirectory" @args
  if ($LASTEXITCODE -ne 0) {
    throw "git $($args -join ' ') failed with exit code $LASTEXITCODE"
  }
}

if (Test-Path -LiteralPath $LockPath) {
  $lockAge = (Get-Date) - (Get-Item -LiteralPath $LockPath).LastWriteTime
  if ($lockAge.TotalMinutes -lt 20) {
    Write-Log "Skipped because another autosave appears to be running."
    exit 0
  }
}

Set-Content -LiteralPath $LockPath -Value ([System.Diagnostics.Process]::GetCurrentProcess().Id)

try {
  Set-Location -LiteralPath $RepoRoot
  Write-Log "Autosave started for $RepoRoot on branch $Branch."

  $currentBranch = (& git -c "safe.directory=$SafeDirectory" branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($currentBranch)) {
    throw "Could not determine current git branch."
  }

  if ($currentBranch -ne $Branch) {
    & git -c "safe.directory=$SafeDirectory" show-ref --verify --quiet "refs/heads/$Branch"
    if ($LASTEXITCODE -eq 0) {
      Invoke-Git switch $Branch
    } else {
      Invoke-Git switch -c $Branch
    }
  }

  $changes = (& git -c "safe.directory=$SafeDirectory" status --porcelain)
  if ($LASTEXITCODE -ne 0) {
    throw "git status failed with exit code $LASTEXITCODE"
  }

  if ($changes) {
    Invoke-Git add -A -- . $ExcludePathspecs
    & git -c "safe.directory=$SafeDirectory" diff --cached --quiet
    if ($LASTEXITCODE -eq 1) {
      $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
      Invoke-Git commit -m "autosave: checkpoint $stamp"
      Write-Log "Created checkpoint commit."
    } elseif ($LASTEXITCODE -ne 0) {
      throw "git diff --cached --quiet failed with exit code $LASTEXITCODE"
    }
  } else {
    Write-Log "No changes to commit."
  }

  Invoke-Git push -u origin $Branch
  Write-Log "Pushed $Branch to origin."
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  throw
} finally {
  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}
