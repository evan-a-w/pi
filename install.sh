#!/usr/bin/env bash
set -euo pipefail

# install.sh — install pi and pi-server wrappers for development
#
# Installs workspace dependencies, then creates thin wrappers that run the
# TypeScript source directly via tsx, matching how pi-test.sh works. No build
# step needed.
#
# Usage:
#   ./install.sh                  # install to /usr/local/bin (default)
#   PREFIX=~/.local/bin ./install.sh
#   ./install.sh ~/.local/bin

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-${1:-/usr/local/bin}}"
TSX="$REPO_ROOT/node_modules/.bin/tsx"
TSCONFIG="$REPO_ROOT/tsconfig.json"

if ! command -v npm >/dev/null 2>&1; then
	echo "error: npm is required to install dependencies" >&2
	exit 1
fi

echo "==> Installing dependencies"
npm --prefix "$REPO_ROOT" install --ignore-scripts

mkdir -p "$PREFIX"

echo "==> Installing to $PREFIX"

# pi
cat > "$PREFIX/pi" << EOF
#!/usr/bin/env bash
exec "$TSX" --tsconfig "$TSCONFIG" "$REPO_ROOT/packages/coding-agent/src/cli.ts" "\$@"
EOF
chmod +x "$PREFIX/pi"
echo "    pi"

# pi-server
cat > "$PREFIX/pi-server" << EOF
#!/usr/bin/env bash
exec "$TSX" --tsconfig "$TSCONFIG" "$REPO_ROOT/packages/dashboard/src/cli.ts" "\$@"
EOF
chmod +x "$PREFIX/pi-server"
echo "    pi-server"

echo
echo "Done. Make sure $PREFIX is in your PATH."
echo "  pi --help"
echo "  pi-server --help"
