/**
 * 检查点 patch 的按路径裁剪（纯函数，便于单测；git.ts 的逐文件回滚用）。
 *
 * 整轮 patch 在结算刻存档（见 git.ts patchFilePath）：逐文件回滚必须复用这份
 * 存档而不是现算 diff，否则「运行后又被手改」的文件会被静默退回——现算的
 * diff 永远能干净应用，存档 patch 的 apply --check 才会报冲突。
 */

/**
 * 从整轮 patch 中挑出指定路径的段（含 `diff --git` 头与全部 hunk）。
 * - 段头形如 `diff --git a/<a> b/<b>`：先按行尾精确匹配（路径含空格也能认），
 *   再按两侧空格定界匹配 rename 场景（a/old 在中间）；
 * - 命中不到任何段返回 null（调用方按「结算刻该文件无改动」处理，不做回滚）。
 * 返回的 Buffer 可直接喂 `git apply -R`。
 */
export function filterPatchSections(
  patch: Buffer | string,
  paths: readonly string[],
): Buffer | null {
  if (paths.length === 0) return null;
  const text = typeof patch === "string" ? patch : patch.toString("utf8");
  const keepSection = (header: string): boolean => {
    for (const p of paths) {
      if (header.endsWith(` b/${p}`) || header.endsWith(` a/${p}`)) return true;
      // rename 段：a/old 在中间，靠两侧空格定界（避免 b/x 后缀误命中）
      if (header.includes(` a/${p} `) || header.includes(` b/${p} `)) return true;
    }
    return false;
  };
  const out: string[] = [];
  let keep = false;
  let found = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      keep = keepSection(line);
      if (keep) {
        found = true;
        out.push(line);
      }
      continue;
    }
    if (keep) out.push(line);
  }
  return found ? Buffer.from(out.join("\n"), "utf8") : null;
}
