#!/usr/bin/env bash
# Shared git settings for safe Ycode update merge + AI repair workflows.
set -euo pipefail
git config merge.conflictStyle zdiff3
git config rerere.enabled true
git config merge.ours.name "MasjidWeb keep ours"
git config merge.ours.driver true
