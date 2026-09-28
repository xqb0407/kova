# rename.ps1 — 项目一键改名 (Windows / PowerShell 5.1+)
#
# 由 rename.bat 入口调用, 也可在 PowerShell 里直接运行:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "& scripts\rename.ps1 -CmdLine 'myapp --dry-run'"
#
# 用法(与 rename.sh 对齐):
#   rename.bat <new-slug> [--app-name "显示名"] [--bundle-id com.x.y]
#                          [--dir] [--dry-run] [--force] [-y]
#
param([string]$CmdLine = $env:RENAME_ARGS)
$ErrorActionPreference = 'Stop'

# ---------- 常量 ----------
$OldSlug  = 'kova'
$OldKebab = 'pi-kova'

# ---------- 参数解析(自行分词, 双引号成组) ----------
function Split-CmdLine([string]$s) {
  $tokens = @(); $cur = ''; $inQ = $false
  for ($i = 0; $i -lt $s.Length; $i++) {
    $c = $s[$i]
    if ($c -eq '"') { $inQ = -not $inQ; continue }
    if ((-not $inQ) -and ($c -eq ' ' -or $c -eq "`t")) {
      if ($cur -ne '') { $tokens += $cur; $cur = '' }
      continue
    }
    $cur += $c
  }
  if ($cur -ne '') { $tokens += $cur }
  return ,$tokens
}

function ConvertTo-Pascal([string]$slug) {
  $parts = $slug -split '-'
  $out = ''
  foreach ($p in $parts) {
    if ($p.Length -gt 0) { $out += $p.Substring(0,1).ToUpper() + $p.Substring(1) }
  }
  return $out
}

function Show-Usage {
  @'
用法: rename.bat <new-slug> [选项]
  <new-slug>        新品牌标识(小写字母/数字/连字符, 如 myapp / my-app)
                    kova->myapp  Kova->Myapp  KOVA->MYAPP  pi-kova->pi-myapp
  --app-name NAME   应用显示名(替换旧 productName, 可含空格)
  --bundle-id ID    应用标识(替换 com.kova.assistant)
  --dir             同时重命名项目根目录(默认不改)
  --dry-run         只预览, 不写入
  --force           跳过 git 工作区干净检查
  -y, --yes         跳过确认
'@ | Write-Host
}

$NewSlug = ''; $AppName = ''; $BundleId = ''
$DoDir = $false; $DryRun = $false; $Force = $false; $AssumeYes = $false

$toks = Split-CmdLine ([string]$CmdLine)
$i = 0
while ($i -lt $toks.Count) {
  $t = $toks[$i]
  switch -Regex ($t) {
    '^--app-name$'   { $i++; if ($i -ge $toks.Count) { throw '--app-name 需要参数' }; $AppName = $toks[$i]; break }
    '^--bundle-id$'  { $i++; if ($i -ge $toks.Count) { throw '--bundle-id 需要参数' }; $BundleId = $toks[$i]; break }
    '^--dir$'        { $DoDir = $true; break }
    '^--dry-run$'    { $DryRun = $true; break }
    '^--force$'      { $Force = $true; break }
    '^-y$|^--yes$'   { $AssumeYes = $true; break }
    '^-h$|^--help$'  { Show-Usage; exit 0 }
    '^-.*'           { Write-Host "未知选项: $t" -ForegroundColor Yellow; Show-Usage; exit 1 }
    default          { if ($NewSlug -ne '') { Write-Host '只能提供一个 <new-slug>' -ForegroundColor Yellow; exit 1 }; $NewSlug = $t }
  }
  $i++
}

if ($NewSlug -eq '') { Show-Usage; exit 1 }
if ($NewSlug -notmatch '^[a-z][a-z0-9]*(-[a-z0-9]+)*$') {
  Write-Host "错误: slug '$NewSlug' 不合法, 只允许小写字母/数字/连字符, 不能以 - 开头/结尾或含连续 -" -ForegroundColor Red
  exit 1
}
if ($NewSlug -eq $OldSlug) { Write-Host '新 slug 与当前品牌名相同, 无事可做。'; exit 0 }

$NewPascal = ConvertTo-Pascal $NewSlug
# UPPER 用于环境变量前缀(KOVA_*), 连字符转下划线
$NewUpper  = ($NewSlug.ToUpper() -replace '-', '_')
$OldPascal = ConvertTo-Pascal $OldSlug
$OldUpper  = ($OldSlug.ToUpper() -replace '-', '_')
$NewKebab  = "pi-$NewSlug"

