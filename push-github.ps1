# push-github.ps1 — 认证好之后，一条命令把两个仓库推到 GitHub
#
# 前置：gh 已认证（gh auth login，或 gh auth login --with-token < token.txt）
# 用法：pwsh -NoProfile -File push-github.ps1
#       pwsh -NoProfile -File push-github.ps1 -Visibility private
param(
  [string]$Owner = '',
  [ValidateSet('public', 'private')][string]$Visibility = 'public'
)

$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

Step '0) 认证检查'
$login = & gh api user -q .login 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "✗ gh 未认证：$login" -ForegroundColor Red
  Write-Host '  先执行： gh auth login --hostname github.com --git-protocol https --web' -ForegroundColor Yellow
  Write-Host '  或用 PAT： $env:GH_TOKEN="ghp_xxx"; gh auth login --with-token' -ForegroundColor Yellow
  exit 1
}
Write-Host "✓ 已认证：$login"
if (-not $Owner) { $Owner = $login }

function Push-Repo([string]$dir, [string]$repo, [string]$desc) {
  Step "1) $repo"
  Push-Location $dir
  try {
    $exists = & gh repo view "$Owner/$repo" --json name 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  创建仓库 $Owner/$repo ($Visibility)…"
      & gh repo create "$Owner/$repo" "--$Visibility" --description $desc --source=. --remote=origin --push
      if ($LASTEXITCODE -ne 0) { throw "创建/推送失败" }
    } else {
      Write-Host '  仓库已存在，设置 remote 并推送…'
      & git remote remove origin 2>$null | Out-Null
      & git remote add origin "https://github.com/$Owner/$repo.git"
      & git push -u origin main --force
      if ($LASTEXITCODE -ne 0) { throw "推送失败" }
    }
    $url = "https://github.com/$Owner/$repo"
    Write-Host "✓ $url" -ForegroundColor Green
    return $url
  } finally { Pop-Location }
}

$urls = @()
$urls += Push-Repo 'D:\hive\dsh-plugin-hive' 'dsh-plugin-hive' 'HIVE 蜂巢 · 主动服务型超级智能体 — DSH 插件（左侧栏入口 + 任务中心看板 + L1–L5 自主分级 + HITL）'
$urls += Push-Repo 'D:\hive' 'hive' 'HIVE — 主动服务型超级智能体：主动感知 / 任务中心 / 自主分级 / HITL / 监控看板'

Step '完成'
$urls | ForEach-Object { Write-Host $_ -ForegroundColor Green }
