#!/usr/bin/env bash
# Start the KoSIT validator in daemon mode (Docker), as used by KositHttpValidator.
#   bash test/validate/kosit-daemon.sh [port]   (default 8080; stop with: docker rm -f e-invoice-kosit)
# Then: KOSIT_URL=http://localhost:8080/ pnpm vitest run test/unit/validator.spec.ts
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="${VALIDATE_TOOLS_DIR:-$ROOT/.validate-tools}"
PORT="${1:-8080}"
# shellcheck source=versions.env
source "$ROOT/test/validate/versions.env"

mkdir -p "$TOOLS"
fetch() { [ -s "$2" ] || { echo "↓ $(basename "$2")"; curl -fsSL -o "$2" "$1"; }; }
fetch "https://github.com/itplr-kosit/validator/releases/download/v${KOSIT_VALIDATOR_VERSION}/validator-${KOSIT_VALIDATOR_VERSION}-standalone.jar" "$TOOLS/kosit.jar"
fetch "$XRECHNUNG_CONFIG_URL" "$TOOLS/xrechnung-config.zip"
if [ ! -f "$TOOLS/xr/scenarios.xml" ]; then
  rm -rf "$TOOLS/xr" && mkdir -p "$TOOLS/xr"
  (cd "$TOOLS/xr" && unzip -q ../xrechnung-config.zip)
fi

docker rm -f e-invoice-kosit >/dev/null 2>&1 || true
docker run -d --name e-invoice-kosit -p "$PORT:8080" -v "$TOOLS:/tools:ro" "$JAVA_IMAGE" \
  java -jar /tools/kosit.jar -s /tools/xr/scenarios.xml -r /tools/xr -D -H 0.0.0.0 -P 8080 >/dev/null

for _ in $(seq 1 60); do
  if curl -s -o /dev/null -X POST -H 'Content-Type: application/xml' --data-binary @"$ROOT/test/golden/b2b-net.xrechnung-cii.xml" "http://localhost:$PORT/"; then
    echo "KoSIT daemon ready on http://localhost:$PORT/"
    exit 0
  fi
  sleep 1
done
echo "KoSIT daemon did not start" >&2
docker logs e-invoice-kosit >&2
exit 1
