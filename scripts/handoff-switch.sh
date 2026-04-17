#!/usr/bin/env bash
# handoff-switch.sh — wrapper invoked by handoff-switch.desktop or a DE
# keyboard shortcut. Prompts for a target tool and runs `handoff switch`
# in the current working directory.
#
# Install: drop into ~/.local/bin/ (or anywhere on PATH) and `chmod +x`.
# Takes the tool name as $1 if given; otherwise prompts via zenity/kdialog,
# and falls back to a terminal `read` prompt if neither is available.

set -euo pipefail

tool="${1:-}"

if [ -z "${tool}" ]; then
  if command -v zenity >/dev/null 2>&1; then
    tool=$(zenity --entry \
      --title="handoff switch" \
      --text="Switch to which tool? (claude-code | cursor | codex | gemini | generic)" \
      --entry-text="cursor") || exit 0
  elif command -v kdialog >/dev/null 2>&1; then
    tool=$(kdialog --inputbox \
      "Switch to which tool? (claude-code | cursor | codex | gemini | generic)" \
      "cursor") || exit 0
  else
    read -rp "Switch to which tool? " tool
  fi
fi

tool="$(echo "${tool}" | xargs)"  # trim whitespace
[ -z "${tool}" ] && exit 0

cd "${PWD:-$HOME}"
exec handoff switch "${tool}"
