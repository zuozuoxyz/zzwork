# zzwork 构建脚本（PowerShell）
# 从官方 VS Code zip 组装 zzwork 发行版
# 用法: .\build.ps1 [-Zip <VS_Code_win32-x64.zip>]

param(
  [string]$Zip = "vscode-1.142.0.zip",
  [string]$Version = "1.142.0"
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$ExtDir = "6d62b1d5da/resources/app/extensions/zzwork"

if (-not (Test-Path $Zip)) {
  Write-Host ">> 下载 VS Code $Version ..."
  Invoke-WebRequest -Uri "https://update.code.visualstudio.com/$Version/win32-x64/stable" -OutFile $Zip
}

Write-Host ">> 解压 $Zip ..."
if (Test-Path build) { Remove-Item build -Recurse -Force }
Expand-Archive $Zip -DestinationPath build

$Dist = Get-ChildItem build -Directory | Where-Object { Test-Path "$($_.FullName)/resources/app/out" } | Select-Object -First 1
if (-not $Dist) { throw "未找到发行版结构" }
$Dist = $Dist.FullName
Write-Host ">> 发行版目录: $Dist"

Write-Host ">> 品牌化 product.json ..."
node patches/brand.js "$Dist/resources/app/product.json"

Write-Host ">> 打 workbench 补丁 ..."
node patches/patch-workbench.js "$Dist/resources/app" patches

Write-Host ">> 移除登录/AI 内置扩展 ..."
New-Item -ItemType Directory -Force -Path "$Dist/removed-extensions" | Out-Null
foreach ($ext in @("copilot","github","github-authentication","microsoft-authentication","TypeScriptTeam.jsts-chat-features")) {
  if (Test-Path "$Dist/resources/app/extensions/$ext") {
    Move-Item "$Dist/resources/app/extensions/$ext" "$Dist/removed-extensions/"
  }
}

Write-Host ">> 安装扩展依赖（better-sqlite3 electron-v148）..."
if (-not (Test-Path "$ExtDir/node_modules/better-sqlite3")) {
  Push-Location $ExtDir
  npm install --ignore-scripts
  Push-Location node_modules/better-sqlite3
  npx prebuild-install r -t electron-v148.0.0
  Pop-Location; Pop-Location
}

Write-Host ">> 完成: $Dist\Code.exe 即 zzwork"
