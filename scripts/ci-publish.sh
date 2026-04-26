#!/usr/bin/env bash
set -euo pipefail

# CI equivalent of src/backend/utils/publish-all.ps1
# Uses pipeline environment variables instead of .env
#
# Required env vars:
#   MARKETPLACE_PAT  — Azure DevOps Marketplace PAT with publish scope

PUBLISHER="QAZent"
EXTENSION_ID="pr-assistant-extension-qazent"
VSIX_PREFIX="${PUBLISHER}.${EXTENSION_ID}-"
OUTPUT_DIR="./output"

if [ -z "${MARKETPLACE_PAT:-}" ]; then
  echo "##vso[task.logissue type=error]MARKETPLACE_PAT is not set. Provide a PAT with Marketplace (publish) scope."
  exit 1
fi

# ── Bump patch version ───────────────────────────────
echo "=== Bumping patch version in vss-extension.json ==="
CURRENT_VERSION=$(node -p "require('./vss-extension.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
echo "  ${CURRENT_VERSION} → ${NEW_VERSION}"

node -e "
  const fs = require('fs');
  const manifest = JSON.parse(fs.readFileSync('vss-extension.json', 'utf8'));
  manifest.version = '${NEW_VERSION}';
  fs.writeFileSync('vss-extension.json', JSON.stringify(manifest, null, 2) + '\n');
"

# ── Clean stale VSIX files ───────────────────────────
mkdir -p "$OUTPUT_DIR"
echo "=== Removing stale VSIX files ==="
rm -f "${OUTPUT_DIR}/${VSIX_PREFIX}"*.vsix

# ── Build ────────────────────────────────────────────
echo "=== Building extension + backend ==="
npm run build

# ── Package ──────────────────────────────────────────
echo "=== Packaging extension from dist ==="
tfx extension create --root dist --manifest-globs vss-extension.json --output-path "$OUTPUT_DIR"

# ── Patch marketplace manifests ──────────────────────
echo "=== Patching marketplace manifests ==="
pwsh -ExecutionPolicy Bypass -File scripts/patch-marketplace-manifests.ps1 \
  -VsixDirectory "$OUTPUT_DIR" \
  -VsixPrefix "$VSIX_PREFIX" \
  -SourceManifestPath ./dist/vss-extension.json

# ── Locate VSIX ─────────────────────────────────────
VSIX_FILE=$(find "$OUTPUT_DIR" -name "${VSIX_PREFIX}*.vsix" -type f | sort | tail -1)
if [ -z "$VSIX_FILE" ]; then
  echo "##vso[task.logissue type=error]No VSIX file found after packaging for ${EXTENSION_ID}."
  exit 1
fi
echo "Found VSIX: $VSIX_FILE"

# ── Publish ──────────────────────────────────────────
echo "=== Publishing to Azure DevOps Marketplace ==="
tfx extension publish \
  --publisher "$PUBLISHER" \
  --vsix "$VSIX_FILE" \
  --auth-type pat \
  -t "$MARKETPLACE_PAT" \
  --trace-level info

echo "=== Done — extension v${NEW_VERSION} built, packaged, and published ==="
