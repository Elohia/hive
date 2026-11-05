<#
.SYNOPSIS
  注册 / 卸载 HIVE 守护进程的 Windows 计划任务（隐藏窗口、失败自动重启、幂等）。

.DESCRIPTION
  做法参考 D:\pi-agent\scripts\run_hidden.vbs：计划任务 → wscript.exe 跑一个 VBS，
  VBS 用 `sh.Run "cmd /c ""stub.cmd""", 0, True` 以窗口隐藏方式启动真正的 cmd 存根，
  存根里 cd 到项目目录，用 node 跑 `scripts\hive.mjs daemon` 并把输出重定向到日志。

  为什么不用 `-WindowStyle Hidden` 直接跑 node：
    · 计划任务里 node 的控制台窗口会一闪而过（并且 daemon 被 kill 时容易留残留窗口）；
    · wscript 隐藏启动是 Windows 上最稳的「无窗口常驻」做法，本机 pi-agent 的 20+ 条自动化已在用。
    · 同时 VBS 的 bWaitOnReturn=True 保住任务计划器的 IgnoreNew/错误码语义。

  幂等：重复执行会用 -Force 覆盖同名任务、按内容比对重写启动器文件（内容没变就不落盘）。

.PARAMETER Name
  计划任务名，默认 HIVE-daemon。

.PARAMETER Root
  HIVE 项目根，默认本脚本所在目录的父目录（即 D:\hive）。

.PARAMETER AtStartup
  用「开机启动」而不是默认的「当前用户登录时启动」。
  注意：本项目要读用户级凭据（F:\dsh-home\.credentials.yaml，DPAPI/用户目录）与用户级 npm 全局命令，
  所以默认是「登录时启动 + 交互式令牌」；开机启动在某些机器上会因无用户会话而读不到凭据。

.PARAMETER Start
  注册后立即启动一次，并等 6 秒回显任务状态 / 守护进程 pid。

.PARAMETER Uninstall
  卸载：停止并删除计划任务 + 杀掉 daemon 进程 + 删除启动器文件（-KeepLauncher 可保留）。

.PARAMETER KeepLauncher
  卸载时保留 data\work\hidden\ 下的启动器（便于人工手动启动）。

.PARAMETER DryRun
  只做检查与打印，不写文件、不注册任务（给 CI / 复核用）。

.PARAMETER Help
  显示本帮助。

.EXAMPLE
  pwsh -File scripts\install-task.ps1
  pwsh -File scripts\install-task.ps1 -Start
  pwsh -File scripts\install-task.ps1 -Uninstall
  pwsh -File scripts\install-task.ps1 -DryRun

.NOTES
  退出码：0 = 成功；1 = 失败；2 = 参数错误。
  需要：Windows 10/11 + 计划任务服务 + node 在 PATH 里。
#>
[CmdletBinding()]
param(
  [string]$Name = 'HIVE-daemon',
  # 注意：不能把参数叫 -Home，$HOME 是 PowerShell 只读自动变量（大小写不敏感），会直接报错。
  [Alias('Home','HomeDir')]
  [string]$Root = '',
  [switch]$AtStartup,
  [switch]$Start,
  [switch]$Uninstall,
  [switch]$KeepLauncher,
  [switch]$DryRun,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$script:ExitCode = 0
function Fail($msg, $code = 1) { Write-Host "✗ $msg" -ForegroundColor Red; $script:ExitCode = $code }
function Info($msg) { Write-Host $msg }
function Ok($msg) { Write-Host "✓ $msg" -ForegroundColor Green }

if ($Help) {
  Get-Help $PSCommandPath -Detailed | Out-String | Write-Host
  exit 0
}

# ---------------------------------------------------------------- 解析路径
$projRoot = if ($Root) { [IO.Path]::GetFullPath($Root) } else { Split-Path -Parent $PSScriptRoot }
$hiveCli = Join-Path $projRoot 'scripts\hive.mjs'
$hiddenDir = Join-Path $projRoot 'data\work\hidden'
$stubPath = Join-Path $hiddenDir 'hive-daemon.cmd'
$vbsPath = Join-Path $hiddenDir 'run_hidden.vbs'
$nullLog = Join-Path $projRoot 'data\logs\daemon.stdout.log'

if (-not (Test-Path $hiveCli)) {
  Fail "找不到 $hiveCli（-Root 指错？）" 2
  exit 2
}
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $nodeExe) {
  Fail 'PATH 里没有 node.exe，先装 Node 24 并确保 where node 能找到' 2
  exit 2
}

# ---------------------------------------------------------------- 启动器内容
$stubBody = @"
@echo off
rem —— HIVE daemon 存根（由 scripts/install-task.ps1 生成，勿手改；改完重跑一次即可）——
chcp 65001 >nul
cd /d "$projRoot"
if not exist "$($projRoot)\data\logs" mkdir "$($projRoot)\data\logs"
"$nodeExe" --no-warnings "$hiveCli" daemon >> "$nullLog" 2>&1
exit /b %errorlevel%
"@ -replace "`r`n", "`n"

# 与 D:\pi-agent\scripts\run_hidden.vbs 同一套做法：窗口隐藏 + 等返回
$vbsBody = @"
'run_hidden.vbs — silent launcher for Scheduled Tasks (no console window)
'usage: wscript //Nologo <this file> <one-line stub.cmd full path>
Dim sh, stub
stub = WScript.Arguments(0)
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c """ & stub & """", 0, True
"@ -replace "`r`n", "`n"

