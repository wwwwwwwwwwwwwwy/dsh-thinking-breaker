#!/usr/bin/env bash
# Thin wrapper so the same local check can be run as `./check.sh` from any shell.
set -euo pipefail
cd "$(dirname "$0")"
exec node tools/check.mjs "$@"
