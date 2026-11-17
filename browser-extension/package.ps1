param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packageFiles = @('manifest.json','service-worker.js','content-extractor.js','shared.js','popup.html','popup.css','popup.js','README.md')
foreach ($packageFile in $packageFiles) { if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $packageFile) -PathType Leaf)) { throw "Missing package file: $packageFile" } }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$archivePath = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'QZZ-Feishu-Browser.zip'
$archiveStream = [IO.File]::Open($archivePath,[IO.FileMode]::Create)
try {
  $archive = [IO.Compression.ZipArchive]::new($archiveStream,[IO.Compression.ZipArchiveMode]::Create,$true)
  try { foreach ($packageFile in $packageFiles) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,(Join-Path $PSScriptRoot $packageFile),"browser-extension/$packageFile",[IO.Compression.CompressionLevel]::Optimal) | Out-Null } }
  finally { $archive.Dispose() }
} finally { $archiveStream.Dispose() }
Write-Output $archivePath
