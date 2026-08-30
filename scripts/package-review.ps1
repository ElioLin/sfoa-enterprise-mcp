[CmdletBinding()]
param([string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryName = Split-Path $repositoryRoot -Leaf
$requiredLocalEnvironment = '.env.local'
$requiredEnvironmentPath = Join-Path $repositoryRoot $requiredLocalEnvironment

if (-not (Test-Path -LiteralPath $requiredEnvironmentPath -PathType Leaf)) {
  throw "$requiredLocalEnvironment is required for this sensitive local review package but was not found."
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path (Split-Path $repositoryRoot -Parent) 'sfoa-review-packages'
}
$resolvedOutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$repositoryPrefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($resolvedOutputDirectory.Equals($repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $resolvedOutputDirectory.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputDirectory must be outside the repository to prevent sensitive archives from being repackaged or committed.'
}
[IO.Directory]::CreateDirectory($resolvedOutputDirectory) | Out-Null

$excludedDirectoryNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($name in @(
  '.git', 'node_modules', 'dist', 'lib', 'coverage', '.nyc_output',
  'playwright-report', 'test-results', '.sfdx', '.codegraph', '.firecrawl',
  '.cursor', '.idea', '.wireit', 'Library', 'tmp', '.temp', 'projects', 'secrets'
)) {
  [void]$excludedDirectoryNames.Add($name)
}

function Test-IncludedLocalFile {
  param([Parameter(Mandatory)][IO.FileInfo]$File)

  if (($File.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  if ($File.Extension -in @('.pem', '.key')) { return $false }
  if ($File.Name -in @('.DS_Store', '.eslintcache', 'npm-error.log', 'yarn-error.log', 'lerna-debug.log')) {
    return $false
  }
  if ($File.Name.EndsWith('.tsbuildinfo', [StringComparison]::OrdinalIgnoreCase)) { return $false }
  if ($File.Name -match '(?i)(xunit|checkstyle)\.xml$|unitcoverage$') { return $false }
  return $true
}

function Get-LocalReviewFiles {
  $files = [Collections.Generic.List[IO.FileInfo]]::new()
  $directories = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
  $directories.Push((Get-Item -LiteralPath $repositoryRoot))
  while ($directories.Count -gt 0) {
    $directory = $directories.Pop()
    foreach ($entry in (Get-ChildItem -LiteralPath $directory.FullName -Force)) {
      if ($entry.PSIsContainer) {
        if ($excludedDirectoryNames.Contains($entry.Name)) { continue }
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        $directories.Push([IO.DirectoryInfo]$entry)
      } elseif (Test-IncludedLocalFile -File ([IO.FileInfo]$entry)) {
        $files.Add([IO.FileInfo]$entry)
      }
    }
  }
  return $files
}

function Get-GitMetadata {
  param([Parameter(Mandatory)][string[]]$Arguments, [string]$Fallback = 'UNKNOWN')

  try {
    $value = @(& git -C $repositoryRoot @Arguments 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $value.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($value[0])) {
      return [string]$value[0]
    }
  } catch {
    # Git metadata is informational only; local filesystem content remains authoritative.
  }
  return $Fallback
}

$localFiles = @(Get-LocalReviewFiles)
$relativeFiles = [Collections.Generic.List[string]]::new()
foreach ($file in $localFiles) {
  $relativeFiles.Add($file.FullName.Substring($repositoryPrefix.Length).Replace('\', '/'))
}
$relativeFiles.Sort([StringComparer]::OrdinalIgnoreCase)

$branch = Get-GitMetadata -Arguments @('branch', '--show-current') -Fallback 'DETACHED_OR_UNAVAILABLE'
$commit = Get-GitMetadata -Arguments @('rev-parse', 'HEAD')
$archiveName = "$repositoryName-local-current-SENSITIVE.zip"
$archivePath = Join-Path $resolvedOutputDirectory $archiveName
$temporaryArchivePath = Join-Path $resolvedOutputDirectory ".$archiveName.$([Guid]::NewGuid().ToString('N')).tmp.zip"
$stagingDirectory = Join-Path ([IO.Path]::GetTempPath()) "sfoa-local-review-$([Guid]::NewGuid().ToString('N'))"

try {
  [IO.Directory]::CreateDirectory($stagingDirectory) | Out-Null
  foreach ($relativePath in $relativeFiles) {
    $sourcePath = Join-Path $repositoryRoot $relativePath
    $destinationPath = Join-Path $stagingDirectory $relativePath
    [IO.Directory]::CreateDirectory((Split-Path $destinationPath -Parent)) | Out-Null
    [IO.File]::Copy($sourcePath, $destinationPath, $true)
  }

  $manifestPath = Join-Path $stagingDirectory 'REVIEW_PACKAGE_MANIFEST.txt'
  $manifest = @(
    'SFoA Enterprise MCP sensitive current-local review package',
    "Created: $([DateTimeOffset]::Now.ToString('o'))",
    "Repository: $repositoryName",
    'Content source: current local filesystem (not a Git commit/archive)',
    "Git branch metadata: $branch",
    "Git commit metadata: $commit",
    "Local files copied: $($relativeFiles.Count)",
    '.env.local included unchanged: YES',
    '',
    'Excluded: .git, dependencies, build/test output, caches, .codegraph, .sfdx, private keys, secrets, symlinks.',
    'WARNING: This archive contains local credentials and must be handled as a secret.'
  )
  [IO.File]::WriteAllLines($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory(
    $stagingDirectory,
    $temporaryArchivePath,
    [IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $zip = [IO.Compression.ZipFile]::OpenRead($temporaryArchivePath)
  $entryNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $zip.Entries) { [void]$entryNames.Add($entry.FullName.Replace('\', '/')) }
  $zip.Dispose()
  if (-not $entryNames.Contains($requiredLocalEnvironment)) {
    throw "Archive verification failed: $requiredLocalEnvironment is missing."
  }
  foreach ($relativePath in $relativeFiles) {
    if (-not $entryNames.Contains($relativePath)) {
      throw "Archive verification failed: $relativePath is missing."
    }
  }

  # Replace old project packages only after the new archive passes verification.
  $oldArchives = @(Get-ChildItem -LiteralPath $resolvedOutputDirectory -File -Filter ($repositoryName + '-*-SENSITIVE.zip'))
  foreach ($oldArchive in $oldArchives) {
    Remove-Item -LiteralPath $oldArchive.FullName -Force
  }
  Move-Item -LiteralPath $temporaryArchivePath -Destination $archivePath

  $archive = Get-Item -LiteralPath $archivePath
  Write-Output 'REVIEW_PACKAGE=PASS'
  Write-Output 'CONTENT_SOURCE=current_local_filesystem'
  Write-Output "ARCHIVE=$($archive.FullName)"
  Write-Output "FILES=$($relativeFiles.Count + 1)"
  Write-Output "SIZE_BYTES=$($archive.Length)"
  Write-Output 'SENSITIVE_ENV_LOCAL_INCLUDED=true'
  Write-Output 'OUTPUT_ZIP_COUNT=1'
} finally {
  if (Test-Path -LiteralPath $stagingDirectory) {
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
  }
  if (Test-Path -LiteralPath $temporaryArchivePath) {
    Remove-Item -LiteralPath $temporaryArchivePath -Force
  }
}
