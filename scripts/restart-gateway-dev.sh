#!/usr/bin/env bash
set -euo pipefail

pnpm build
pnpm openclaw gateway restart
