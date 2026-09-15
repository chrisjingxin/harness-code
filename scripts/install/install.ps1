# Harness Code Windows 安装器：与 install.sh 同一语义。请在 PowerShell 中运行，不要用 CMD 或 Git Bash。
$ErrorActionPreference = "Stop"

function Fail([int]$Code, [string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit $Code
}

function Show-Usage {
  @"
Usage: install.ps1 [--version X.Y.Z] [--no-modify-path] [--help]

Install Harness Code for Windows x64.

  --version X.Y.Z     Pin @za38/cli and za38-agent (default: latest)
  --no-modify-path    Do not edit the user PATH
  --help              Show this help

Fill DEFAULT_* at the top before hosting so users need no env vars.

Environment (optional overrides):
  HARNESS_INSTALL_VERSION     Same as --version
  HARNESS_NO_MODIFY_PATH      Set to 1 for --no-modify-path
  HARNESS_NPM_REGISTRY        bun registry for @za38/cli
  UV_INDEX_URL                uv index for za38-agent
  HARNESS_BUN_INSTALL_URL     Override Bun installer
  HARNESS_UV_INSTALL_URL      Override uv installer
  HARNESS_INSTALL_BASE_URL    Host for this script and example config
  HARNESS_EXAMPLE_CONFIG      Local example config.toml to copy
  HARNESS_INSTALL_SHELL       Test hook: cmd|bash|gitbash rejects this script
"@
}

$MinBun = "1.2.19"
$CliPackage = "@za38/cli"
$AgentPackage = "za38-agent"
# 托管到企业域名之前填写这三项。仓库里不要写死某个域名。
$DefaultInstallBaseUrl = ""
$DefaultNpmRegistry = ""
$DefaultPypiIndex = ""
$Version = if ($env:HARNESS_INSTALL_VERSION) { $env:HARNESS_INSTALL_VERSION } else { "latest" }
$NoModifyPath = $env:HARNESS_NO_MODIFY_PATH -eq "1"
$InstallBaseUrl = if ($env:HARNESS_INSTALL_BASE_URL) { $env:HARNESS_INSTALL_BASE_URL } else { $DefaultInstallBaseUrl }
$NpmRegistry = if ($env:HARNESS_NPM_REGISTRY) { $env:HARNESS_NPM_REGISTRY } else { $DefaultNpmRegistry }
$PypiIndex = if ($env:UV_INDEX_URL) { $env:UV_INDEX_URL } else { $DefaultPypiIndex }
$BunInstallUrl = if ($env:HARNESS_BUN_INSTALL_URL) { $env:HARNESS_BUN_INSTALL_URL } else { "https://bun.sh/install.ps1" }
$UvInstallUrl = if ($env:HARNESS_UV_INSTALL_URL) { $env:HARNESS_UV_INSTALL_URL } else { "https://astral.sh/uv/install.ps1" }

for ($i = 0; $i -lt $args.Count; $i++) {
  $arg = [string]$args[$i]
  switch ($arg) {
    "--help" { Show-Usage; exit 0 }
    "-h" { Show-Usage; exit 0 }
    "--no-modify-path" { $NoModifyPath = $true }
    "--version" {
      if ($i + 1 -ge $args.Count -or ([string]$args[$i + 1]).StartsWith("-")) {
        Show-Usage
        Fail 2 "error: --version requires X.Y.Z"
      }
      $i++
      $Version = [string]$args[$i]
    }
    default {
      Show-Usage
      Fail 2 "error: unknown argument: $arg"
    }
  }
}

$shellHint = $env:HARNESS_INSTALL_SHELL
if ($shellHint -eq "cmd" -or $shellHint -eq "bash" -or $shellHint -eq "gitbash") {
  Fail 1 "Please run this installer in PowerShell, not CMD or Git Bash."
}
if ($env:MSYSTEM) {
  Fail 1 "Please run this installer in PowerShell, not Git Bash."
}

$os = if ($env:HARNESS_INSTALL_OS) { $env:HARNESS_INSTALL_OS } else { $env:OS }
$archRaw = if ($env:HARNESS_INSTALL_ARCH) { $env:HARNESS_INSTALL_ARCH } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch -Regex ($archRaw) {
  "^(AMD64|x86_64|x64)$" { "x64" }
  "^(ARM64|arm64)$" { "arm64" }
  default { $archRaw }
}

if ($os -and $os -notmatch "Windows") {
  Fail 1 "error: unsupported OS: $os (use install.sh on macOS/Linux)"
}

if ($arch -eq "arm64") {
  Fail 1 "Windows ARM is not supported in this release. Use Windows x64."
}
if ($arch -and $arch -ne "x64") {
  Fail 1 "error: unsupported architecture: $arch"
}

function Test-VersionAtLeast([string]$Current, [string]$Minimum) {
  try {
    return ([version]$Current) -ge ([version]$Minimum)
  } catch {
    return $false
  }
}

function Test-HasBun {
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $bun) { return $false }
  $raw = (bun --version 2>$null | Select-Object -First 1)
  if (-not $raw) { return $false }
  $raw = ($raw -split "-")[0]
  return Test-VersionAtLeast $raw $MinBun
}

