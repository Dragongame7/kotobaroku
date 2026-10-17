$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath 'node_modules')) { & npm.cmd install; if ($LASTEXITCODE -ne 0) { throw 'npm install failed' } }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
& npm.cmd start