if ($AppName  -ne '') { $AppName  = $AppName.Trim() }
if ($BundleId -ne '' -and $BundleId -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]*$') {
  Write-Host "错误: bundle-id '$BundleId' 只允许字母/数字/点/连字符" -ForegroundColor Red; exit 1
}

# ---------- 仓库根定位(相对脚本目录) ----------
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot

# ---------- 扫描规则 ----------
$ExclDirPattern = '(^|[\\/])(node_modules|\.git|target|\.next|out|dist|gen|\.rename-backup-[^\\/]+)([\\/]|$)'
# 顶层运行数据目录: 只排除仓库根下的 sessions/ 与 .zcode/ (rel 不带 ./ 前缀)
$TopExclPattern = '^(sessions|\.zcode)([\\/]|$)'
$TextExts = @('.json','.md','.ts','.tsx','.js','.mjs','.cjs','.rs','.toml','.lock','.html','.css','.json5','.yaml','.yml','.conf','.plist','.nsi','.sh','.bat','.ps1','.txt')
$ExclFiles = @('bun.lock','pnpm-lock.yaml','rename.sh','rename.bat','rename.ps1')

function Test-Excluded([string]$relPath) {
  if ($relPath -match $ExclDirPattern) { return $true }
  if ($relPath -match $TopExclPattern) { return $true }
  $leaf = Split-Path -Leaf $relPath
  if ($ExclFiles -contains $leaf) { return $true }
  if ($leaf -like '*.tsbuildinfo') { return $true }
  return $false
}

