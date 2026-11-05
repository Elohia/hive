<#
.SYNOPSIS
  卸载 HIVE 守护进程计划任务（install-task.ps1 -Uninstall 的薄壳，避免两处逻辑分叉）。

.DESCRIPTION
  做的事（全部幂等，重复执行不报错）：
    1) 停止并删除计划任务（默认名为 HIVE-daemon）；
    2) 从 data\hive.lock 读出 daemon 的 pid，用 taskkill /T /F 结束整个进程树；
    3) 清掉残留的 data\hive.lock；
    4) 删除 data\work\hidden\ 下的隐藏启动器（-KeepLauncher 可保留）。

  真正的逻辑只写在 scripts\install-task.ps1 里；本文件只负责转发参数，
  这样「装/卸」两边的行为永远一致（不会出现装的时候改了、卸的时候忘了改）。

.PARAMETER Name
  计划任务名，默认 HIVE-daemon。

.PARAMETER Root
  HIVE 项目根，默认本脚本所在目录的父目录。

.PARAMETER KeepLauncher
  保留 data\work\hidden\ 下的 run_hidden.vbs / hive-daemon.cmd。

.PARAMETER Help
  显示帮助。

.EXAMPLE
  pwsh -File scripts\uninstall-task.ps1
  pwsh -File scripts\uninstall-task.ps1 -Name HIVE-daemon -KeepLauncher

.NOTES
  退出码：0 = 成功（含「本来就没装」）；1 = 失败；2 = 参数错误。
#>
[CmdletBinding()]
param(
  [string]$Name = 'HIVE-daemon',
  [Alias('Home','HomeDir')]
  [string]$Root = '',
  [switch]$KeepLauncher,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Get-Help $PSCommandPath -Detailed | Out-String | Write-Host
  exit 0
}

$installer = Join-Path $PSScriptRoot 'install-task.ps1'
if (-not (Test-Path $installer)) {
  Write-Host "✗ 找不到 $installer —— 卸载逻辑在安装脚本里，请保持两个文件同目录" -ForegroundColor Red
  exit 1
}

$splat = @{ Uninstall = $true; Name = $Name }
if ($Root) { $splat.Root = $Root }
if ($KeepLauncher) { $splat.KeepLauncher = $true }

try {
  & $installer @splat
  exit $LASTEXITCODE
} catch {
  Write-Host "✗ 卸载失败: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
