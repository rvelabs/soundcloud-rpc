param([ValidateSet('x86_64', 'aarch64')][string]$Target = 'aarch64')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$localTools = Join-Path (Split-Path $root -Parent) 'rust-tools'
if (!(Get-Command cargo -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $localTools 'cargo/bin/cargo.exe'))) {
    $env:CARGO_HOME = Join-Path $localTools 'cargo'
    $env:RUSTUP_HOME = Join-Path $localTools 'rustup'
    $env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH
}
foreach ($key in @('ANDROID_HOME','NDK_HOME','JAVA_HOME')) {
    if (!(Test-Path "Env:$key")) { $value = [Environment]::GetEnvironmentVariable($key,'User'); if ($value) { Set-Item "Env:$key" $value } }
}
& node (Join-Path $root 'scripts/build-android.cjs') --target $Target
exit $LASTEXITCODE
