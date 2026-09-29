#!/usr/bin/env bash
# مزامنة التعديلات مع GitHub (booos99/book01)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.mahami-github.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ملف الصلاحيات غير موجود: .mahami-github.env" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN فارغ في ملف الصلاحيات" >&2
  exit 1
fi

git config user.name "${GIT_USER_NAME:-booos99}"
git config user.email "${GIT_USER_EMAIL:-booos99@users.noreply.github.com}"
git remote set-url origin "https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git"

MSG="${1:-تحديث تطبيق مهامي}"

git add -A
if git diff --cached --quiet; then
  echo "لا توجد تغييرات للرفع."
else
  git commit -m "$MSG"
fi

AUTH_REMOTE="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git"
git pull --rebase "$AUTH_REMOTE" "${GITHUB_BRANCH:-main}" || true
git push "$AUTH_REMOTE" "HEAD:${GITHUB_BRANCH:-main}"
git remote set-url origin "https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git"
echo "تم الرفع إلى https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}"
