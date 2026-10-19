# Run the contract's unit tests (near-sdk mocked blockchain, no node needed).
#
#   pwsh -File .\test.ps1
#
# The tests need a HOST C toolchain, because near-sdk's "unit-testing" feature
# compiles C code (aws-lc-sys, blst, secp256k1-sys, zstd-sys). The wasm build does
# not need one. On Linux/macOS that is just `build-essential`/`xcode-select
# --install`; on Windows install mingw-w64 (or LLVM/clang) plus cmake and nasm,
# then set CC/AR (this script honours CC/AR/CMAKE if you do).
#
# This script sets CARGO_HOME/RUSTUP_HOME to the workspace-local .tools checkout
# when present, so it also works in sandboxes where the real profile is read-only.

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CargoArgs
)

$ErrorActionPreference = 'Stop'

$ContractDir  = $PSScriptRoot
$VetoDir      = Split-Path -Parent $ContractDir
$WorkspaceDir = Split-Path -Parent $VetoDir
$ToolsDir     = Join-Path $WorkspaceDir '.tools'

$localCargoHome  = Join-Path $ToolsDir 'cargo'
$localRustupHome = Join-Path $ToolsDir 'rustup'

if (Test-Path $localCargoHome)  { $env:CARGO_HOME  = $localCargoHome }
if (Test-Path $localRustupHome) { $env:RUSTUP_HOME = $localRustupHome }

$cargo = 'cargo'
$localCargo = Join-Path $env:CARGO_HOME 'bin\cargo.exe'
if ($env:CARGO_HOME -and (Test-Path $localCargo)) { $cargo = $localCargo }

# --- warn (do not fail) when no C toolchain is visible ----------------------
$cc = $null
if ($env:CC) {
    $cc = $env:CC
}
else {
    foreach ($candidate in @('cc', 'gcc', 'clang')) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($cmd) { $cc = $cmd.Source; break }
    }
}
if ($cc) {
    Write-Host "CC          = $cc"
}
else {
    Write-Warning 'No C compiler ($env:CC / cc / gcc / clang) found. near-sdk''s `unit-testing` feature compiles C code (aws-lc-sys, blst, secp256k1-sys, zstd-sys), so a fresh `cargo test` build will fail. Install mingw-w64 or clang + cmake + nasm, or run the tests where a C toolchain exists. Existing build artifacts still run.'
}

Write-Host "cargo       = $cargo"
Write-Host ''

Push-Location $ContractDir
try {
    & $cargo test @CargoArgs
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host "cargo test exit code: $code"
exit $code
