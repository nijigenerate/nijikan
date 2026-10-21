param(
    [string]$NicxliveSource = (Join-Path $PSScriptRoot '../../nicxlive'),
    [string]$Emsdk = $env:EMSDK,
    [Parameter(Mandatory=$true)][string]$BoostInclude,
    [string]$BuildDirectory,
    [string]$CMake = 'cmake',
    [string]$Ninja = 'ninja'
)
$ErrorActionPreference = 'Stop'
$NicxliveSource = (Resolve-Path -LiteralPath $NicxliveSource).Path
if (!$Emsdk) { throw 'Specify -Emsdk or activate emsdk_env first.' }
$toolchain = Join-Path $Emsdk 'upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake'
if (!(Test-Path -LiteralPath $toolchain)) { throw "Missing Emscripten toolchain: $toolchain" }
$BoostInclude = (Resolve-Path -LiteralPath $BoostInclude).Path
if (!$BuildDirectory) { $BuildDirectory = Join-Path $NicxliveSource 'build-wasm-nijikan' }
& $CMake -S $NicxliveSource -B $BuildDirectory -G Ninja "-DCMAKE_MAKE_PROGRAM=$Ninja" "-DCMAKE_TOOLCHAIN_FILE=$toolchain" -DCMAKE_BUILD_TYPE=Release -DBUILD_WASM=ON -DNICXLIVE_BUILD_SHARED=OFF -DNICXLIVE_BUILD_TESTS=OFF -DBoost_NO_BOOST_CMAKE=ON "-DBoost_INCLUDE_DIR=$BoostInclude"
if ($LASTEXITCODE -ne 0) { throw 'WASM configure failed' }
& $CMake --build $BuildDirectory --target nicxlive_wasm --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'WASM build failed' }
$destination = Join-Path $PSScriptRoot '../wasm'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$files = @('nicxlive.js','nicxlive.wasm')
$hashes = @{}
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $BuildDirectory $file) -Destination (Join-Path $destination $file) -Force
    $hashes[$file] = (Get-FileHash -LiteralPath (Join-Path $destination $file) -Algorithm SHA256).Hash
}
Copy-Item -LiteralPath (Join-Path $NicxliveSource 'LICENSE') -Destination (Join-Path $destination 'LICENSE.nicxlive') -Force
$revision = & git -C $NicxliveSource rev-parse HEAD
$dirty = [bool](& git -C $NicxliveSource status --porcelain --untracked-files=no)
@{ revision=$revision; sourceModified=$dirty; sha256=$hashes } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $destination 'build-info.json') -Encoding UTF8
Write-Output "Installed nicxlive.js and nicxlive.wasm in $destination"