function Get-Rel([string]$full) {
  return $full.Substring($RepoRoot.Length).TrimStart('\','/')
}

# ---------- 带剪枝的手动遍历(避免深入 node_modules/target 等) ----------
# $pruneNames 在任意层级生效(构建产物目录); $topPruneNames 只在仓库根生效。
# sessions/.zcode 是顶层运行数据目录, 按名字任意层级排除会误伤 src/sessions/ 等源码目录。
function Get-NodesRecursive([string]$root, [string[]]$pruneNames, [string[]]$topPruneNames, [switch]$FilesOnly) {
  $rootFull = (Get-Item -LiteralPath $root -Force).FullName.TrimEnd('\','/')
  $stack = New-Object Collections.Stack
  $stack.Push($rootFull)
  while ($stack.Count -gt 0) {
    $dir = Get-Item -LiteralPath $stack.Pop() -Force
    $isRoot = ($dir.FullName -eq $rootFull)
    foreach ($sub in @($dir.GetDirectories())) {
      if ($pruneNames -contains $sub.Name) { continue }
      if ($isRoot -and $topPruneNames -contains $sub.Name) { continue }
      if ($sub.Name -like '.rename-backup-*') { continue }
      if (-not $FilesOnly) { $sub }
      $stack.Push($sub.FullName)
    }
    foreach ($file in $dir.GetFiles()) { $file }
  }
}
$ContentPrune    = @('node_modules','.git','target','.next','out','dist','gen')
$ContentTopPrune = @('sessions','.zcode')
$PathPrune       = @('node_modules','.git','target','.next','out','dist','scripts')
$PathTopPrune    = @()

# ---------- 收集候选文件并按内容命中 ----------
$MatchFiles = @()
$AllFiles = Get-NodesRecursive $RepoRoot $ContentPrune $ContentTopPrune -FilesOnly | Where-Object {
  $rel = Get-Rel $_.FullName
  (-not (Test-Excluded $rel)) -and ($TextExts -contains $_.Extension.ToLower())
}
foreach ($f in $AllFiles) {
  $rel = Get-Rel $f.FullName
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  if ($bytes.Length -eq 0) { continue }
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
  # 二进制/异常编码启发: 含替换字符则跳过
  if ($text.IndexOf([char]0xFFFD) -ge 0) { continue }
  if ($text.Contains($OldSlug) -or $text.Contains($OldUpper) -or $text.Contains($OldPascal) -or $text.Contains($OldKebab)) {
    $MatchFiles += [pscustomobject]@{ Rel = $rel; Full = $f.FullName; HadBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) }
  }
}

# ---------- 收集待重命名路径(目录+文件) ----------
$MatchPaths = @()
$AllNodes = Get-NodesRecursive $RepoRoot $PathPrune $PathTopPrune | Where-Object {
  ($_.Name -like "*$OldSlug*" -or $_.Name -like "*$OldUpper*" -or $_.Name -like "*$OldPascal*" -or $_.Name -like "*$OldKebab*")
}
foreach ($n in $AllNodes) { $MatchPaths += (Get-Rel $n.FullName) }

# ---------- 读取旧显示名 / bundle id ----------
$OldProduct = ''; $OldIdentifier = ''
$tauriConf = Join-Path $RepoRoot 'apps\desktop\src-tauri\tauri.conf.json'
if (-not (Test-Path -LiteralPath $tauriConf)) { $tauriConf = Join-Path $RepoRoot 'apps/desktop/src-tauri/tauri.conf.json' }
if (Test-Path -LiteralPath $tauriConf) {
  try {
    $confBytes = [IO.File]::ReadAllBytes($tauriConf)
    $confJson = [Text.Encoding]::UTF8.GetString($confBytes)
    $conf = $confJson | ConvertFrom-Json
    $OldProduct = [string]$conf.productName
    $OldIdentifier = [string]$conf.identifier
  } catch { }
}

if ($AppName -eq '') {
  if ($OldProduct -ne '') {
    $AppName = $OldProduct.Replace($OldPascal, $NewPascal).Replace($OldSlug, $NewSlug)
  } else { $AppName = $NewPascal }
}
if ($BundleId -eq '' -and $OldIdentifier -ne '') {
  $BundleId = $OldIdentifier.Replace($OldSlug, $NewSlug)
}

$CurDirName = (Get-Item -LiteralPath $RepoRoot).Name

# ---------- 计划 ----------
Write-Host '================================================'
Write-Host " 项目改名计划  (仓库: $RepoRoot)"
Write-Host '================================================'
Write-Host " 品牌 slug   : $OldSlug  ->  $NewSlug"
Write-Host "               $OldPascal  ->  $NewPascal"
Write-Host "               $OldUpper  ->  $NewUpper"
Write-Host " 内部 id     : $OldKebab  ->  $NewKebab"
Write-Host " 显示名      : $(if($OldProduct){$OldProduct}else{'<未找到>'})  ->  $AppName"
Write-Host " 应用标识    : $(if($OldIdentifier){$OldIdentifier}else{'<未找到>'})  ->  $(if($BundleId){$BundleId}else{'<未指定>'})"
Write-Host " 内容替换    : $($MatchFiles.Count) 个文件"
Write-Host " 路径重命名  : $($MatchPaths.Count) 个"
if ($DoDir) { Write-Host " 根目录改名  : $CurDirName  ->  $NewSlug" }
Write-Host '------------------------------------------------'
$shown = 0
foreach ($mf in $MatchFiles) {
  if ($shown -ge 60) { Write-Host "  ... 及其余 $($MatchFiles.Count - 60) 个"; break }
  Write-Host $mf.Rel; $shown++
}
if ($MatchPaths.Count -gt 0) {
  Write-Host '[路径重命名]'
  foreach ($mp in $MatchPaths) { Write-Host $mp }
}
Write-Host '------------------------------------------------'

if ($DryRun) { Write-Host '[dry-run] 未做任何修改。'; exit 0 }

if (-not $AssumeYes) {
  $ans = Read-Host '确认执行以上改名? [y/N]'
  if ($ans -notmatch '^[yY]') { Write-Host '已取消。'; exit 1 }
}

# ---------- git 安全检查 ----------
try {
  $isRepo = (& git rev-parse --is-inside-work-tree 2>$null)
  if ($LASTEXITCODE -eq 0 -and $isRepo -eq 'true' -and -not $Force) {
    $dirty = & git status --porcelain 2>$null
    if ($LASTEXITCODE -eq 0 -and @($dirty).Count -gt 0 -and ($dirty -join '').Trim() -ne '') {
      Write-Host '错误: git 工作区不干净。请先 commit / stash, 或用 --force 跳过此检查。' -ForegroundColor Red
      exit 1
    }
  }
} catch { }

# ---------- 备份 ----------
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = ".rename-backup-$Stamp"
if ($MatchFiles.Count -gt 0) {
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
  foreach ($mf in $MatchFiles) {
    $dst = Join-Path $BackupDir $mf.Rel
    $dstParent = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstParent)) { New-Item -ItemType Directory -Path $dstParent -Force | Out-Null }
    Copy-Item -LiteralPath $mf.Full -Destination $dst -Force
  }
}

