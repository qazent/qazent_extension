# Fixes packaged manifest metadata for Azure DevOps Marketplace upload.
# 1. Corrects the PrivacyPolicy property casing in extension.vsixmanifest.
# 2. Replaces extension.vsomanifest with the full source manifest so the
#    Marketplace-facing JSON keeps content/assets/links exactly as authored.

[CmdletBinding()]
param(
    [string]$VsixPath,
    [string]$VsixDirectory = ".\\output",
    [string]$VsixPrefix = "QAZent.pr-assistant-extension-qazent-",
    [string]$SourceManifestPath = ".\\dist\\vss-extension.json"
)

$ErrorActionPreference = "Stop"

if (-not $VsixPath) {
    $vsix = Get-ChildItem -Path $VsixDirectory -Filter "$VsixPrefix*.vsix" -ErrorAction Stop |
        Sort-Object LastWriteTime |
        Select-Object -Last 1

    if (-not $vsix) {
        throw "No VSIX file found in '$VsixDirectory' matching '$VsixPrefix*.vsix'."
    }

    $VsixPath = $vsix.FullName
}

if (-not (Test-Path -LiteralPath $VsixPath)) {
    throw "VSIX file not found: $VsixPath"
}

if (-not (Test-Path -LiteralPath $SourceManifestPath)) {
    throw "Source manifest not found: $SourceManifestPath"
}

$sourceManifest = Get-Content -Raw -LiteralPath $SourceManifestPath

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($VsixPath, [System.IO.Compression.ZipArchiveMode]::Update)

try {
    $vsixEntry = $zip.GetEntry("extension.vsixmanifest")
    if (-not $vsixEntry) {
        throw "extension.vsixmanifest not found in $VsixPath"
    }

    $reader = New-Object System.IO.StreamReader($vsixEntry.Open())
    try {
        $vsixContent = $reader.ReadToEnd()
    }
    finally {
        $reader.Dispose()
    }

    $vsixUpdated = $vsixContent.Replace(
        "Microsoft.VisualStudio.Services.Links.Privacypolicy",
        "Microsoft.VisualStudio.Services.Links.PrivacyPolicy"
    )

    if (-not ($vsixUpdated -ceq $vsixContent)) {
        $vsixEntry.Delete()
        $newVsixEntry = $zip.CreateEntry("extension.vsixmanifest")
        $writer = New-Object System.IO.StreamWriter($newVsixEntry.Open())
        try {
            $writer.Write($vsixUpdated)
        }
        finally {
            $writer.Dispose()
        }
    }

    $vsoEntry = $zip.GetEntry("extension.vsomanifest")
    if ($vsoEntry) {
        $vsoEntry.Delete()
    }

    $newVsoEntry = $zip.CreateEntry("extension.vsomanifest")
    $vsoWriter = New-Object System.IO.StreamWriter($newVsoEntry.Open())
    try {
        $vsoWriter.Write($sourceManifest)
    }
    finally {
        $vsoWriter.Dispose()
    }
}
finally {
    $zip.Dispose()
}

Write-Host "Patched Marketplace manifests in $VsixPath"
