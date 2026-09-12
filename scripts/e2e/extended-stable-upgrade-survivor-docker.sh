#!/usr/bin/env bash
set -euo pipefail

HARNESS_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASELINE_SPEC="openclaw@2026.6.35"

run_survivor() {
  local restart_mode="$1"
  OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1 \
    OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC="$BASELINE_SPEC" \
    OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL=extended-stable \
    OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_INCLUDE_CORE=1 \
    OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE="$restart_mode" \
    OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR="${OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT:-$HARNESS_ROOT_DIR/.artifacts/upgrade-survivor/extended-stable-2026.6.35}/$restart_mode" \
    OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT:-1500s}" \
    bash "$HARNESS_ROOT_DIR/scripts/e2e/upgrade-survivor-docker.sh"
}

run_survivor manual
run_survivor auto-auth
