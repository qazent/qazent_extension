# Stop on errors
$ErrorActionPreference = "Stop"

Write-Host 'Loading .env variables...'

$envPath = ".env"

if (-Not (Test-Path $envPath)) {
    Write-Host 'ERROR: .env file not found in project root'
    exit 1
}

# Load .env into environment variables
Get-Content $envPath | ForEach-Object {
    if ($_ -match "^\s*#") { return }   # skip comments
    if ($_ -match "^\s*$") { return }   # skip empty lines
    $parts = $_.Split("=", 2)
    if ($parts.Length -eq 2) {
        $name = $parts[0].Trim()
        $value = $parts[1].Trim()
        Write-Host "   Loaded $name"
        [System.Environment]::SetEnvironmentVariable($name, $value)
    }
}

$publisher = "QAZent"
$extensionId = "pr-assistant-extension-qazent"
$vsixPrefix = "$publisher.$extensionId-"
$marketplaceToken = $null
$marketplaceTokenName = $null

if (-not (Test-Path "./output")) {
    New-Item -ItemType Directory -Path "./output" | Out-Null
}

Write-Host 'Removing stale packaged VSIX files for this extension...'
Get-ChildItem -Path ./output -Filter "$vsixPrefix*.vsix" -ErrorAction SilentlyContinue |
    Remove-Item -Force

Write-Host 'Building extension...'
npm run build

Write-Host 'Packaging extension from dist root...'
npm run package:extension

if ($LASTEXITCODE -ne 0) {
    Write-Host 'ERROR: Packaging failed. Aborting publish.'
    exit 1
}

# Find the newly built VSIX for the real extension only
$vsix = Get-ChildItem -Path ./output -Filter "$vsixPrefix*.vsix" |
        Sort-Object LastWriteTime |
        Select-Object -Last 1

if (-not $vsix) {
    Write-Host "ERROR: No VSIX file found after packaging for $extensionId."
    exit 1
}

Write-Host 'Found VSIX: ' $vsix.Name

if (-not [string]::IsNullOrWhiteSpace($env:ADO_PAT)) {
    $marketplaceToken = $env:ADO_PAT
    $marketplaceTokenName = 'ADO_PAT'
    Write-Host 'Using ADO_PAT for Marketplace publish.'
}
elseif (-not [string]::IsNullOrWhiteSpace($env:ADO_EXTENSION_PAT)) {
    $marketplaceToken = $env:ADO_EXTENSION_PAT
    $marketplaceTokenName = 'ADO_EXTENSION_PAT'
    Write-Host 'Using ADO_EXTENSION_PAT for Marketplace publish.'
}
else {
    Write-Host 'ERROR: No valid Marketplace PAT found. Set ADO_EXTENSION_PAT or ADO_PAT with Marketplace (publish) scope.'
    exit 1
}

Write-Host 'Publishing extension...'

tfx extension publish `
    --publisher $publisher `
    --vsix $vsix.FullName `
    --auth-type pat `
    -t $marketplaceToken `
    --trace-level debug 
    
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Publish failed using $marketplaceTokenName."
    exit 1
}

Write-Host 'Done. Extension built, packaged, and published.'
