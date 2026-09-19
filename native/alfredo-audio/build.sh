#!/bin/sh
# Builds the system-audio recorder into ~/.alfredo/bin. Needs Xcode command line tools.
set -e
HOME_DIR="${ALFREDO_HOME:-${ALFRED_HOME:-$HOME/.alfredo}}"
mkdir -p "$HOME_DIR/bin"
cd "$(dirname "$0")"
swiftc -O -o "$HOME_DIR/bin/alfredo-audio" main.swift -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreGraphics
echo "installed $HOME_DIR/bin/alfredo-audio"
