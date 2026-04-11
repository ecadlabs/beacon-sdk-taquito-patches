#!/usr/bin/env bash
set -euo pipefail

NPM11_DIR="${NPM11_DIR:-/tmp/beacon-sdk-npm11}"
NPM11_CLI="$NPM11_DIR/node_modules/npm/bin/npm-cli.js"

if [ ! -f "$NPM11_CLI" ]; then
  mkdir -p "$NPM11_DIR"
  npm install --prefix "$NPM11_DIR" npm@11.12.1
fi

exec node "$NPM11_CLI" "$@"
