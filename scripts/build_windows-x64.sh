#!/usr/bin/env bash
# scripts/build-windows-x64.sh
#
# Cross-compile fleetshell-client for Windows 10/11 x64 from Linux.
#
# Default output (--no-bundle): a portable directory with .exe + required DLLs
#   dist/fleetshell-client-portable/
#     fleetshell-client.exe
#     WebView2Loader.dll        ← required when using the GNU toolchain
#
# Pass --installer to also produce an NSIS .exe installer:
#   dist/fleetshell-client-<version>-x64-setup.exe
#
# The NSIS installer:
#   - Runs without administrator rights (currentUser mode).
#   - Installs to %LOCALAPPDATA%\Programs\fleetshell-client by default.
#   - Writes uninstall info to HKCU (no HKLM touch).
#   - Automatically bundles WebView2Loader.dll (GNU toolchain requirement).
#   - Registers the fleetshell:// URL scheme in HKCU on first launch
#     (handled by tauri-plugin-deep-link, no elevation needed).
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
DIST="$REPO_ROOT/dist"

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

mkdir -p "$DIST"

if $BUNDLE; then
  echo "→ Running cargo tauri build (target: $TARGET, bundle: nsis)…"
  cargo tauri build --target "$TARGET" --bundles nsis

  # Copy the installer into dist/
  INSTALLER=$(find "$REPO_ROOT/target/$TARGET/release/bundle/nsis" \
                   -name "*-setup.exe" 2>/dev/null | sort | tail -1)
  if [[ -n "$INSTALLER" ]]; then
    cp "$INSTALLER" "$DIST/"
    echo ""
    echo "✓ Installer: $DIST/$(basename "$INSTALLER")"
    echo "  No administrator rights required — installs to %LOCALAPPDATA%\\Programs"
    ls -lh "$DIST/$(basename "$INSTALLER")"
  fi
else
  echo "→ Running cargo tauri build (target: $TARGET, no-bundle)…"
  cargo tauri build --target "$TARGET" --no-bundle

  RELEASE_DIR="$REPO_ROOT/target/$TARGET/release"
  EXE="$RELEASE_DIR/fleetshell-client.exe"

  # WebView2Loader.dll is placed next to the exe by the webview2-com-sys build
  # script whenever the GNU toolchain is used.  Both files must be distributed
  # together — the exe will fail to start without the DLL on the target machine.
  DLL="$RELEASE_DIR/WebView2Loader.dll"

  PORTABLE_DIR="$DIST/fleetshell-client-portable"
  mkdir -p "$PORTABLE_DIR"
  cp "$EXE" "$PORTABLE_DIR/"

  if [[ -f "$DLL" ]]; then
    cp "$DLL" "$PORTABLE_DIR/"
    echo ""
    echo "✓ Portable build: $PORTABLE_DIR"
    ls -lh "$PORTABLE_DIR"
  else
    echo ""
    echo "⚠ WebView2Loader.dll not found in $RELEASE_DIR"
    echo "  The exe was copied, but the DLL is missing."
    echo "  Try a full 'cargo tauri build' (not --no-bundle) once to populate it,"
    echo "  or copy x64/WebView2Loader.dll from the webview2-com-sys crate manually."
    echo ""
    echo "✓ Portable exe only: $PORTABLE_DIR/fleetshell-client.exe"
    ls -lh "$PORTABLE_DIR/fleetshell-client.exe"
  fi
fi
