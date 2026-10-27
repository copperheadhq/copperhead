#!/usr/bin/env bash
# copperhead bootstrap installer.
#
# Checks the prerequisites (Node >= 20, git, KiCad's kicad-cli), installs
# copperhead itself, and verifies the result with `copperhead doctor`.
#
# Conservative by design: it never runs sudo, never edits shell config, and
# prints the exact command for you to run whenever it cannot act safely on its
# own. Idempotent: rerunning on a ready machine installs nothing and exits 0.
#
# Usage:
#   ./install.sh                 interactive: asks before installing anything
#   ./install.sh --yes           assume yes (still never sudo)
#   ./install.sh --check-only    report what is missing, install nothing
#
# Supported platforms: macOS and Linux. Exit code 0 means node, git,
# kicad-cli, and copperhead are all usable; 1 means at least one is still
# missing (the report says which, and how to fix it).

set -euo pipefail

MIN_NODE_MAJOR=20

ASSUME_YES=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m'); RESET=$(printf '\033[0m')
else
  BOLD=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

# One line per check: `step` sets a pending section label and the next status
# line prints it in a fixed-width column; continuation lines align under the
# status column.
STEP=''
step()  { STEP="$1"; }
_label() {
  if [ -n "$STEP" ]; then
    printf '%s' "$BOLD"; printf '%-23s' "$STEP"; printf '%s' "$RESET"
    STEP=''
  else
    printf '%-23s' ''
  fi
}
ok()   { _label; printf '%sok%s    %s\n' "$GREEN" "$RESET" "$1"; }
fail() { _label; printf '%sfail%s  %s\n' "$RED" "$RESET" "$1"; }
info() { _label; printf '%sinfo%s  %s\n' "$YELLOW" "$RESET" "$1"; }

# Ask for consent before any install. Non-interactive shells default to no,
# so `curl | bash` without --yes can only ever report, never install.
confirm() {
  if [ "$CHECK_ONLY" = 1 ]; then return 1; fi
  if [ "$ASSUME_YES" = 1 ]; then return 0; fi
  if [ ! -t 0 ]; then
    info "non-interactive shell: skipping (\"$1\"); rerun with --yes to allow it"
    return 1
  fi
  _label; printf '%s [y/N] ' "$1"
  read -r reply
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ---------- platform ----------

OS=$(uname -s)
case "$OS" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *)
    echo "unsupported platform: $OS (this script supports macOS and Linux)" >&2
    exit 1
    ;;
esac

PKG_MANAGER=""
for pm in brew apt-get dnf pacman zypper; do
  if command -v "$pm" >/dev/null 2>&1; then PKG_MANAGER=$pm; break; fi
done

kicad_install_hint() {
  case "$PKG_MANAGER" in
    brew)    echo "brew install --cask kicad" ;;
    apt-get) echo "sudo apt-get install kicad" ;;
    dnf)     echo "sudo dnf install kicad" ;;
    pacman)  echo "sudo pacman -S kicad" ;;
    zypper)  echo "sudo zypper install kicad" ;;
    *)       echo "download KiCad from https://www.kicad.org/download/" ;;
  esac
}

node_install_hint() {
  case "$PKG_MANAGER" in
    brew) echo "brew install node" ;;
    *)    echo "install Node >= ${MIN_NODE_MAJOR} from https://nodejs.org/ (or via nvm: https://github.com/nvm-sh/nvm)" ;;
  esac
}

git_install_hint() {
  case "$PKG_MANAGER" in
    brew)    echo "brew install git" ;;
    apt-get) echo "sudo apt-get install git" ;;
    dnf)     echo "sudo dnf install git" ;;
    pacman)  echo "sudo pacman -S git" ;;
    zypper)  echo "sudo zypper install git" ;;
    *)       echo "install git from https://git-scm.com/downloads" ;;
  esac
}

echo "${BOLD}copperhead bootstrap (${PLATFORM}${PKG_MANAGER:+, package manager: $PKG_MANAGER})${RESET}"

MISSING=0

# ---------- node ----------

