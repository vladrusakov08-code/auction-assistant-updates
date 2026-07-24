#!/bin/zsh
set -euo pipefail

if (( $# < 3 )); then
  echo "Usage: ./release.sh /path/to/script.user.js VERSION \"release notes\""
  exit 1
fi

SOURCE_SCRIPT="$1"
VERSION="$2"
NOTES="$3"
REPO_DIR="${0:A:h}"
GH_BIN="${GH_BIN:-$REPO_DIR/../../tools/gh}"

[[ -f "$SOURCE_SCRIPT" ]] || { echo "Missing userscript: $SOURCE_SCRIPT"; exit 1; }
grep -q "^// @version      $VERSION$" "$SOURCE_SCRIPT" ||
  { echo "Userscript metadata does not match version $VERSION"; exit 1; }
if grep -Eiq 'arcade|SAVE BETA|tools\.beta|-[[:space:]]*beta|beta'\''?' "$SOURCE_SCRIPT"; then
  echo "Release rejected: beta or arcade marker found"
  exit 1
fi

osascript -l JavaScript -e \
  "ObjC.import('Foundation'); var s=\$.NSString.stringWithContentsOfFileEncodingError('$SOURCE_SCRIPT',\$.NSUTF8StringEncoding,null).js; new Function(s);" \
  >/dev/null

cp "$SOURCE_SCRIPT" "$REPO_DIR/ove-auction-assistant.user.js"
RELEASED_AT="$(date -Iseconds)"
cat > "$REPO_DIR/latest.json" <<EOF
{
  "version": "$VERSION",
  "scriptUrl": "https://raw.githubusercontent.com/vladrusakov08-code/auction-assistant-updates/main/ove-auction-assistant.user.js",
  "releasedAt": "$RELEASED_AT",
  "notes": "$NOTES"
}
EOF

git -C "$REPO_DIR" add ove-auction-assistant.user.js latest.json release.sh
git -C "$REPO_DIR" commit -m "Release Auction Assistant $VERSION"
git -C "$REPO_DIR" -c credential.helper="!$GH_BIN auth git-credential" push origin main
echo "Published Auction Assistant $VERSION"