function Add-UserPath([string]$Directory) {
  if (-not $Directory) { return }
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $current) { $current = "" }
  $parts = $current.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries)
  if ($parts -contains $Directory) { return }
  [Environment]::SetEnvironmentVariable("Path", "$Directory;$current", "User")
}

$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$bunBin = Join-Path $homeDir ".bun\bin"
$uvBin = Join-Path $homeDir ".local\bin"
$env:Path = "$bunBin;$uvBin;$env:Path"

if (-not (Test-HasBun)) {
  Write-Host "Installing Bun $MinBun..."
  Invoke-RestMethod $BunInstallUrl | Invoke-Expression
  $env:Path = "$bunBin;$env:Path"
  if (-not (Test-HasBun)) {
    Fail 1 "error: Bun install finished but bun >= $MinBun is not on PATH"
  }
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host "Installing uv..."
  Invoke-RestMethod $UvInstallUrl | Invoke-Expression
  $env:Path = "$uvBin;$env:Path"
  if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Fail 1 "error: uv install finished but uv is not on PATH"
  }
}

$pythonOk = $false
try {
  uv python find 3.12 | Out-Null
  $pythonOk = $true
} catch { }
if (-not $pythonOk) {
  try {
    uv python find 3.11 | Out-Null
    $pythonOk = $true
  } catch { }
}
if (-not $pythonOk) {
  Write-Host "Installing Python 3.12 with uv..."
  uv python install 3.12
}

$cliRef = $CliPackage
$agentRef = $AgentPackage
if ($Version -ne "latest") {
  $cliRef = "$CliPackage@$Version"
  $agentRef = "$AgentPackage==$Version"
}

if (-not $NpmRegistry -or -not $PypiIndex) {
  Fail 1 "error: set DefaultNpmRegistry and DefaultPypiIndex at the top of this script before hosting, or export HARNESS_NPM_REGISTRY and UV_INDEX_URL."
}

Write-Host "Installing $cliRef from $NpmRegistry..."
bun install -g $cliRef --registry $NpmRegistry

Write-Host "Installing $agentRef from $PypiIndex..."
uv tool install $agentRef --index $PypiIndex

$env:Path = "$bunBin;$uvBin;$env:Path"
$harness = Get-Command harness -ErrorAction SilentlyContinue
if (-not $harness) {
  Fail 1 "error: harness --version failed after install"
}
try {
  harness --version | Out-Null
} catch {
  Fail 1 "error: harness --version failed after install"
}

if (-not $NoModifyPath) {
  Add-UserPath $bunBin
  Add-UserPath $uvBin
}

$exampleSrc = $env:HARNESS_EXAMPLE_CONFIG
if (-not $exampleSrc) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  if ($scriptDir) {
    $repoExample = Join-Path $scriptDir "..\..\docs\user\examples\config.toml"
    if (Test-Path $repoExample) { $exampleSrc = $repoExample }
  }
}
if (-not $exampleSrc) {
  $tmpExample = Join-Path $env:TEMP "harness-config.example.toml"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$($InstallBaseUrl.TrimEnd('/'))/examples/config.toml" -OutFile $tmpExample
    $exampleSrc = $tmpExample
  } catch { }
}

$configPath = Join-Path $homeDir ".harness\config.toml"
if (-not (Test-Path $configPath) -and $exampleSrc -and (Test-Path $exampleSrc)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $configPath) | Out-Null
  Copy-Item $exampleSrc $configPath
  Write-Host "Wrote example config to $configPath. Set HARNESS_API_KEY or edit the file; do not commit secrets."
} elseif (Test-Path $configPath) {
  Write-Host "Keeping existing $configPath"
}

Write-Host "Harness $Version installed. Run: harness"
Write-Host "If the command is not found, open a new terminal."
