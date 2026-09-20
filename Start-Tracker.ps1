[CmdletBinding()]
param(
    [switch]$Development,
    [switch]$NoBrowser,
    [ValidateRange(1024, 65535)][int]$Port = 3000,
    [ValidateRange(1024, 65535)][int]$ApiPort = 8000
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
if ($Port -eq $ApiPort) { throw 'The browser and API ports must differ.' }
# Refuse duplicate launches before npm ci can touch an active installation.
foreach ($requestedPort in @($Port, $ApiPort)) {
    $portProbe = [System.Net.Sockets.Socket]::new(
        [System.Net.Sockets.AddressFamily]::InterNetwork,
        [System.Net.Sockets.SocketType]::Stream,
        [System.Net.Sockets.ProtocolType]::Tcp
    )
    try {
        $portProbe.Bind([System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, $requestedPort))
    } catch {
        throw "Port $requestedPort is in use. Select another port; no existing process was stopped."
    } finally { $portProbe.Dispose() }
}
foreach ($requiredCommand in @('uv', 'node', 'npm')) {
    if (-not (Get-Command $requiredCommand -ErrorAction SilentlyContinue)) {
        throw "Install $requiredCommand before starting the tracker. See README.md."
    }
}

Push-Location $projectRoot
try {
    & uv sync --frozen
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency setup failed.' }
    Push-Location (Join-Path $projectRoot 'web')
    try {
        & npm ci --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'Web dependency setup failed.' }
        if (-not $Development) {
            & npm run build
            if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
        }
    } finally { Pop-Location }
    $launcherArgs = @('run', 'python', 'scripts/run_tracker.py', '--port', "$Port", '--api-port', "$ApiPort")
    if ($Development) { $launcherArgs += '--development' }
    if ($NoBrowser) { $launcherArgs += '--no-browser' }
    & uv @launcherArgs
    if ($LASTEXITCODE -ne 0) { throw "Tracker exited with code $LASTEXITCODE." }
} finally { Pop-Location }
