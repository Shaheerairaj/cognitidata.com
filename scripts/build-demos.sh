#!/usr/bin/env bash
# Builds the Intelligence Hub demo and copies it into public/demos/ so Astro serves it at
# /demos/intelligence-hub/. Proposal Foundry is a prebuilt folder, already in public/demos/.
# The licensed Futura PT files are left out of the public copy.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
hub="$root/demos/intelligence-hub"
out="$root/public/demos/intelligence-hub"

(cd "$hub" && npm ci && npm run build)
rm -rf "$out"
mkdir -p "$out"
rsync -a --exclude 'fonts/FuturaPT*' "$hub/dist/" "$out/"
echo "Intelligence Hub copied to public/demos/intelligence-hub"