function WriteIfChanged([string]$Path, [string]$Content) {
  $exists = Test-Path $Path
  $same = $false
  if ($exists) {
    $old = (Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue)
    $same = ($old -eq $Content) -or ($old -replace "`r`n", "`n") -eq $Content
  }
  if ($same) { Info "· 启动器未变化: $Path"; return $false }
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  # cmd 存根用 GBK 兼容的 ASCII 注释，VBS 用 UTF-8；统一按 UTF-8 无 BOM 写
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Content, $utf8)
  Ok "写入启动器: $Path"
  return $true
}

# ---------------------------------------------------------------- 卸载分支
function Get-DaemonPid {
  $lock = Join-Path $projRoot 'data\hive.lock'
  if (-not (Test-Path $lock)) { return $null }
  try { return (Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json).pid } catch { return $null }
}

if ($Uninstall) {
  Info "== 卸载计划任务 $Name =="
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($task) {
    try { Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue } catch {}
    try {
      Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction Stop
      Ok "已删除任务 $Name"
    } catch { Fail "删除任务失败: $($_.Exception.Message)" }
  } else {
    Info "· 任务 $Name 不存在（保持幂等，继续清理）"
  }

  $dpid = Get-DaemonPid
  if ($dpid) {
    $proc = Get-Process -Id $dpid -ErrorAction SilentlyContinue
    if ($proc) {
      & taskkill /PID $dpid /T /F *> $null
      Ok "已结束 daemon 进程树 pid=$dpid"
    } else { Info "· 锁文件里的 pid=$dpid 已不存在" }
    Remove-Item -LiteralPath (Join-Path $projRoot 'data\hive.lock') -Force -ErrorAction SilentlyContinue
    Ok '已清掉残留 data\hive.lock'
  } else { Info '· 没有 daemon 在跑' }

  if (-not $KeepLauncher) {
    foreach ($f in @($stubPath, $vbsPath)) {
      if (Test-Path $f) { Remove-Item -LiteralPath $f -Force; Ok "已删除启动器 $f" }
    }
    # 目录空了也一并删掉，别留空壳
    if ((Test-Path $hiddenDir) -and -not (Get-ChildItem -LiteralPath $hiddenDir -Force)) {
      Remove-Item -LiteralPath $hiddenDir -Force -ErrorAction SilentlyContinue
    }
  } else { Info '· 按 -KeepLauncher 保留启动器' }

  exit $script:ExitCode
}

# ---------------------------------------------------------------- 安装分支
Info "== 注册计划任务 $Name =="
Info "项目根 : $projRoot"
Info "node   : $nodeExe"
Info "存根   : $stubPath"
Info "VBS    : $vbsPath"
Info "日志   : $nullLog"

if (-not $DryRun) {
  WriteIfChanged -Path $vbsPath -Content $vbsBody | Out-Null
  WriteIfChanged -Path $stubPath -Content $stubBody | Out-Null
} else {
  Info '· -DryRun：跳过写启动器文件'
}

# 触发器 / 设置 / 身份
$trigger = if ($AtStartup) {
  New-ScheduledTaskTrigger -AtStartup
} else {
  New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
}
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -DontStopOnIdleEnd
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//Nologo `"$vbsPath`" `"$stubPath`"" -WorkingDirectory $projRoot

Info ''
Info '动作  : wscript.exe //Nologo run_hidden.vbs hive-daemon.cmd'
Info ("触发  : " + $(if ($AtStartup) { '开机启动' } else { "登录时（$env:USERDOMAIN\$env:USERNAME）" }))
Info '设置  : 失败每 1 分钟重启（最多 999 次）/ 无执行时限 / 电池也运行 / 多实例忽略新请求'

if ($DryRun) {
  Info ''
  Info '-DryRun：不注册。真实执行会调用 Register-ScheduledTask -Force。'
  exit 0
}

try {
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Description 'HIVE 主动服务型超级智能体守护进程（隐藏窗口常驻）' -Force | Out-Null
  Ok "已注册（幂等：重复执行会覆盖同号任务）"
} catch {
  Fail "注册失败: $($_.Exception.Message)`n  提示：若非管理员无法写某些任务目录，可改用当前用户目录或手跑：`n  $nodeExe --no-warnings `"$hiveCli`" daemon"
  exit 1
}

$t = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
if (-not $t) { Fail '注册后查不到任务，环境异常'; exit 1 }
$ti = Get-ScheduledTaskInfo -TaskName $Name -ErrorAction SilentlyContinue
Info ("· 状态: {0}  上次结果: {1}" -f $t.State, ($(if ($ti) { $ti.LastTaskResult } else { 'n/a' })))

if ($Start) {
  Info '· 立即启动一次…'
  try { Start-ScheduledTask -TaskName $Name; Start-Sleep -Seconds 6 } catch { Fail "启动失败: $($_.Exception.Message)" }
  $t2 = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  $dpid = Get-DaemonPid
  Info ("· 任务状态: {0}" -f $t2.State)
  if ($dpid) { Ok "daemon 已起来，pid=$dpid（看板 http://127.0.0.1:8787）" }
  else { Info '· 还没看到 data\hive.lock（首轮 <60s，可再等或用 scripts\healthcheck.mjs 观察）' }
}

Info ''
Info '完成。后续：'
Info '  · 体检: pwsh -File scripts\healthcheck.mjs  →  node --no-warnings scripts\healthcheck.mjs'
Info '  · 停止: pwsh -File scripts\uninstall-task.ps1'
exit 0
