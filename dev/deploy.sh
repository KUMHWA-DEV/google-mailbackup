#!/usr/bin/env bash
# push 후 웹앱 배포. 첫 배포의 deployment ID를 .deployment-id 에 저장해 이후엔 같은 URL로 재배포한다.
set -euo pipefail
cd "$(dirname "$0")/.."
npx clasp push -f
DESC="${1:-$(date +%Y-%m-%d) web app}"
if [ -f .deployment-id ]; then
  npx clasp deploy -i "$(cat .deployment-id)" -d "$DESC"
else
  OUT=$(npx clasp deploy -d "$DESC" | tee /dev/stderr)
  ID=$(echo "$OUT" | grep -oE 'AKfycb[A-Za-z0-9_-]+' | head -1 || true)
  if [ -n "$ID" ]; then echo "$ID" > .deployment-id; echo "deployment id 저장: .deployment-id"; fi
fi
echo "웹앱 열기: npx clasp open-web-app"
