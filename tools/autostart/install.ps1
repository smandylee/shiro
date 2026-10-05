# Registers what keeps Shiro alive on this PC with the Windows Task Scheduler.
#
#   powershell -ExecutionPolicy Bypass -File tools\autostart\install.ps1
#   powershell -ExecutionPolicy Bypass -File tools\autostart\install.ps1 -Remove
#
# Three tasks, all under \Shiro\ so they are easy to find and to remove:
#
#   Up            at logon: the tunnel, the dev worker and the avatar
#                 (tools/autostart/shiro-up.ps1)
#   JobSpy-0900   the job crawler, every day at 09:00
#   JobSpy-2100   the same, every day at 21:00
#
# Everything runs as the signed-in user, only while signed in, without admin
# rights and without storing a password. Safe to run again: it replaces the
# tasks with the same names.
param([switch]$Remove)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Folder = "\Shiro\"
$TaskNames = @("Up", "JobSpy-0900", "JobSpy-2100")

if ($Remove) {
    foreach ($name in $TaskNames) {
        Unregister-ScheduledTask -TaskName $name -TaskPath $Folder -Confirm:$false -ErrorAction SilentlyContinue
    }
    Write-Output "제거했어: $($TaskNames -join ', ')"
    exit 0
}

$user = "$env:USERDOMAIN\$env:USERNAME"
# Interactive: runs when this user is signed in, which is when the avatar and a
# browser session exist. It needs no password and cannot touch other accounts.
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

# --- Up -----------------------------------------------------------------------
$upScript = Join-Path $Root "tools\autostart\shiro-up.ps1"
if (-not (Test-Path $upScript)) { throw "shiro-up.ps1 이 없어: $upScript" }

$upAction = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$upScript`"" `
    -WorkingDirectory $Root
$upTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
# No time limit — it is meant to run for as long as the PC is on. If it dies it
# is started again; a second copy that finds the first one running just exits.
$upSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "Up" -TaskPath $Folder -Action $upAction -Trigger $upTrigger `
    -Settings $upSettings -Principal $principal -Force `
    -Description "Shiro: SSH tunnel to the server, dev worker and avatar, from logon on." | Out-Null
Write-Output "등록: \Shiro\Up  (로그온 때)"

# --- Job crawler --------------------------------------------------------------
$jobDir = Join-Path $Root "tools\jobspy"
# pythonw, not python: no console window popping up twice a day. The crawler
# writes its own crawl.log, so nothing is lost by having no console.
$python = Join-Path $jobDir "venv\Scripts\pythonw.exe"
if (-not (Test-Path $python)) {
    throw "크롤러 venv 가 없어: $python  (tools\jobspy\README.md 의 설치 단계를 먼저 해줘)"
}

foreach ($slot in @(@{ Name = "JobSpy-0900"; At = "09:00" }, @{ Name = "JobSpy-2100"; At = "21:00" })) {
    $action = New-ScheduledTaskAction -Execute $python -Argument "crawl.py" -WorkingDirectory $jobDir
    $trigger = New-ScheduledTaskTrigger -Daily -At $slot.At
    # StartWhenAvailable: a PC that was off at 09:00 runs it when it comes back,
    # instead of skipping the day. The limit stops a hung scrape from lingering.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $slot.Name -TaskPath $Folder -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force `
        -Description "Shiro: collect Hong Kong job postings (public search, no login) at $($slot.At)." | Out-Null
    Write-Output "등록: \Shiro\$($slot.Name)  (매일 $($slot.At))"
}

Write-Output ""
Write-Output "끝. 지금 바로 띄우려면:  Start-ScheduledTask -TaskPath '\Shiro\' -TaskName 'Up'"
