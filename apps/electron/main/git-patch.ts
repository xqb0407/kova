/**
 * 检查点 patch 的按路径裁剪（纯函数，便于单测；git.ts 的逐文件回滚用）。
 *
 * 整轮 patch 在结算刻存档（见 git.ts patchFilePath）：逐文件回滚必须复用这份
 * 存档而不是现算 diff，否则「运行后又被手改」的文件会被静默退回——现算的
 * diff 永远能干净应用，存档 patch 的 apply --check 才会报冲突。
 *
 * 路径匹配同时覆盖两种头行形态：
 * - `diff --git a/path b/path`（ASCII 路径，含空格的靠行尾 ` b/<path>` 定界）；
 * - `diff --git "a/\344\270\255..." "b/..."`（git 默认 core.quotePath 对非
 *   ASCII/控制字符做八进制转义；老存档里很常见，必须能对上）。
 */

/** 单个路径段在 patch 头行里的两种写法 */
function headerForms(path: string): string[] {
  const raw = { a: `a/${path}`, b: `b/${path}` };
  return [
    ` ${raw.a}`,
    ` ${raw.b}`,
    // git 引号形式：整段（含 a/ b/ 前缀）按 C 风格转义后加双引号
    `"${gitQuoted(raw.a)}"`,
    `"${gitQuoted(raw.b)}"`,
  ];
}

/** git core.quotePath 的转义（UTF-8 字节 → \ooo；\\ \" \n \t 照搬） */
function gitQuoted(full: string): string {
  let out = "";
  for (const byte of Buffer.from(full, "utf8")) {
    if (byte === 0x5c) out += "\\\\";
    else if (byte === 0x22) out += '\\"';
    else if (byte === 0x0a) out += "\\n";
    else if (byte === 0x09) out += "\\t";
    else if (byte < 0x20 || byte >= 0x7f)
      out += "\\" + byte.toString(8).padStart(3, "0");
    else out += String.fromCharCode(byte);
  }
  return out;
}

function headerMatches(header: string, paths: readonly string[]): boolean {
  for (const p of paths) {
    if (!p) continue;
    for (const form of headerForms(p)) {
      // 未加引号的形态要求右侧是空白/行尾，防 b/ 后缀误命中；引号形态自带边界
      if (form.startsWith('"')) {
        if (header.includes(form)) return true;
      } else if (
        header.endsWith(form) ||
        header.includes(`${form} `) ||
        header.includes(`${form}\t`)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** 按 `diff --git` 头切段；首个头之前的杂行丢弃（git 不会产生） */
function splitSections(text: string): string[] {
  const sections: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) sections.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) sections.push(current.join("\n"));
  return sections;
}

/** 段首行（`diff --git ...` 头）——只匹配头行，避免 hunk 正文里的同名路径误命中 */
function sectionHeader(section: string): string {
  const nl = section.indexOf("\n");
  return nl < 0 ? section : section.slice(0, nl);
}

/**
 * 从整轮 patch 中挑出指定路径的段（含 `diff --git` 头与全部 hunk）。
 * 命中不到任何段返回 null（调用方按「结算刻该文件无改动」处理，不做回滚）。
 * 返回的 Buffer 可直接喂 `git apply -R`。
 */
export function filterPatchSections(
  patch: Buffer | string,
  paths: readonly string[],
): Buffer | null {
  if (paths.length === 0) return null;
  const text = typeof patch === "string" ? patch : patch.toString("utf8");
  const kept = splitSections(text).filter((s) =>
    headerMatches(sectionHeader(s), paths),
  );
  return kept.length > 0 ? Buffer.from(kept.join("\n"), "utf8") : null;
}

/**
 * 从整轮 patch 中剔除指定路径的段（逐文件回滚成功后的存档回写）。
 * 返回剩余段拼回的 patch；全部剔除时返回空 Buffer（调用方删存档）。
 */
export function excludePatchSections(
  patch: Buffer | string,
  paths: readonly string[],
): Buffer {
  const text = typeof patch === "string" ? patch : patch.toString("utf8");
  const kept = splitSections(text).filter(
    (s) => !headerMatches(sectionHeader(s), paths),
  );
  return Buffer.from(kept.join("\n"), "utf8");
}
