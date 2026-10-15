#!/usr/bin/env bash
# Downloads AWS's official DynamoDB Local into ./.tools/dynamodb-local (gitignored),
# verifying the published SHA-256 first. Needs Java 11+. Docker is not required.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.tools/dynamodb-local"
BASE="https://d1ni2b6xgvw0s0.cloudfront.net/v2.x"

if [ -f "$DEST/DynamoDBLocal.jar" ]; then echo "already installed: $DEST"; exit 0; fi
command -v java >/dev/null || { echo "Java 11+ is required" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/ddb.tar.gz" "$BASE/dynamodb_local_latest.tar.gz"
curl -fsSL -o "$TMP/ddb.sha256" "$BASE/dynamodb_local_latest.tar.gz.sha256"

want="$(awk '{print $1}' "$TMP/ddb.sha256")"
got="$(shasum -a 256 "$TMP/ddb.tar.gz" | awk '{print $1}')"
[ "$want" = "$got" ] || { echo "checksum mismatch: wanted $want, got $got" >&2; exit 1; }

mkdir -p "$DEST"
tar xzf "$TMP/ddb.tar.gz" -C "$DEST"
echo "installed DynamoDB Local to $DEST (sha256 verified)"
