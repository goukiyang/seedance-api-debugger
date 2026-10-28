param([int]$Port = 3313)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $taskRoot
$database = Join-Path $taskRoot 'storage/comfy03-isolated/site.db'
if (-not (Test-Path -LiteralPath $database)) { throw 'Run python scripts/comfy03-setup.py first.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid port.' }
$env:COMFY03_ENVIRONMENT = 'isolated-test'
$env:DATABASE_URL = 'file:' + $database.Replace('\', '/')
$env:NEXT_DIST_DIR = '.next-dev'
$env:NEXT_TELEMETRY_DISABLED = '1'
# Foreground console is intentional for this user-run script. Only loopback is bound.
node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port $Port
