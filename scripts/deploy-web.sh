#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="${ROOT_DIR}/web"
BUILD_DIR="${WEB_DIR}/dist"
SITE_ROOT="/opt/1panel/apps/openresty/openresty/www/sites/waha.andresptr.site"
TARGET_INDEX="${SITE_ROOT}/index"

echo "[1/3] Typechecking and building frontend in ${WEB_DIR}..."
cd "${WEB_DIR}"
npx tsc --noEmit
npm run build

if [[ ! -f "${BUILD_DIR}/index.html" ]]; then
  echo "ERROR: ${BUILD_DIR}/index.html not found after build." >&2
  exit 1
fi

if [[ ! -d "${TARGET_INDEX}" ]]; then
  echo "WARNING: Target 1Panel site directory does not exist yet: ${TARGET_INDEX}" >&2
  echo "Create the static website 'waha.andresptr.site' with SSL in 1Panel first, then re-run this script." >&2
  exit 2
fi

echo "[2/3] Syncing ${BUILD_DIR}/ -> ${TARGET_INDEX}/..."
if [[ -w "${TARGET_INDEX}" ]]; then
  rsync -a --delete "${BUILD_DIR}/" "${TARGET_INDEX}/"
else
  sudo rsync -a --delete "${BUILD_DIR}/" "${TARGET_INDEX}/"
fi

echo "[3/3] Checking HTTP health on https://waha.andresptr.site..."
curl -sI https://waha.andresptr.site | head -n 5
curl -s https://waha.andresptr.site/api/visualizer/snapshot | head -c 300
echo ""
echo "Deploy completed."
