#!/usr/bin/env bash
# Runs DynamoDB Local in memory on :8000 (override with DDB_PORT).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
D="$ROOT/.tools/dynamodb-local"
[ -f "$D/DynamoDBLocal.jar" ] || { echo "run: pnpm ddb:setup" >&2; exit 1; }
exec java -Djava.library.path="$D/DynamoDBLocal_lib" -jar "$D/DynamoDBLocal.jar" -inMemory -port "${DDB_PORT:-8000}"
