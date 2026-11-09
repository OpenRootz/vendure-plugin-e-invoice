#!/usr/bin/env bash
# Validate generated e-invoices with the official tools (Docker required).
#   pnpm validate [dir]   (default: test/validate/samples)
# *.xml → KoSIT (XRechnung 3.0.x / EN 16931 scenarios)
# *.pdf → Mustang (ZUGFeRD/Factur-X: PDF/A + XML + XMP) and veraPDF (PDF/A-3b)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$(cd "${1:-$ROOT/test/validate/samples}" && pwd)"
TOOLS="${VALIDATE_TOOLS_DIR:-$ROOT/.validate-tools}"
REPORTS="$DIR/reports"
# shellcheck source=versions.env
source "$ROOT/test/validate/versions.env"

mkdir -p "$TOOLS" "$REPORTS"

fetch() { [ -s "$2" ] || { echo "↓ $(basename "$2")"; curl -fsSL -o "$2" "$1"; }; }
fetch "https://github.com/itplr-kosit/validator/releases/download/v${KOSIT_VALIDATOR_VERSION}/validator-${KOSIT_VALIDATOR_VERSION}-standalone.jar" "$TOOLS/kosit.jar"
fetch "$XRECHNUNG_CONFIG_URL" "$TOOLS/xrechnung-config.zip"
fetch "https://repo1.maven.org/maven2/org/mustangproject/Mustang-CLI/${MUSTANG_VERSION}/Mustang-CLI-${MUSTANG_VERSION}.jar" "$TOOLS/mustang.jar"
if [ ! -f "$TOOLS/xr/scenarios.xml" ]; then
  rm -rf "$TOOLS/xr" && mkdir -p "$TOOLS/xr"
  (cd "$TOOLS/xr" && unzip -q ../xrechnung-config.zip)
fi

java() { docker run --rm -u "$(id -u):$(id -g)" -v "$TOOLS:/tools:ro" -v "$DIR:/data" "$JAVA_IMAGE" java "$@"; }

shopt -s nullglob
cd "$DIR"
xmls=(*.xml)
pdfs=(*.pdf)
failed=0

if [ ${#xmls[@]} -gt 0 ]; then
  echo "== KoSIT ${KOSIT_VALIDATOR_VERSION} (${#xmls[@]} XML)"
  if ! java -jar /tools/kosit.jar -s /tools/xr/scenarios.xml -r /tools/xr -o /data/reports "${xmls[@]/#//data/}"; then
    failed=1
  fi
fi

for pdf in "${pdfs[@]}"; do
  echo "== Mustang ${MUSTANG_VERSION}: $pdf"
  out=$(java -jar /tools/mustang.jar --no-notices --action validate --source "/data/$pdf" 2>&1 || true)
  echo "$out" > "$REPORTS/${pdf%.pdf}.mustang.xml"
  if echo "$out" | grep -q 'status="valid"'; then echo "   valid"; else echo "   INVALID (see reports/${pdf%.pdf}.mustang.xml)"; failed=1; fi

  echo "== veraPDF (PDF/A-3b): $pdf"
  if docker run --rm -v "$DIR:/data:ro" "$VERAPDF_IMAGE" --flavour 3b --format text "/data/$pdf" | tee "$REPORTS/${pdf%.pdf}.verapdf.txt" | grep -q '^PASS'; then
    echo "   PASS"
  else
    echo "   FAIL (see reports/${pdf%.pdf}.verapdf.txt)"; failed=1
  fi
done

[ $failed -eq 0 ] && echo "✔ all validations passed" || { echo "✘ validation failed"; exit 1; }
