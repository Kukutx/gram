#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v pnpm >/dev/null || { echo 'Install pnpm 10 first.' >&2; exit 1; }
# Must run on an Internet-connected machine; this does not fake a lockfile.
pnpm install --lockfile-only
pnpm install --frozen-lockfile
printf '\nLockfile created and verified. Commit pnpm-lock.yaml before production deployment.\n'
