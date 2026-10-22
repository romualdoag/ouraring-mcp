#!/usr/bin/env bash
# Install repo git hooks (run once per clone):  npm run setup:hooks
# The pre-push hook rebuilds and runs the full suite; a failing test blocks the push.
set -euo pipefail
HOOK_DIR="$(git rev-parse --git-dir)/hooks"
mkdir -p "$HOOK_DIR"
cat > "$HOOK_DIR/pre-push" <<'EOF'
#!/usr/bin/env bash
# ouraring-mcp pre-push gate: no green tests, no push.
set -euo pipefail
echo "pre-push: npm run build + vitest..."
npm run build >/dev/null
npx vitest run
EOF
chmod +x "$HOOK_DIR/pre-push"
echo "pre-push hook installed."
