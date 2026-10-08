# Startup metadata for the explicitly owned test process and its WebView children only.
param([Parameter(Mandatory=$true)][int]$AppProcessId)
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process)
$owned = @($AppProcessId)
do {
    $next = @($processes | Where-Object { $_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned } | ForEach-Object { [int]$_.ProcessId })
    $owned += $next
} while ($next.Count -gt 0)
$root = Get-Process -Id $AppProcessId -ErrorAction SilentlyContinue
[pscustomobject]@{
    appProcessId = $AppProcessId
    responding = if ($root) { $root.Responding } else { $null }
    mainWindowTitle = if ($root) { $root.MainWindowTitle } else { $null }
    processes = @($processes | Where-Object { $_.ProcessId -in $owned } | ForEach-Object {
        [pscustomobject]@{
            id = $_.ProcessId
            parentId = $_.ParentProcessId
            name = $_.Name
            executable = $_.ExecutablePath
            # Retain only debugger configuration, never arbitrary process arguments.
            debugging = @([regex]::Matches($_.CommandLine, '--remote-debugging-(?:port|address)=[^\s"]+') | ForEach-Object { $_.Value })
        }
    })
} | ConvertTo-Json -Depth 4 -Compress
