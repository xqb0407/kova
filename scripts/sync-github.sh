#!/usr/bin/env bash
# 把本仓镜像推送到 GitHub 开源仓（github.com/40565511/kova）。
# 推送前在临时克隆里完成两件"发布侧清理"，本仓库与 Gitee 远端完全不受影响：
#   1. 从历史中剥离 .zcode/（AI 会话计划等内部工作笔记）
#   2. 重写作者/提交者邮箱 zkteco -> 个人邮箱
# 重写是确定性的：同一份输入历史永远得到同一批 SHA，因此只要本地新提交
# 不引入新的待重写内容，后续每次重跑都是 fast-forward，可直接当日常同步用。
#
# 用法:   ./scripts/sync-github.sh [branch]    # 默认 main
# 前提:   本机 git 凭据已存 github.com 的 PAT（osxkeychain）
# 平台:   macOS / Linux（bash）
set -euo pipefail

BRANCH="${1:-main}"
OWNER="40565511"
REPO="kova"
REMOTE_URL="https://github.com/${OWNER}/${REPO}.git"

SRC="$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo ">> 临时镜像克隆: $TMP/repo"
git clone --no-local --no-hardlinks --quiet "$SRC" "$TMP/repo"
cd "$TMP/repo"
git checkout -q -B "$BRANCH" "origin/$BRANCH"

echo ">> 剥离 .zcode/ 并重写邮箱 herther.xiang@zkteco.com -> 34675628@qq.com ..."
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --index-filter 'git rm -r --cached --ignore-unmatch -q .zcode' \
  --env-filter '
    if [ "$GIT_AUTHOR_EMAIL" = "herther.xiang@zkteco.com" ]; then
      export GIT_AUTHOR_EMAIL="34675628@qq.com"
    fi
    if [ "$GIT_COMMITTER_EMAIL" = "herther.xiang@zkteco.com" ]; then
      export GIT_COMMITTER_EMAIL="34675628@qq.com"
    fi
  ' \
  -- --all >/dev/null

LEFT=$(git log --all --format='%ae %ce' | grep -c zkteco || true)
echo ">> 校验: 历史中 zkteco 邮箱残留 = $LEFT（应为 0）"
if [ "$LEFT" != "0" ]; then
  echo "!! 重写不彻底，中止推送" >&2
  exit 1
fi

echo ">> 推送 $BRANCH -> $REMOTE_URL"
git push "$REMOTE_URL" "refs/heads/$BRANCH:refs/heads/$BRANCH"
echo ">> 完成: https://github.com/${OWNER}/${REPO}"