# ---------- 内容替换 ----------
$utf8Bom    = New-Object Text.UTF8Encoding($true)
$utf8NoBom  = New-Object Text.UTF8Encoding($false)
foreach ($mf in $MatchFiles) {
  $bytes = [IO.File]::ReadAllBytes($mf.Full)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
  # 顺序: 最长串优先(整显示名、bundle id), 再 kebab, 再大小写变体
  if ($OldProduct   -ne '') { $text = $text.Replace($OldProduct, $AppName) }
  if ($OldIdentifier -ne '') { $text = $text.Replace($OldIdentifier, $BundleId) }
  $text = $text.Replace($OldKebab, $NewKebab)
  $text = $text.Replace($OldPascal, $NewPascal)
  $text = $text.Replace($OldUpper, $NewUpper)
  $text = $text.Replace($OldSlug, $NewSlug)
  $enc = if ($mf.HadBom) { $utf8Bom } else { $utf8NoBom }
  [IO.File]::WriteAllText($mf.Full, $text, $enc)
}

# ---------- 路径重命名(深->浅) ----------
if ($MatchPaths.Count -gt 0) {
  $sorted = $MatchPaths | Sort-Object { (($_ -split '[\\/]').Count) } -Descending
  foreach ($p in $sorted) {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $item = Get-Item -LiteralPath $p -Force
    $base = $item.Name
    $newbase = $base.Replace($OldKebab, $NewKebab).Replace($OldPascal, $NewPascal).Replace($OldUpper, $NewUpper).Replace($OldSlug, $NewSlug)
    if ($newbase -ne $base) {
      $parent = Split-Path -Parent $p
      $target = Join-Path $parent $newbase
      Rename-Item -LiteralPath $p -NewName $newbase
      Write-Host "  ren $p -> $target"
    }
  }
}

# ---------- 锁文件提醒 ----------
$lockOld = $false
foreach ($lockFile in @('bun.lock','pnpm-lock.yaml')) {
  if (Test-Path -LiteralPath $lockFile) {
    $lb = [IO.File]::ReadAllText((Join-Path $RepoRoot $lockFile))
    if ($lb.Contains($OldSlug) -or $lb.Contains($OldKebab)) { $lockOld = $true }
  }
}
if ($lockOld) {
  Write-Host ''
  Write-Host "注意: bun.lock / pnpm-lock.yaml 仍含旧名称, 请运行 'bun install' 重新生成。" -ForegroundColor Yellow
}

# ---------- 根目录改名 ----------
if ($DoDir) {
  $parent = Split-Path -Parent $RepoRoot
  $target = Join-Path $parent $NewSlug
  if (Test-Path -LiteralPath $target) {
    Write-Host "警告: 已存在 '$target', 跳过根目录改名。" -ForegroundColor Yellow
  } else {
    try {
      Set-Location -LiteralPath $parent
      Rename-Item -LiteralPath $RepoRoot -NewName $NewSlug
      Write-Host "根目录已改名 -> $target"
      Write-Host "请执行: cd `"$target`""
    } catch {
      Write-Host "根目录改名失败(目录可能被占用): $($_.Exception.Message)" -ForegroundColor Yellow
      Write-Host "请关闭本脚本终端以外的占用程序后手动重命名, 或先 cd 到其他目录再运行。"
    }
  }
}

Write-Host ''
Write-Host '改名完成。' -ForegroundColor Green
if (Test-Path -LiteralPath $BackupDir) {
  Write-Host "   备份在 $BackupDir/ (git 用户可 'git checkout .' 回滚, 确认无误后删除备份目录)"
}
Write-Host ''
Write-Host '后续步骤:'
Write-Host '  1) bun install                    # 重新生成锁文件'
Write-Host "  2) 全局搜索旧名做最终核对: findstr /s /i /m kova *.* (排除 node_modules 后应为空)"
Write-Host "  3) 旧数据目录(如 %USERPROFILE%\$OldSlug)不会自动迁移, 新名称首启会创建新目录"
