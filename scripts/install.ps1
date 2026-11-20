# Synapse agent Windows 安装脚本
# 从 endpoint 的 /dl 下载预编译 exe，校验 SHA-256 后执行 init / win-config / 连通性自检。
# 也支持 -Binary 指定本机已编译的 exe，跳过下载。
#
# 一行安装（下载脚本到内存执行，参数走环境变量，绕开 iex 无法传参 + 执行策略）：
#   $env:SYNAPSE_ENDPOINT="https://synapse.wangda.today"; $env:SYNAPSE_PROJECT="yanshi"; $env:SYNAPSE_TOKEN="<TOKEN>"; `
#     iwr "https://synapse.wangda.today/dl/install.ps1" | iex
#
# 常规用法（存成文件）：
#   .\install.ps1 -Endpoint https://synapse.wangda.today -Project yanshi -Token <TOKEN>
#   .\install.ps1 -Endpoint https://synapse.wangda.today -Project yanshi -Token <TOKEN> -WindowApp 豆包
#   .\install.ps1 -Endpoint https://synapse.wangda.today -Project yanshi -Token <TOKEN> -Binary .\synapse-agent.exe
#
# 注意：token 只写入本地配置，不打印；配置目录为 $HOME\.synapse-agent。
param(
  [string]$Endpoint = "",
  [string]$Project = "",
  [string]$Token = "",
  [string]$Agent = "doubao-client",

  # 默认窗口目标（应用名）。留空则保留机器上已有的设置；都没有则默认 "豆包"。
  # 在 init 之后设置——因为 init 会重写 config.json，win-config 能保留其它字段。
  [string]$WindowApp = "",

  # 可选：本机已编译的 exe；给了就不下载
  [string]$Binary = "",

  # 可选：从 /dl 下载的 URL；默认按 Toolchain 推导
  [string]$BinaryUrl = "",

  # 目前网站只发布 msvc 产物；gnu 需自行编译并上传到 R2 bin/
  [ValidateSet("msvc", "gnu")]
  [string]$Toolchain = "msvc",

  # 可选：安装目录；默认 %LOCALAPPDATA%\synapse-agent\bin
  [string]$InstallDir = "",

  # 可选：本地二进制校验值；仅 -Binary 模式使用
  [string]$Sha256 = "",

  # 可选：跳过联网自检（离线安装时用）
  [switch]$SkipCheck,

  # 可选：注册每天定时给目标窗口发消息的任务（需配合 -TaskTime / -TaskText）
  [switch]$InstallTask,
  [string]$TaskTime = "09:00",
  [string]$TaskText = ""
)

$ErrorActionPreference = "Stop"

# 下载大文件时关掉进度条，否则 Windows PowerShell 5.1 下极慢
$ProgressPreference = "SilentlyContinue"

# ── 参数兜底：命令行 > 环境变量 > 报错 ──────────────────────────
if (-not $Endpoint) { $Endpoint = $env:SYNAPSE_ENDPOINT }
if (-not $Project)  { $Project  = $env:SYNAPSE_PROJECT }
if (-not $Token)    { $Token    = $env:SYNAPSE_TOKEN }
if (-not $Endpoint) { throw "缺少 -Endpoint（或环境变量 SYNAPSE_ENDPOINT）" }
if (-not $Project)  { throw "缺少 -Project（或环境变量 SYNAPSE_PROJECT）" }
if (-not $Token)    { throw "缺少 -Token（或环境变量 SYNAPSE_TOKEN）" }

function Invoke-WebRequestSimple {
  param(
    [Parameter(Mandatory=$true)][string]$Uri,
    [string]$OutFile = "",
    [string]$Method = "Get"
  )
  $splat = @{ Uri = $Uri; Method = $Method; ErrorAction = "Stop"; TimeoutSec = 60 }
  if ($OutFile) { $splat.OutFile = $OutFile }
  # Windows PowerShell 5.1 需要 basic parsing；PowerShell 7 默认就是 basic。
  if ($PSVersionTable.PSVersion.Major -lt 6) { $splat.UseBasicParsing = $true }
  Invoke-WebRequest @splat
}

