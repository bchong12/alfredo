#!/bin/sh
# Builds FluidAudio's command-line tool, which Alfredo uses to run Parakeet on
# your Mac. Needs Xcode command line tools (swift). Takes a few minutes the
# first time; the result lands in ~/.alfredo/bin/fluidaudiocli.
set -e
HOME_DIR="${ALFREDO_HOME:-${ALFRED_HOME:-$HOME/.alfredo}}"
SRC="$HOME_DIR/src/FluidAudio"
VERSION="v0.13.6"
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/src"
if [ ! -d "$SRC" ]; then
  git clone -q --depth 1 --branch "$VERSION" https://github.com/FluidInference/FluidAudio.git "$SRC"
fi
cd "$SRC"
swift build -c release --product fluidaudiocli
cp .build/release/fluidaudiocli "$HOME_DIR/bin/fluidaudiocli"
echo "installed $HOME_DIR/bin/fluidaudiocli"
