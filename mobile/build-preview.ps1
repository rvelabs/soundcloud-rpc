param([ValidateSet('x86_64', 'aarch64')][string]$Target = 'x86_64')

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $root = (Get-Location).ProviderPath
    $localTools = Join-Path (Split-Path (Split-Path $root -Parent) -Parent) 'rust-tools'
    if (!(Get-Command rustup -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $localTools 'cargo/bin/rustup.exe'))) {
        $env:CARGO_HOME = Join-Path $localTools 'cargo'
        $env:RUSTUP_HOME = Join-Path $localTools 'rustup'
        $env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH
    }
    foreach ($key in @('ANDROID_HOME', 'NDK_HOME', 'JAVA_HOME')) {
        if (!(Test-Path "Env:$key")) {
            $value = [Environment]::GetEnvironmentVariable($key, 'User')
            if ($value) { Set-Item "Env:$key" $value }
        }
    }
    $cli = Join-Path $root 'node_modules/@tauri-apps/cli/tauri.js'
    if (!(Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Run npm ci in mobile first.' }
    $linkBlocked = $false
    & node $cli android build --ci --debug --apk --target $Target 2>&1 | ForEach-Object {
        if ("$_" -match 'Creation symbolic link is not allowed') { $linkBlocked = $true }
        Write-Host $_
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) { return }
    if (!$linkBlocked) { exit $exitCode }

    $abi = if ($Target -eq 'aarch64') { 'arm64-v8a' } else { 'x86_64' }
    $flavor = if ($Target -eq 'aarch64') { 'Arm64' } else { 'X86_64' }
    $library = "libsoundcloud_mobile_lib.so"
    $source = Join-Path $root "target/$Target-linux-android/debug/$library"
    $destination = New-Item -ItemType Directory -Force -Path (Join-Path $root "gen/android/app/src/main/jniLibs/$abi")
    Copy-Item -LiteralPath $source -Destination $destination.FullName -Force
    & ./gen/android/gradlew.bat -p gen/android ":app:assemble${flavor}Debug" -x ":app:rustBuild${flavor}Debug" --console=plain
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