function Get-RemoteSha256 {
  param([Parameter(Mandatory=$true)][string]$Url)

  # 1) 优先 .sha256 边车
  try {
    $r = Invoke-WebRequestSimple -Uri ($Url + ".sha256")
    if ($r.Content -is [byte[]]) {
      $text = [Text.Encoding]::UTF8.GetString($r.Content)
    } else {
      $text = [string]$r.Content
    }
    $text = $text.TrimStart([char]0xFEFF)
    $m = [regex]::Match($text, '(?im)^\s*([0-9a-f]{64})')
    if ($m.Success) { return $m.Groups[1].Value.ToLowerInvariant() }
  } catch {
    # 404 / 网络错误时继续尝试响应头
  }

  # 2) 回退 x-sha256 响应头
  try {
    $r = Invoke-WebRequestSimple -Uri $Url -Method "Head"
    $v = $r.Headers["x-sha256"]
    if ($v -is [System.Array]) { $v = $v[0] }
    if ($null -ne $v) {
      $m = [regex]::Match([string]$v, '(?i)^\s*([0-9a-f]{64})')
      if ($m.Success) { return $m.Groups[1].Value.ToLowerInvariant() }
    }
  } catch {
    # 两种来源都拿不到时，下面统一报错
  }

  return $null
}

function Get-FileSha256 {
  param([Parameter(Mandatory=$true)][string]$Path)
  $h = Get-FileHash -Path $Path -Algorithm SHA256
  return $h.Hash.ToLowerInvariant()
}

# TLS 1.2（Windows PowerShell 5.1 默认可能还是旧协议）；能用则一并启用 TLS 1.3
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {}
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 12288
} catch {}

$Endpoint = $Endpoint.TrimEnd([char]"/")
$Toolchain = $Toolchain.ToLowerInvariant()

if (-not $InstallDir) {
  if ($env:LOCALAPPDATA) {
    $InstallDir = Join-Path $env:LOCALAPPDATA "synapse-agent\bin"
  } elseif ($HOME) {
    $InstallDir = Join-Path $HOME ".synapse-agent\bin"
  } else {
    throw "无法确定安装目录；请显式传 -InstallDir"
  }
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Target = Join-Path $InstallDir "synapse-agent.exe"

# 配置目录（与 Rust dirs_config() 一致：HOME 优先，回退 USERPROFILE）
if ($env:HOME) { $UserHome = $env:HOME }
elseif ($HOME) { $UserHome = $HOME }
elseif ($env:USERPROFILE) { $UserHome = $env:USERPROFILE }
else { $UserHome = $InstallDir }
$configDir = Join-Path $UserHome ".synapse-agent"
$configPath = Join-Path $configDir "config.json"

# 记录安装前的默认窗口目标，init 重写 config 后要恢复
$prevWindowApp = ""
if (Test-Path -LiteralPath $configPath) {
  try {
    $prev = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($prev.window_app) { $prevWindowApp = [string]$prev.window_app }
  } catch {}
}

$sourceLabel = ""
if ($Binary) {
  # 本机已有二进制：复制到稳定安装目录，避免后续移走源文件导致服务失效
  $source = (Resolve-Path -LiteralPath $Binary).Path
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "找不到二进制：$Binary"
  }
  if ($Sha256) {
    $actual = Get-FileSha256 -Path $source
    if ($actual -ne $Sha256.ToLowerInvariant()) {
      throw "本地二进制 SHA-256 不匹配：want=$($Sha256.ToLowerInvariant()) got=$actual"
    }
  }
  if ($source -ne $Target) {
    Copy-Item -LiteralPath $source -Destination $Target -Force
  }
  $sourceLabel = "local:$source"
  Write-Host "使用本地二进制：$source" -ForegroundColor Cyan
} else {
  # 自动下载预编译 exe
  if (-not $BinaryUrl) {
    $BinaryUrl = $Endpoint + "/dl/synapse-agent-x86_64-windows-" + $Toolchain + ".exe"
  }
  Write-Host "下载：$BinaryUrl" -ForegroundColor Cyan

  $expected = Get-RemoteSha256 -Url $BinaryUrl
  if (-not $expected) {
    throw "拿不到 $BinaryUrl 的 sha256，拒绝安装未校验的 exe（确认 R2 bin/ 已上传该对象及其 .sha256 或 customMetadata.sha256）"
  }

  $tmp = $Target + ".download"
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
  try {
    Invoke-WebRequestSimple -Uri $BinaryUrl -OutFile $tmp
    $actual = Get-FileSha256 -Path $tmp
    if ($actual -ne $expected) {
      throw "SHA-256 校验失败：want=$expected got=$actual"
    }
    try {
      Move-Item -LiteralPath $tmp -Destination $Target -Force
      try { Unblock-File -LiteralPath $Target -ErrorAction SilentlyContinue } catch {}
    } catch {
      throw "无法替换 $Target（可能正在运行）。请先停止 synapse-agent 再重试。原始错误：$($_.Exception.Message)"
    }
  } finally {
    if (Test-Path -LiteralPath $tmp) {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
  }
  $sourceLabel = "download:$BinaryUrl"
  Write-Host "SHA-256 校验通过：$expected" -ForegroundColor Green
}

if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
  throw "安装后找不到 exe：$Target"
}

