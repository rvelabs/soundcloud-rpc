param([ValidateSet('check','test','build','bundle','run','smoke','probe','verify')][string]$Action='check')
$ErrorActionPreference='Stop'
$repoRoot=Split-Path $PSScriptRoot -Parent
$taskTools=Join-Path (Split-Path $repoRoot -Parent) 'rust-tools'
if(Test-Path -LiteralPath (Join-Path $taskTools 'cargo/bin/cargo.exe')) {
    $env:CARGO_HOME=Join-Path $taskTools 'cargo'
    $env:RUSTUP_HOME=Join-Path $taskTools 'rustup'
    $env:PATH=(Join-Path $env:CARGO_HOME 'bin')+';'+$env:PATH
}
Push-Location $repoRoot
try {
    if($Action -eq 'verify') {
        node scripts/check-native-package.cjs
        if($LASTEXITCODE -ne 0){throw 'Native package verification failed'}
        $global:LASTEXITCODE=0
        return
    }
    if($Action -in @('check','test','build','bundle')) {
        node scripts/build-native.cjs
        if($LASTEXITCODE -ne 0){throw 'Native frontend build failed'}
        node node_modules/typescript/bin/tsc -p native/tsconfig.json --pretty false
        if($LASTEXITCODE -ne 0){throw 'Native frontend types failed'}
        if($Action -eq 'check'){cargo --config native/.cargo/config.toml check --locked --manifest-path native/Cargo.toml}
        elseif($Action -eq 'test'){
            node node_modules/vitest/vitest.mjs run --config native/vitest.config.ts
            if($LASTEXITCODE -ne 0){throw 'Native frontend tests failed'}
            cargo --config native/.cargo/config.toml test --locked --manifest-path native/Cargo.toml
        }
        elseif($Action -eq 'bundle'){
            node scripts/bundle-native.cjs
        }
        else{cargo --config native/.cargo/config.toml build --locked --release --manifest-path native/Cargo.toml}
        if($LASTEXITCODE -ne 0){throw 'Rust validation failed'}
        if($Action -eq 'build'){Copy-Item -LiteralPath (Join-Path $repoRoot 'native/target/x86_64-pc-windows-msvc/release/soundcloud-native.exe') -Destination (Join-Path $repoRoot 'native/target/x86_64-pc-windows-msvc/release/SoundCloud.exe') -Force}
        $global:LASTEXITCODE=0
        return
    }
    $executable=Join-Path $repoRoot 'native/target/x86_64-pc-windows-msvc/release/SoundCloud.exe'
    if($env:SOUNDCLOUD_NATIVE_TEST_DEBUG -eq '1' -and $Action -in @('smoke','probe')){$executable=Join-Path $repoRoot 'native/target/x86_64-pc-windows-msvc/debug/soundcloud-native.exe'}
    if($env:SOUNDCLOUD_NATIVE_TEST_EXE -and $Action -in @('smoke','probe')){$executable=(Resolve-Path -LiteralPath $env:SOUNDCLOUD_NATIVE_TEST_EXE).Path}
    if(!(Test-Path -LiteralPath $executable)){throw 'Build the native executable first: npm run native:build'}
    if($Action -eq 'run'){Start-Process -FilePath $executable -WindowStyle Hidden; $global:LASTEXITCODE=0; return}
    $output=Join-Path $repoRoot ('build-native-validation/'+$Action+'-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    $flag=if($Action -eq 'smoke'){'--smoke-test'}else{'--probe'}
    $process=Start-Process -FilePath $executable -ArgumentList @($flag,'--profile',('"'+$output+'"')) -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $output 'stderr.log') -RedirectStandardOutput (Join-Path $output 'stdout.log')
    if(!$process.WaitForExit(65000)){$process.Kill(); throw 'Native integration check timed out'}
    $report=Join-Path $output 'smoke-result.json'
    $process.Refresh()
    if(!(Test-Path -LiteralPath $report)){Get-Content -LiteralPath (Join-Path $output 'stderr.log'); throw 'Native integration produced no report'}
    $result=Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    Get-Content -LiteralPath $report
    if(!$result.success -or ($null -ne $process.ExitCode -and $process.ExitCode -ne 0)){Get-Content -LiteralPath (Join-Path $output 'stderr.log'); throw ('Native integration check failed: '+$process.ExitCode)}
    if($Action -eq 'smoke' -and !$result.closedThroughWindow){throw 'Native window close did not complete application shutdown'}
    Write-Output ('Report: '+$report)
    $global:LASTEXITCODE=0
} finally {Pop-Location}
