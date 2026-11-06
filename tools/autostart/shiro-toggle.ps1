# One click to turn Shiro's avatar on this PC off, and the same click to turn it back on.
#
#   powershell -ExecutionPolicy Bypass -File tools\autostart\shiro-toggle.ps1                    toggle
#   powershell -ExecutionPolicy Bypass -File tools\autostart\shiro-toggle.ps1 -Action Off        only off
#   powershell -ExecutionPolicy Bypass -File tools\autostart\shiro-toggle.ps1 -Action On         only on
#   powershell -ExecutionPolicy Bypass -File tools\autostart\shiro-toggle.ps1 -InstallShortcut   put a shortcut on the Desktop
#   powershell -ExecutionPolicy Bypass -File tools\autostart\shiro-toggle.ps1 -DryRun            say what it would do, do nothing
#
# Only the avatar window goes away. The tunnel to the server and the dev worker (shiro-up.ps1)
# keep running, so the server still reaches this PC and dev requests still work; the avatar,
# started once and then left alone by shiro-up.ps1, stays closed until this turns it on again.
# The server's Shiro is not touched either: she keeps answering in Discord, just without a body.
param(
    [ValidateSet("Toggle", "On", "Off")][string]$Action = "Toggle",
    [switch]$InstallShortcut,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$AvatarDir = Join-Path $Root "avatar"
# Absolute path: a shortcut does not always have the PATH a terminal has.
$Npm = "C:\Program Files\nodejs\npm.cmd"

if ($InstallShortcut) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $link = Join-Path $desktop "시로 켜기-끄기.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($link)
    $sc.TargetPath = "powershell.exe"
    $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    $sc.WorkingDirectory = $Root
    $sc.Description = "Shiro avatar: on / off"
    $sc.WindowStyle = 7  # minimized: no console flash
    $sc.Save()
    Write-Output "바탕화면에 만들었어: $link"
    exit 0
}

function Get-AvatarProcesses {
    # Every Electron process of this checkout (main, GPU, renderer); other Electron apps are left alone.
    @(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$AvatarDir\*" })
}

function Show-Note([string]$Text) {
    # A balloon in the corner for a few seconds, so the click is answered. Never worth failing over.
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $icon = New-Object System.Windows.Forms.NotifyIcon
        $icon.Icon = [System.Drawing.SystemIcons]::Information
        $icon.Visible = $true
        $icon.ShowBalloonTip(3000, "시로", $Text, [System.Windows.Forms.ToolTipIcon]::None)
        Start-Sleep -Seconds 4
        $icon.Dispose()
    } catch { }
}

function Stop-Avatar {
    $procs = Get-AvatarProcesses
    # Ask the window to close first (it can save where she was standing), then make sure.
    foreach ($p in $procs) { try { [void]$p.CloseMainWindow() } catch { } }
    Start-Sleep -Seconds 3
    foreach ($p in Get-AvatarProcesses) { try { $p.Kill() } catch { } }
}

function Start-Avatar {
    # If the "Up" task is not running (it was stopped, or never installed), starting it brings up the
    # tunnel and the worker as well as the avatar. If it is running, only the avatar is missing.
    $up = Get-ScheduledTask -TaskPath "\Shiro\" -TaskName "Up" -ErrorAction SilentlyContinue
    if ($up -and $up.State -ne "Running") {
        Start-ScheduledTask -TaskPath "\Shiro\" -TaskName "Up"
    } else {
        Start-Process -FilePath $Npm -ArgumentList "start" -WorkingDirectory $AvatarDir -WindowStyle Hidden | Out-Null
    }
}

$running = (Get-AvatarProcesses).Count -gt 0
$want = switch ($Action) {
    "On" { "on" }
    "Off" { "off" }
    default { if ($running) { "off" } else { "on" } }
}

if ($DryRun) {
    Write-Output ("아바타 {0}. 하려는 일: {1}" -f $(if ($running) { "켜져 있음" } else { "꺼져 있음" }), $(if ($want -eq "off") { "끈다" } else { "켠다" }))
    exit 0
}

if ($want -eq "off") {
    if (-not $running) { Show-Note "이미 꺼져 있어."; exit 0 }
    Stop-Avatar
    Show-Note "아바타를 껐어."
} else {
    if ($running) { Show-Note "이미 켜져 있어."; exit 0 }
    Start-Avatar
    Show-Note "아바타를 켰어. 잠깐만 기다려줘."
}