step "1/4 Node.js"
if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node --version)
  NODE_MAJOR=${NODE_VERSION#v}; NODE_MAJOR=${NODE_MAJOR%%.*}
  if [ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    ok "node $NODE_VERSION (>= $MIN_NODE_MAJOR)"
  else
    fail "node $NODE_VERSION is too old (copperhead needs >= $MIN_NODE_MAJOR)"
    info "upgrade: $(node_install_hint)"
    MISSING=1
  fi
else
  fail "node not found on PATH"
  info "install: $(node_install_hint)"
  MISSING=1
fi

# ---------- git ----------

step "2/4 git"
if command -v git >/dev/null 2>&1; then
  ok "$(git --version)"
else
  fail "git not found on PATH (copperhead snapshots and commits its work)"
  info "install: $(git_install_hint)"
  MISSING=1
fi

# ---------- kicad-cli ----------

step "3/4 KiCad (kicad-cli)"
if command -v kicad-cli >/dev/null 2>&1; then
  ok "kicad-cli $(kicad-cli version 2>/dev/null || echo '(version probe failed)')"
else
  # On macOS the binary ships inside the app bundle and is not on PATH by
  # default; detect that case and print the PATH line instead of a reinstall.
  MAC_KICAD_BIN="/Applications/KiCad/KiCad.app/Contents/MacOS"
  if [ "$PLATFORM" = macos ] && [ -x "$MAC_KICAD_BIN/kicad-cli" ]; then
    fail "KiCad is installed but kicad-cli is not on PATH"
    info "add it yourself (this script never edits shell config):"
    info "  echo 'export PATH=\"\$PATH:$MAC_KICAD_BIN\"' >> ~/.zprofile && exec zsh"
  else
    fail "kicad-cli not found on PATH (copperhead verifies every edit with ERC/DRC)"
    info "install KiCad >= 8: $(kicad_install_hint)"
    if [ "$PLATFORM" = macos ]; then
      info "then put kicad-cli on PATH (it ships inside KiCad.app/Contents/MacOS)"
    fi
  fi
  MISSING=1
fi

# ---------- copperhead ----------

step "4/4 copperhead"
in_repo_checkout() {
  [ -f package.json ] && grep -q '"name": "copperhead"' package.json
}

if command -v copperhead >/dev/null 2>&1; then
  ok "copperhead $(copperhead --version 2>/dev/null || echo '(already on PATH)')"
elif ! command -v npm >/dev/null 2>&1; then
  fail "npm not found (comes with Node); fix the Node.js step first"
  MISSING=1
elif in_repo_checkout; then
  info "running from a copperhead source checkout"
  if ! confirm "build from source and link it globally (npm install && npm run build && npm link)?"; then
    info "skipped; install later with: npm install && npm run build && npm link"
    MISSING=1
  # Refuse to build a dirty checkout: npm install may rewrite package-lock.json,
  # and a linked binary should correspond to a committed state. Print the
  # commands instead of acting (conservative-by-design contract).
  elif git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -n "$(git status --porcelain)" ]; then
    fail "this checkout has uncommitted changes; refusing to build and link from a dirty tree"
    info "commit or stash them, then rerun; or build manually: npm install && npm run build && npm link"
    MISSING=1
  else
    npm install
    npm run build
    if npm link; then
      hash -r 2>/dev/null || true
      if command -v copperhead >/dev/null 2>&1; then
        ok "linked: copperhead $(copperhead --version 2>/dev/null || true) at $(command -v copperhead)"
      else
        info "linked into $(npm prefix -g)/bin, which is not on PATH; add it or run in place: node dist/cli.js"
        MISSING=1
      fi
    else
      fail "npm link failed (usually a permissions issue with the global npm prefix)"
      info "either fix the prefix (https://docs.npmjs.com/resolving-eacces-permissions-errors) or run it in place: node dist/cli.js"
      MISSING=1
    fi
  fi
else
  if confirm "install copperhead globally (npm install -g copperhead)?"; then
    if npm install -g copperhead; then
      hash -r 2>/dev/null || true
      if command -v copperhead >/dev/null 2>&1; then
        ok "installed: copperhead $(copperhead --version 2>/dev/null || true) -> $(command -v copperhead)"
      else
        info "installed into $(npm prefix -g)/bin, which is not on PATH; add it or use npx: npx copperhead check"
        MISSING=1
      fi
    else
      fail "npm install -g failed (usually a permissions issue with the global npm prefix)"
      info "either fix the prefix (https://docs.npmjs.com/resolving-eacces-permissions-errors) or use npx: npx copperhead check"
      MISSING=1
    fi
  else
    info "skipped; install later with: npm install -g copperhead (or use npx copperhead)"
    MISSING=1
  fi
fi

# ---------- verify ----------

step "Verification"
if [ "$MISSING" = 0 ]; then
  # doctor exits 1 when any critical check fails, including a missing model
  # API key. A fresh machine has no key yet, so that alone is a next step,
  # not a bootstrap failure; the tool checks above are what this script gates on.
  # Older copperhead releases predate `doctor`; probe before relying on it.
  # (probe the help listing: commander answers `doctor --help` with the global
  # help and exit 0 even when the subcommand does not exist)
  if copperhead --help 2>/dev/null | grep -qE '^[[:space:]]+doctor'; then
    if DOCTOR_OUT=$(copperhead doctor 2>&1); then
      ok "environment ready (copperhead doctor passed)"
    else
      info "copperhead doctor reports remaining setup (typically the model backend):"
      # shellcheck disable=SC2001  # multi-line indent: sed beats ${var//}
      echo "$DOCTOR_OUT" | sed 's/^/      /'
    fi
  else
    info "this copperhead ($(copperhead --version 2>/dev/null || true)) predates \`copperhead doctor\`; tools were verified individually above"
    info "upgrade later with: npm install -g copperhead@latest"
  fi
  echo "${GREEN}${BOLD}done.${RESET} next: run ${BOLD}copperhead init${RESET} in a KiCad repo, then ${BOLD}copperhead check${RESET}"
  exit 0
else
  fail "some prerequisites are missing; follow the guidance above and rerun this script"
  info "rerunning is safe: the script is idempotent and skips whatever is already set up"
  exit 1
fi
