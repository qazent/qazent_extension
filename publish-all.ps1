# Stop on errors
$ErrorActionPreference = "Stop"

Write-Host '🔐 Loading .env variables...'

$envPath = ".env"

if (-Not (Test-Path $envPath)) {
    Write-Host '❌ .env file not found in project root'
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

Write-Host '🔨 Building extension...'
npm run build:extension

Write-Host '📦 Packaging extension (auto version bump via --rev-version)...'
npm run package:extension

# Find newest VSIX file
$vsix = Get-ChildItem -Filter "QAZent.pr-assistant-extension-*.vsix" |
        Sort-Object Name |
        Select-Object -Last 1

if (-not $vsix) {
    Write-Host '❌ No VSIX file found after packaging.'
    exit 1
}

Write-Host '📁 Found VSIX: ' $vsix.Name

if (-not $env:ADO_PAT) {
    Write-Host '❌ Missing ADO_PAT in .env'
    exit 1
}

Write-Host '🚀 Publishing extension...'

tfx extension publish `
    --publisher $publisher `
    --vsix $vsix.Name `
    --auth-type pat `
    -t $env:ADO_PAT

Write-Host '🎉 All done! Extension built, version bumped, packaged, and published.'