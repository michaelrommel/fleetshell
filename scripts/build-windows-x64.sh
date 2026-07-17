#!/usr/bin/env bash
# scripts/build-windows-x64.sh
#
# Cross-compile fleetshell-client for Windows 10/11 x64 from Linux.
#
# Default output (--no-bundle): a single portable .exe
#   fleetshell-client/src-tauri/target/x86_64-pc-windows-gnu/release/fleetshell-client.exe
#
# Pass --installer to also produce an NSIS .exe installer:
#   fleetshell-client/src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/
#
# The installer is only needed if you want Start-menu shortcuts, an
# Add/Remove Programs entry, or to ship WebView2 to machines that somehow
# don't have it yet.  On Windows 10 (post-2021) and all of Windows 11,
# WebView2 ships in-box, so the bare .exe runs without any installer.
#
# Prerequisites (all checked below):
#   - rustup target add x86_64-pc-windows-gnu
#   - apt: gcc-mingw-w64-x86-64-posix  binutils-mingw-w64-x86-64
#   - apt: nsis  (only required for --installer)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLIENT_DIR="$REPO_ROOT/fleetshell-client"
TARGET="x86_64-pc-windows-gnu"
BUNDLE=false

for arg in "$@"; do
  case "$arg" in
    --installer) BUNDLE=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ── Preflight checks ──────────────────────────────────────────────────────────

echo "→ Checking Rust target…"
if ! rustup target list --installed | grep -q "$TARGET"; then
  echo "  Installing $TARGET via rustup…"
  rustup target add "$TARGET"
fi

echo "→ Checking MinGW toolchain (posix threads)…"
if ! command -v x86_64-w64-mingw32-gcc-posix &>/dev/null; then
  echo "  ERROR: x86_64-w64-mingw32-gcc-posix not found."
  echo "  Install with: sudo apt install gcc-mingw-w64-x86-64-posix"
  exit 1
fi

if $BUNDLE; then
  echo "→ Checking NSIS…"
  if ! command -v makensis &>/dev/null; then
    echo "  ERROR: makensis (NSIS) not found."
    echo "  Install with: sudo apt install nsis"
    exit 1
  fi
fi

# ── Build ─────────────────────────────────────────────────────────────────────

echo "→ Building frontend…"
cd "$CLIENT_DIR"
npm run build

if $BUNDLE; then
  echo "→ Running cargo tauri build (target: $TARGET, bundle: nsis)…"
  cargo tauri build --target "$TARGET" --bundles nsis
  echo ""
  echo "✓ Installer:"
  find "$REPO_ROOT/target/$TARGET/release/bundle" \
       -name "*.exe" 2>/dev/null | sort
else
  echo "→ Running cargo tauri build (target: $TARGET, no-bundle)…"
  cargo tauri build --target "$TARGET" --no-bundle
  EXE="$REPO_ROOT/target/$TARGET/release/fleetshell-client.exe"
  echo ""
  echo "✓ Portable executable: $EXE"
  ls -lh "$EXE"
fi
