#!/usr/bin/env bash
# The one check: type-check src/, build and run every test, and confirm the
# retired project identity appears nowhere in the repository.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x node_modules/.bin/tsc ]; then
  echo "tsc missing: run npm install" >&2
  exit 1
fi
node_modules/.bin/tsc -p tsconfig.json --noEmit
echo "tsc: clean"
node scripts/check-names.mjs
npm test
