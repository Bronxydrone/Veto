# Build the veto-policy contract wasm and copy it into res/.
#
#   pwsh -File .\build.ps1            # build + copy
#   pwsh -File .\build.ps1 -NoCopy    # build only
#
# The script keeps the toolchain state inside the workspace when the local
# .tools/ checkout is present (CARGO_HOME/RUSTUP_HOME are read-only in some
# sandboxes), then runs:
#
#   cargo build --release --target wasm32-unknown-unknown
#   copy target\wasm32-unknown-unknown\release\veto_policy.wasm res\veto_policy.wasm
#
# Requirements: rustc 1.93+ (near-sdk 5.29 needs edition 2024 support) and the
# wasm32-unknown-unknown target:
#   rustup target add wasm32-unknown-unknown
#
# The wasm build needs no C toolchain. (Only `cargo test` does, because the
# near-sdk `unit-testing` feature compiles C code.)

[CmdletBinding()]
param(
    [switch]$NoCopy
)

$ErrorActionPreference = 'Stop'

$ContractDir  = $PSScriptRoot
$VetoDir      = Split-Path -Parent $ContractDir
$WorkspaceDir = Split-Path -Parent $VetoDir
$ToolsDir     = Join-Path $WorkspaceDir '.tools'

# --- toolchain environment -------------------------------------------------
$localCargoHome  = Join-Path $ToolsDir 'cargo'
$localRustupHome = Join-Path $ToolsDir 'rustup'

if (Test-Path $localCargoHome) {
    $env:CARGO_HOME = $localCargoHome
    Write-Host "CARGO_HOME  = $($env:CARGO_HOME)"
}
if (Test-Path $localRustupHome) {
    $env:RUSTUP_HOME = $localRustupHome
    Write-Host "RUSTUP_HOME = $($env:RUSTUP_HOME)"
}

$cargo = 'cargo'
$localCargo = Join-Path $env:CARGO_HOME 'bin\cargo.exe'
if ($env:CARGO_HOME -and (Test-Path $localCargo)) {
    $cargo = $localCargo
}
Write-Host "cargo       = $cargo"

$targetWasm = Join-Path $ContractDir 'target\wasm32-unknown-unknown\release\veto_policy.wasm'
$outDir     = Join-Path $ContractDir 'res'
$outWasm    = Join-Path $outDir 'veto_policy.wasm'

# --- build -----------------------------------------------------------------
Push-Location $ContractDir
try {
    Write-Host ''
    Write-Host "cargo build --release --target wasm32-unknown-unknown"
    & $cargo build --release --target wasm32-unknown-unknown
    if ($LASTEXITCODE -ne 0) {
        throw "cargo build failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

if (-not (Test-Path $targetWasm)) {
    throw "build finished but $targetWasm does not exist"
}

# --- copy ------------------------------------------------------------------
if (-not $NoCopy) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    Copy-Item -Path $targetWasm -Destination $outWasm -Force
}

$artifact = if ($NoCopy) { $targetWasm } else { $outWasm }
$size     = (Get-Item $artifact).Length
$hash     = (Get-FileHash -Path $artifact -Algorithm SHA256).Hash.ToLowerInvariant()

Write-Host ''
Write-Host "wasm   : $artifact"
Write-Host "bytes  : $size"
Write-Host "sha256 : $hash"
Write-Host ''
Write-Host "deploy : near deploy <account>.testnet res/veto_policy.wasm --accountId <account>.testnet"
