[CmdletBinding()]
param(
  [string]$OutputDirectory,
  [string[]]$IncludeIgnored = @()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryName = Split-Path $repositoryRoot -Leaf
$requiredLocalEnvironment = '.env.local'

function Invoke-GitLines {
  param([Parameter(Mandatory)][string[]]$Arguments)

  $lines = @(& git -C $repositoryRoot @Arguments)
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
  return $lines
}

function Resolve-RepositoryFile {
  param([Parameter(Mandatory)][string]$RelativePath)

  if ([IO.Path]::IsPathRooted($RelativePath)) {
    throw "Additional paths must be repository-relative: $RelativePath"
  }
  $normalized = $RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
  $fullPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $normalized))
  $rootPrefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Additional path escapes the repository: $RelativePath"
  }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Review package file does not exist: $RelativePath"
  }
  return $fullPath
}

$requiredEnvironmentPath = Join-Path $repositoryRoot $requiredLocalEnvironment
if (-not (Test-Path -LiteralPath $requiredEnvironmentPath -PathType Leaf)) {
  throw "$requiredLocalEnvironment is required for this sensitive review package but was not found."
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

$trackedAndVisible = Invoke-GitLines -Arguments @('ls-files', '--cached', '--others', '--exclude-standard')
$relativeFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($relativePath in $trackedAndVisible) {
  if (-not [string]::IsNullOrWhiteSpace($relativePath)) {
    [void]$relativeFiles.Add($relativePath.Replace('\', '/'))
  }
}
[void]$relativeFiles.Add($requiredLocalEnvironment)

foreach ($relativePath in $IncludeIgnored) {
  $fullPath = Resolve-RepositoryFile -RelativePath $relativePath
  $normalizedRelative = [IO.Path]::GetRelativePath($repositoryRoot, $fullPath).Replace('\', '/')
  [void]$relativeFiles.Add($normalizedRelative)
}

$branch = (Invoke-GitLines -Arguments @('branch', '--show-current') | Select-Object -First 1)
$commit = (Invoke-GitLines -Arguments @('rev-parse', 'HEAD') | Select-Object -First 1)
$shortCommit = (Invoke-GitLines -Arguments @('rev-parse', '--short=12', 'HEAD') | Select-Object -First 1)
$safeBranch = if ([string]::IsNullOrWhiteSpace($branch)) { 'detached' } else { $branch -replace '[^A-Za-z0-9._-]+', '-' }
$timestamp = [DateTimeOffset]::Now.ToString('yyyyMMdd-HHmmss')
$archiveName = "$repositoryName-$safeBranch-$shortCommit-$timestamp-SENSITIVE.zip"
$archivePath = Join-Path $resolvedOutputDirectory $archiveName
$stagingDirectory = Join-Path ([IO.Path]::GetTempPath()) "sfoa-review-$([Guid]::NewGuid().ToString('N'))"

try {
  [IO.Directory]::CreateDirectory($stagingDirectory) | Out-Null
  $copiedFiles = [Collections.Generic.List[string]]::new()
  foreach ($relativePath in ($relativeFiles | Sort-Object)) {
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $relativePath))
    # Deleted tracked files represent the current working tree by remaining absent.
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
    $destinationPath = Join-Path $stagingDirectory $relativePath
    [IO.Directory]::CreateDirectory((Split-Path $destinationPath -Parent)) | Out-Null
    [IO.File]::Copy($sourcePath, $destinationPath, $true)
    $copiedFiles.Add($relativePath.Replace('\', '/'))
  }

  $manifestPath = Join-Path $stagingDirectory 'REVIEW_PACKAGE_MANIFEST.txt'
  $manifest = @(
    'SFoA Enterprise MCP sensitive review package',
    "Created: $([DateTimeOffset]::Now.ToString('o'))",
    "Repository: $repositoryName",
    "Branch: $branch",
    "Commit: $commit",
    "Files copied: $($copiedFiles.Count)",
    '.env.local included unchanged: YES',
    "Additional ignored files: $($IncludeIgnored.Count)",
    '',
    'Default ignored exclusions: node_modules, build output, coverage/test reports, caches, .codegraph, .sfdx, private keys, secrets.',
    'WARNING: This archive contains local credentials and must be handled as a secret.'
  )
  [IO.File]::WriteAllLines($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory(
    $stagingDirectory,
    $archivePath,
    [IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $entryNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $zip.Entries) { [void]$entryNames.Add($entry.FullName.Replace('\', '/')) }
    if (-not $entryNames.Contains($requiredLocalEnvironment)) {
      throw "Archive verification failed: $requiredLocalEnvironment is missing."
    }
    foreach ($relativePath in $copiedFiles) {
      if (-not $entryNames.Contains($relativePath)) {
        throw "Archive verification failed: $relativePath is missing."
      }
    }
  } finally {
    $zip.Dispose()
  }

  $archive = Get-Item -LiteralPath $archivePath
  Write-Output 'REVIEW_PACKAGE=PASS'
  Write-Output "ARCHIVE=$($archive.FullName)"
  Write-Output "FILES=$($copiedFiles.Count + 1)"
  Write-Output "SIZE_BYTES=$($archive.Length)"
  Write-Output 'SENSITIVE_ENV_LOCAL_INCLUDED=true'
} finally {
  if (Test-Path -LiteralPath $stagingDirectory) {
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
  }
}
