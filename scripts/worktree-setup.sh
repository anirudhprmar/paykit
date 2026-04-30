#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git worktree list | head -1 | awk '{print $1}')

ln -sf "$ROOT/.env" ./
ln -sf "$ROOT/apps/web/.env" ./apps/web/
ln -sf "$ROOT/apps/demo/.env" ./apps/demo/
ln -sf "$ROOT/ob" ./ob
bun install
