#!/usr/bin/env bash
# Validate generated e-invoices with the official tools (Docker required).
#   pnpm validate [dir]   (default: test/golden)
# *.xml → KoSIT (XRechnung 3.0.x / EN 16931 scenarios)
# *.pdf → Mustang (ZUGFeRD/Factur-X: PDF/A + XML + XMP) and veraPDF (PDF/A-3b)
# Reports are written to test/__output__/validate/<dir name>/ (git-ignored); the input dir stays untouched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$(cd "${1:-$ROOT/test/golden}" && pwd)"
TOOLS="${VALIDATE_TOOLS_DIR:-$ROOT/.validate-tools}"
REPORTS="$ROOT/test/__output__/validate/$(basename "$DIR")"
# shellcheck source=versions.env
source "$ROOT/test/validate/versions.env"

rm -rf "$REPORTS"
mkdir -p "$TOOLS" "$REPORTS"

fetch() { [ -s "$2" ] || { echo "↓ $(basename "$2")"; curl -fsSL -o "$2" "$1"; }; }
fetch "https://github.com/itplr-kosit/validator/releases/download/v${KOSIT_VALIDATOR_VERSION}/validator-${KOSIT_VALIDATOR_VERSION}-standalone.jar" "$TOOLS/kosit.jar"
fetch "$XRECHNUNG_CONFIG_URL" "$TOOLS/xrechnung-config.zip"
fetch "https://repo1.maven.org/maven2/org/mustangproject/Mustang-CLI/${MUSTANG_VERSION}/Mustang-CLI-${MUSTANG_VERSION}.jar" "$TOOLS/mustang.jar"
if [ ! -f "$TOOLS/xr/scenarios.xml" ]; then
  rm -rf "$TOOLS/xr" && mkdir -p "$TOOLS/xr"
  (cd "$TOOLS/xr" && unzip -q ../xrechnung-config.zip)
fi

java() { docker run --rm -u "$(id -u):$(id -g)" -v "$TOOLS:/tools:ro" -v "$DIR:/data:ro" -v "$REPORTS:/reports" "$JAVA_IMAGE" java "$@"; }

shopt -s nullglob
cd "$DIR"
xmls=(*.xml)
pdfs=(*.pdf)
failed=0

if [ ${#xmls[@]} -gt 0 ]; then
  echo "== KoSIT ${KOSIT_VALIDATOR_VERSION} (${#xmls[@]} XML)"
  if ! java -jar /tools/kosit.jar -s /tools/xr/scenarios.xml -r /tools/xr -o /reports "${xmls[@]/#//data/}"; then
    failed=1
  fi
fi

for pdf in "${pdfs[@]}"; do
  echo "== Mustang ${MUSTANG_VERSION}: $pdf"
  out=$(java -jar /tools/mustang.jar --no-notices --action validate --source "/data/$pdf" 2>&1 || true)
  echo "$out" > "$REPORTS/${pdf%.pdf}.mustang.xml"
  # The report has a summary for the PDF part, the XML part and, last, the whole file: only the last one counts
  overall=$(echo "$out" | grep -o '<summary status="[a-z]*"/>' | tail -n 1 || true)
  if [ "$overall" = '<summary status="valid"/>' ]; then echo "   valid"; else echo "   INVALID (see $REPORTS/${pdf%.pdf}.mustang.xml)"; failed=1; fi

  echo "== veraPDF (PDF/A-3b): $pdf"
  if docker run --rm -v "$DIR:/data:ro" "$VERAPDF_IMAGE" --flavour 3b --format text "/data/$pdf" | tee "$REPORTS/${pdf%.pdf}.verapdf.txt" | grep -q '^PASS'; then
    echo "   PASS"
  else
    echo "   FAIL (see $REPORTS/${pdf%.pdf}.verapdf.txt)"; failed=1
  fi
done

[ $failed -eq 0 ] && echo "✔ all validations passed" || { echo "✘ validation failed"; exit 1; }
