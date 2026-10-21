#!/bin/bash
# Runs the Playwright tests for this tool headless (Chromium).
#   bash scripts/test.sh            # all tests
#   bash scripts/test.sh smoke      # only tests matching "smoke"
# Inside the factory, WEBFACTORY_HOME points at the folder that has node_modules/@playwright/test installed.
# Outside it: npm i -D @playwright/test && npx playwright install chromium && npx playwright test
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
export PORT="${PORT:-$(( 4200 + RANDOM % 3000 ))}"
if [[ -n "${WEBFACTORY_HOME:-}" && -x "$WEBFACTORY_HOME/node_modules/.bin/playwright" ]]; then
  PW="$WEBFACTORY_HOME/node_modules/.bin/playwright"
else
  PW="npx playwright"
fi
$PW test "$@"
