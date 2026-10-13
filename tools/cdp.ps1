# Evaluate JavaScript in the running Spotify renderer over the Chrome DevTools
# Protocol. Spotify must run with --remote-debugging-port=9222
# (spicetify config spotify_launch_flags).
#
#   .\tools\cdp.ps1 -Expr "Spicetify.Player.data.item.uri"
#   .\tools\cdp.ps1 -Hover ".playerfx-info" -Expr "document.body.innerText.length"
#
# -Hover moves a trusted mouse onto the element first, which Spotify's
# tooltips need; synthetic DOM events don't open them.
param(
    [Parameter(Mandatory = $true)][string]$Expr,
    [string]$Hover,
    [int]$WaitMs = 800,
    [int]$Port = 9222
)

$ErrorActionPreference = "Stop"
$targets = Invoke-RestMethod "http://localhost:$Port/json"
$page = $targets | Where-Object { $_.type -eq "page" -and $_.url -like "*xpui*" } | Select-Object -First 1
if (-not $page) { $page = $targets | Where-Object { $_.type -eq "page" } | Select-Object -First 1 }
if (-not $page) { throw "No page target found on port $Port" }

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$cts = New-Object System.Threading.CancellationTokenSource
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $cts.Token).Wait()
$script:id = 0

function Send-Cdp($method, $params) {
    $script:id++
    $msg = @{ id = $script:id; method = $method; params = $params } | ConvertTo-Json -Compress -Depth 6
    $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
    $ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).Wait()
    $buf = New-Object byte[] 262144
    while ($true) {
        $sb = New-Object Text.StringBuilder
        do {
            $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), $cts.Token).Result
            $sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)) | Out-Null
        } while (-not $res.EndOfMessage)
        $reply = $sb.ToString() | ConvertFrom-Json
        if ($reply.id -eq $script:id) { return $reply }
    }
}

if ($Hover) {
    $rect = Send-Cdp "Runtime.evaluate" @{ expression = "(() => { const e = document.querySelector('$Hover'); if (!e) return 'none'; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()"; returnByValue = $true }
    if ($rect.result.result.value -eq "none") { throw "No element matches $Hover" }
    $pt = $rect.result.result.value | ConvertFrom-Json
    Send-Cdp "Input.dispatchMouseEvent" @{ type = "mouseMoved"; x = [double]($pt.x - 30); y = [double]($pt.y - 10) } | Out-Null
    Start-Sleep -Milliseconds 120
    Send-Cdp "Input.dispatchMouseEvent" @{ type = "mouseMoved"; x = [double]$pt.x; y = [double]$pt.y } | Out-Null
    Start-Sleep -Milliseconds $WaitMs
}

$out = Send-Cdp "Runtime.evaluate" @{ expression = $Expr; awaitPromise = $true; returnByValue = $true }
$ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "", $cts.Token).Wait()
if ($out.result.exceptionDetails) { Write-Output "EXCEPTION: $($out.result.exceptionDetails.exception.description)" }
$out.result.result | ConvertTo-Json -Depth 8