$actualHash = Get-FileSha256 -Path $Target
Write-Host "binary=$Target" -ForegroundColor Cyan
Write-Host "sha256=$actualHash" -ForegroundColor DarkGray
Write-Host "source=$sourceLabel" -ForegroundColor DarkGray
Write-Host "endpoint=$Endpoint project=$Project agent=$Agent" -ForegroundColor Cyan

# 1) init：写 endpoint/project/token 等（会重写 config.json）
& $Target init --endpoint $Endpoint --project $Project --token $Token --agent $Agent
if ($LASTEXITCODE -ne 0) { throw "synapse-agent init 失败，exit=$LASTEXITCODE" }

# 2) win-config：在 init 之后设置默认目标窗口，避免被 init 冲掉。
#    优先级：本次 -WindowApp > 安装前已有设置 > 默认"豆包"
$finalApp = $WindowApp
if (-not $finalApp) { $finalApp = $prevWindowApp }
if (-not $finalApp) { $finalApp = "豆包" }
& $Target win-config --app $finalApp
if ($LASTEXITCODE -ne 0) { throw "synapse-agent win-config 失败，exit=$LASTEXITCODE" }
Write-Host "默认窗口目标：$finalApp" -ForegroundColor Green

# 3) status：读本地配置自检
& $Target status
if ($LASTEXITCODE -ne 0) { throw "synapse-agent status 失败，exit=$LASTEXITCODE" }

# 4) 联网自检：status 只看本地，不能证明连得上 Hub。这里探测 endpoint 根路径。
#    HEAD 不通时用 GET（有些服务不接受 HEAD）；任何 HTTP 响应都算通，只有网络异常才算失败。
if (-not $SkipCheck) {
  $reachable = $false
  foreach ($m in @("Head", "Get")) {
    try {
      $null = Invoke-WebRequestSimple -Uri $Endpoint -Method $m
      $reachable = $true
      break
    } catch {
      # 4xx/5xx 也算"网络通"，Invoke-WebRequest 会抛异常但服务器已响应
      if ($_.Exception.Response) { $reachable = $true; break }
    }
  }
  if ($reachable) {
    Write-Host "连通性自检：$Endpoint 可达 ✓" -ForegroundColor Green
  } else {
    Write-Warning "连通性自检失败：$Endpoint 不可达。安装已完成，但 agent 可能无法连接 Hub。"
  }
}

# 5) 可选：注册每天定时给目标窗口发消息的任务
#    任务以"当前用户、仅登录时运行"注册（不加 /RU SYSTEM），否则跑在 Session 0 看不到桌面窗口。
if ($InstallTask) {
  if (-not $TaskText) { throw "注册定时任务需要 -TaskText <要发送的文字>" }
  $taskName = "SynapseAgent-WindowSend"
  $wrapper = Join-Path $InstallDir "send-task.bat"
  # 用 bat 包装避免 schtasks /TR 对中文与引号的转义问题
  $bat = '@echo off' + "`r`n" + '"' + $Target + '" win-send --text "' + $TaskText + '" --enter 1' + "`r`n"
  Set-Content -LiteralPath $wrapper -Value $bat -Encoding ASCII -Force
  $tr = '"' + $wrapper + '"'
  # 先删旧任务，保证可重复执行
  $null = schtasks /Delete /TN $taskName /F 2>$null
  schtasks /Create /TN $taskName /TR $tr /SC DAILY /ST $TaskTime /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "注册计划任务失败，exit=$LASTEXITCODE" }
  Write-Host "定时任务已注册：$taskName 每天 $TaskTime 发送 → $finalApp" -ForegroundColor Green
}

Write-Host "完成。配置在 $configPath" -ForegroundColor Green
Write-Host ("常驻请自行注册计划任务或 Windows 服务：" + $Target + " run") -ForegroundColor Green
