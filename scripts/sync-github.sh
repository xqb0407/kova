#!/usr/bin/env bash
# 把本仓镜像推送到 GitHub 发布仓（github.com/xqb0407/kova）。
# 推送前在临时克隆里完成"发布侧清理"，本仓库与 Gitee 远端完全不受影响：
#   1. 从历史中剥离 .zcode/（AI 会话计划等内部工作笔记）
#   2. 从历史中剥离构建产物（插件面板 HTML、ui/dist、内置插件 zip）
#   3. 重写作者/提交者邮箱 zkteco -> 个人邮箱
# 重写是确定性的：同一份输入历史永远得到同一批 SHA，因此只要本地新提交
# 不引入新的待重写内容，后续每次重跑都是 fast-forward，可直接当日常同步用。
#
# 用法:   ./scripts/sync-github.sh [branch]    # 默认 main
# 前提:   本机 git 凭据已存 github.com 的 PAT（osxkeychain）
# 平台:   macOS / Linux（bash）
set -euo pipefail

BRANCH="${1:-main}"
OWNER="xqb0407"
REPO="kova"
REMOTE_URL="https://github.com/${OWNER}/${REPO}.git"

SRC="$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo ">> 临时镜像克隆: $TMP/repo"
git clone --no-local --no-hardlinks --quiet "$SRC" "$TMP/repo"
cd "$TMP/repo"
git checkout -q -B "$BRANCH" "origin/$BRANCH"

echo ">> 剥离 .zcode/ 与构建产物，重写邮箱 herther.xiang@zkteco.com -> 34675628@qq.com ..."
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --index-filter 'git rm -r --cached --ignore-unmatch -q .zcode \
    plugins/office/ui/dist plugins/canvas/ui/dist plugins/ui-design/ui/dist plugins/slide-canvas/ui/dist \
    plugins/office/office.html plugins/canvas/canvas.html plugins/ui-design/design.html plugins/slide-canvas/canvas.html \
    apps/sidecar/pi-agent/src/plugins/bundle/kova-plugins.zip' \
  --env-filter '
    if [ "$GIT_AUTHOR_EMAIL" = "herther.xiang@zkteco.com" ]; then
      export GIT_AUTHOR_EMAIL="34675628@qq.com"
    fi
    if [ "$GIT_COMMITTER_EMAIL" = "herther.xiang@zkteco.com" ]; then
      export GIT_COMMITTER_EMAIL="34675628@qq.com"
    fi
  ' \
  --tag-name-filter cat \
  -- --all >/dev/null

# filter-branch 会把原始 refs 备份在 refs/original/*，删除以免污染校验与镜像
git for-each-ref --format='%(refname)' refs/original | while read -r ref; do
  git update-ref -d "$ref"
done

LEFT_MAIL=$(git log --all --format='%ae %ce' | grep -c 'zkteco' || true)
LEFT_ZCODE=$(git log --all --format='' --name-only --diff-filter=A | grep -c '^\.zcode/' || true)
LEFT_ART=$(git log --all --format='' --name-only --diff-filter=A \
  | grep -c -E '^(plugins/[^/]+/(office|canvas|design)\.html|apps/sidecar/pi-agent/src/plugins/bundle/kova-plugins\.zip|plugins/[^/]+/ui/dist/)' || true)
echo ">> 校验: zkteco 邮箱残留 = ${LEFT_MAIL}, .zcode 残留 = ${LEFT_ZCODE}, 构建产物残留 = ${LEFT_ART} (均应为 0)"
if [ "${LEFT_MAIL}" -ne 0 ] || [ "${LEFT_ZCODE}" -ne 0 ] || [ "${LEFT_ART}" -ne 0 ]; then
  echo "!! 重写不彻底，中止推送" >&2
  exit 1
fi

echo ">> 推送 ${BRANCH} -> ${REMOTE_URL} (历史重写会换 SHA, 发布镜像统一覆盖推送)"
echo ">> 推送 ${BRANCH} -> ${REMOTE_URL} (历史重写会换 SHA, 发布镜像统一覆盖推送)"
PUSH_OK=0
for i in 1 2 3 4 5; do
  # HTTP/1.1：规避间歇性 HTTP2 framing / 空响应错误
  if git -c http.version=HTTP/1.1 push --force "$REMOTE_URL" "refs/heads/$BRANCH:refs/heads/$BRANCH"; then
    PUSH_OK=1
    break
  fi
  echo ">> 推送失败（第 ${i} 次），10s 后重试 ..."
  sleep 10
done
if [ "${PUSH_OK}" != "1" ]; then
  echo "!! 多次重试后推送仍失败" >&2
  exit 1
fi
echo ">> 完成: https://github.com/${OWNER}/${REPO}"
