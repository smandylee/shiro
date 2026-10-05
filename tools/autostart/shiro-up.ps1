# Bringing Shiro up on this PC, and keeping the parts that drop alive.
#
# Everything on this machine that talks to her depends on three things being
# there at once: a tunnel to the server (the bridge only listens on the
# server's Tailscale address, and Tailscale itself does not let this PC reach
# it), the dev worker, and the avatar. Each used to be started by hand, so a
# restart of the PC quietly cut her off — crawled job postings piled up in
# output/, dev requests had nowhere to go, and nobody noticed.
#
# Run at logon by the "Shiro Up" scheduled task (tools/autostart/install.ps1),
# or by hand: it is safe to run twice, the second copy just exits.
#
#   tunnel      kept alive: restarted when it drops
#   dev worker  kept alive: restarted when it exits (it has no window to close)
#   avatar      started once and then left alone — if the owner closes it, that
#               was on purpose, and it coming back would be worse than not
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$AvatarDir = Join-Path $Root "avatar"
$LogPath = Join-Path $PSScriptRoot "shiro-up.log"
$LogMaxBytes = 200KB

# Absolute paths: a task at logon does not always have the PATH a terminal has.
$Ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
$Node = "C:\Program Files\nodejs\node.exe"
$Npm = "C:\Program Files\nodejs\npm.cmd"

# Local port the avatar and the worker connect to (avatar/config.json bridgeUrl),
# and where the bridge actually is, as seen from the server itself.
$BridgePort = 18790
$BridgeTarget = "100.87.102.46:18790"

$CheckEverySeconds = 20
$RetryMin = 5
$RetryMax = 120

function Write-Log([string]$Message) {
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    try {
        if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt $LogMaxBytes)) { Clear-Content $LogPath }
        Add-Content -Path $LogPath -Value $line -Encoding UTF8
    } catch {
        # logging must never stop her coming up
    }
}

# One copy at a time. The mutex has to stay referenced for as long as we run.
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\ShiroUp", [ref]$createdNew)
if (-not $createdNew) {
    Write-Log "이미 돌고 있어서 이 복사본은 그냥 끝낸다"
    exit 0
}

# Same settings file the deploy and re-authorization tools use.
try {
    $config = Get-Content (Join-Path $AvatarDir "config.json") -Raw | ConvertFrom-Json
} catch {
    Write-Log "avatar/config.json 을 읽지 못했다: $($_.Exception.Message)"
    exit 1
}
$HostName = $config.deployHost
$Key = $config.deployKeyPath
if (-not $HostName -or -not $Key) {
    Write-Log "config.json 에 deployHost / deployKeyPath 가 없어서 터널을 못 연다"
    exit 1
}

function Test-BridgePortOpen {
    [bool](Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue)
}

function Start-Tunnel {
    $sshArgs = @(
        "-N",
        "-i", "`"$Key`"",
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-o", "ConnectTimeout=15",
        "-L", "127.0.0.1:${BridgePort}:${BridgeTarget}",
        $HostName
    ) -join " "
    Start-Process -FilePath $Ssh -ArgumentList $sshArgs -WindowStyle Hidden -PassThru
}

function Start-DevWorker {
    Start-Process -FilePath $Node -ArgumentList "devworker.js" -WorkingDirectory $AvatarDir -WindowStyle Hidden -PassThru
}

function Test-AvatarRunning {
    [bool](Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$AvatarDir\*" })
}

$tunnel = $null
$worker = $null
$tunnelFailures = 0
$tunnelRetryAt = Get-Date
$workerFailures = 0
$workerRetryAt = Get-Date

Write-Log "시작 (루트 $Root)"

try {
    # The avatar goes first and only once; it reconnects on its own as soon as
    # the tunnel is there, so there is no need to wait for it.
    if (Test-AvatarRunning) {
        Write-Log "아바타는 이미 떠 있다"
    } else {
        Start-Process -FilePath $Npm -ArgumentList "start" -WorkingDirectory $AvatarDir -WindowStyle Hidden | Out-Null
        Write-Log "아바타를 켰다"
    }

    while ($true) {
        $now = Get-Date

        # A tunnel somebody opened by hand is as good as ours.
        if (-not $tunnel -and (Test-BridgePortOpen)) {
            # leave it alone
        } elseif ((-not $tunnel -or $tunnel.HasExited) -and $now -ge $tunnelRetryAt) {
            if ($tunnel) {
                $tunnelFailures++
                Write-Log "터널이 끊겼다 (종료 코드 $($tunnel.ExitCode), 연속 $tunnelFailures 번)"
            }
            $tunnel = Start-Tunnel
            $delay = [Math]::Min($RetryMax, $RetryMin * [Math]::Pow(2, [Math]::Min($tunnelFailures, 5)))
            $tunnelRetryAt = $now.AddSeconds($delay)
            Write-Log "터널을 열었다 (PID $($tunnel.Id))"
        } elseif ($tunnel -and -not $tunnel.HasExited -and (Test-BridgePortOpen)) {
            # up and listening: forget old failures so the next drop retries quickly
            $tunnelFailures = 0
        }

        if ((-not $worker -or $worker.HasExited) -and $now -ge $workerRetryAt) {
            if ($worker) {
                $workerFailures++
                Write-Log "개발 워커가 멈췄다 (종료 코드 $($worker.ExitCode), 연속 $workerFailures 번)"
            }
            $worker = Start-DevWorker
            $delay = [Math]::Min($RetryMax, $RetryMin * [Math]::Pow(2, [Math]::Min($workerFailures, 5)))
            $workerRetryAt = $now.AddSeconds($delay)
            Write-Log "개발 워커를 띄웠다 (PID $($worker.Id))"
        } elseif ($worker -and -not $worker.HasExited -and ((Get-Date) - $worker.StartTime).TotalSeconds -gt 60) {
            $workerFailures = 0
        }

        Start-Sleep -Seconds $CheckEverySeconds
    }
} finally {
    # Taking the task down should not leave a tunnel and a worker behind with
    # nothing watching them.
    foreach ($child in @($tunnel, $worker)) {
        if ($child -and -not $child.HasExited) {
            try { $child.Kill() } catch { }
        }
    }
    Write-Log "멈췄다"
    $mutex.ReleaseMutex()
}
