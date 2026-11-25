#!/usr/bin/env bash
# Fetch the optional external engines copperhead's placers and routers wrap
# (ADR 0008) into vendor/tools/ (git-ignored): a Temurin JRE 25 and the
# Freerouting jar, and a Python venv with kicad-tools. Nothing is bundled with
# copperhead; the wrappers discover these paths (or COPPERHEAD_* overrides) at
# runtime. These are copperhead's engine toolchain, not benchmark data: the
# benchmark that exercises them lives in the copperbench repository.
#
# Usage: scripts/tools.sh [jre|freerouting|kicad-tools|pyplacer|all]   (default: all)
set -euo pipefail
cd "$(dirname "$0")/.."
T=vendor/tools
mkdir -p "$T"
FREEROUTING_VERSION=2.4.1
PYPLACER_COMMIT=34baa02
what="${1:-all}"
fetch_jre() {
  [ -x "$T/jre25/bin/java" ] && { echo "jre: present"; return; }
  echo "jre: fetching Temurin 25 (Freerouting $FREEROUTING_VERSION needs class file 69)"
  curl -sSL -m 600 -o "$T/jre25.tar.gz" "https://api.adoptium.net/v3/binary/latest/25/ga/linux/x64/jre/hotspot/normal/eclipse?project=jdk"
  mkdir -p "$T/jre25" && tar xzf "$T/jre25.tar.gz" -C "$T/jre25" --strip-components=1 && rm "$T/jre25.tar.gz"
  "$T/jre25/bin/java" -version 2>&1 | head -1
}
fetch_freerouting() {
  [ -f "$T/freerouting-$FREEROUTING_VERSION.jar" ] && { echo "freerouting: present"; return; }
  echo "freerouting: fetching $FREEROUTING_VERSION (GPL-3.0, runs out of process)"
  curl -sSL -m 600 -o "$T/freerouting-$FREEROUTING_VERSION.jar" "https://github.com/freerouting/freerouting/releases/download/v$FREEROUTING_VERSION/freerouting-$FREEROUTING_VERSION.jar"
  ls -la "$T/freerouting-$FREEROUTING_VERSION.jar" | awk '{print $5" bytes"}'
}
fetch_kicad_tools() {
  [ -x "$T/kt-venv/bin/kct" ] && { echo "kicad-tools: present"; return; }
  PY="$(command -v python3.10 || command -v python3.11 || command -v python3.12 || command -v python3)"
  echo "kicad-tools: creating venv with $PY"
  "$PY" -m venv "$T/kt-venv"
  "$T/kt-venv/bin/pip" install -q "kicad-tools==0.20.0" numpy
  "$T/kt-venv/bin/kct" --version 2>&1 | head -1 || true
}
fetch_pyplacer() {
  [ -f "$T/pyplacer/run.py" ] && { echo "pyplacer: present"; return; }
  echo "pyplacer: cloning at $PYPLACER_COMMIT (BSD-3-Clause)"
  git clone -q https://github.com/ajokela/pyplacer.git "$T/pyplacer" && git -C "$T/pyplacer" checkout -q "$PYPLACER_COMMIT"
}
case "$what" in
  jre) fetch_jre ;;
  freerouting) fetch_freerouting ;;
  kicad-tools) fetch_kicad_tools ;;
  pyplacer) fetch_pyplacer ;;
  all) fetch_jre; fetch_freerouting; fetch_kicad_tools; fetch_pyplacer ;;
  *) echo "unknown target $what" >&2; exit 1 ;;
esac
