#!/bin/bash
# Wait until the dev shell answers Eval (up to 60 s).
DIR=$(dirname "$0")
for _ in $(seq 60); do
    "$DIR/shell-eval.sh" 1 2>/dev/null | grep -q '^(true' && exit 0
    sleep 1
done
echo "dev shell not ready" >&2
exit 1
