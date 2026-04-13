# Cross-build Linux vpn-agent binaries into vpn-api/bin/ (for local vpn-api download endpoint).
# Run from anywhere:  powershell -File vpn-api/scripts/build-agents.ps1
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
Set-Location $Root
$Out = Join-Path $Root "bin"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$env:CGO_ENABLED = "0"
$env:GOOS = "linux"
$env:GOARCH = "amd64"
go build -o (Join-Path $Out "vpn-agent-linux-amd64") ./cmd/agent
$env:GOARCH = "arm64"
go build -o (Join-Path $Out "vpn-agent-linux-arm64") ./cmd/agent
Write-Host "OK: built into $Out"
