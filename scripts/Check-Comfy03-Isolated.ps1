$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $taskRoot
$database = Join-Path $taskRoot 'storage/comfy03-isolated/site.db'
if (-not (Test-Path -LiteralPath $database)) { throw 'Run python scripts/comfy03-setup.py first.' }
$env:COMFY03_ENVIRONMENT = 'isolated-test'
$env:DATABASE_URL = 'file:' + $database.Replace('\', '/')
node --require ./scripts/server-runtime.cjs --import tsx scripts/comfy03-check.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node --require ./scripts/server-runtime.cjs --import tsx scripts/comfy03-worker-check.ts
exit $LASTEXITCODE
