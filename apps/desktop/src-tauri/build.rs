use std::path::{Path, PathBuf};

/// Playwright 的 `injectedScriptSource.js` 里，`source` 赋值语句的形态。
/// 该产物不是 public export（Playwright 刻意不暴露），只能按字面量提取，
/// 所以形态变了必须在这里炸掉，而不是让运行时静默拿到一段不对的 JS。
const SOURCE_ASSIGN: &str = "const source";

/// 完整性锚点：提取出的源码必须同时含有这几个符号，否则说明 Playwright
/// 改了内部结构，我们对 `InjectedScript` 的调用方式（见 playwright_script.rs）
/// 已经不成立。宁可构建失败，也不要在用户页面里注入一个半残的 runtime。
const REQUIRED_MARKERS: &[&str] = &["InjectedScript", "ariaSnapshotForRecorder", "parseSelector"];

fn main() {
  tauri_build::build();
  emit_playwright_injected_script();
}

/// 把 playwright-core 的注入脚本抽成 OUT_DIR 里的纯文本，供 include_str! 消费。
///
/// 走 build.rs 而不是运行时读 node_modules：打包后的应用没有 node_modules，
/// 运行时读会在用户机器上炸；而这里炸能早、且只炸开发者。
fn emit_playwright_injected_script() {
  let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  // apps/desktop/src-tauri → 仓库根
  let root = manifest
    .parent()
    .and_then(Path::parent)
    .and_then(Path::parent)
    .expect("src-tauri 必须在 apps/desktop 下");
  let entry = root.join("node_modules/playwright-core/lib/generated/injectedScriptSource.js");

  println!("cargo:rerun-if-changed={}", entry.display());

  let raw = std::fs::read_to_string(&entry).unwrap_or_else(|e| {
    panic!(
      "读不到 {}：{e}\n\
       ARIA 快照依赖 playwright-core 的注入脚本。请先在仓库根执行依赖安装\n\
       （bun install），或调整 build.rs 里的版本路径。",
      entry.display()
    )
  });

  let script = extract_source_literal(&raw).unwrap_or_else(|e| panic!("{e}\n{}", entry.display()));
  for marker in REQUIRED_MARKERS {
    assert!(
      script.contains(marker),
      "提取出的 Playwright 注入脚本缺少符号 {marker:?}——Playwright 内部结构已变，\
       playwright_script.rs 里的调用方式需要同步更新（文件：{}）",
      entry.display()
    );
  }

  let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("playwright-injected.js");
  std::fs::write(&out, &script).expect("写 OUT_DIR 失败");
}

/// 从生成文件里取出 `const source = '...'` 的字符串字面量并解码。
fn extract_source_literal(raw: &str) -> Result<String, String> {
  let assign_at = find_assignment(raw).ok_or("生成文件里找不到 `const source =` 赋值语句")?;
  let after = &raw[assign_at + SOURCE_ASSIGN.len()..];
  let eq_at = after.find('=').ok_or("`const source` 后面没有 =")?;
  let value = after[eq_at + 1..].trim_start();
  let quote = value.chars().next().ok_or("赋值右侧是空的")?;
  if quote != '\'' && quote != '"' {
    return Err(format!("`const source` 的值不是字符串字面量（以 {quote} 开头）"));
  }

  // 扫描到未转义的结束引号。末尾可能跟着 `;` 或换行，不取。
  let bytes = value.as_bytes();
  let quote_byte = quote as u8;
  let mut i = 1; // 跳过起始引号
  while i < bytes.len() {
    match bytes[i] {
      b'\\' => i += 2,
      c if c == quote_byte => return decode_js_string(&value[1..i]),
      _ => i += 1,
    }
  }
  Err("字符串字面量没有闭合".into())
}

fn find_assignment(raw: &str) -> Option<usize> {
  raw.match_indices(SOURCE_ASSIGN).find_map(|(at, _)| {
    // 排除 `someconst source` 这类更长标识符里出现的片段
    let before = raw[..at].chars().next_back();
    if before.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$') {
      return None;
    }
    let after = &raw[at + SOURCE_ASSIGN.len()..];
    if after.trim_start().starts_with('=') {
      Some(at)
    } else {
      None
    }
  })
}

/// 把 JS 字面量的转义还原成真实字符串。
///
/// 处理引号自身、反斜杠，以及 `\n \r \t \b \f \0` 与 `\uXXXX`。
/// 反斜杠后跟其它字母时按字面保留——Playwright 生成的是 JSON 风格内容，
/// 键集封闭，不需要实现完整的 JS 字符串语义。
fn decode_js_string(body: &str) -> Result<String, String> {
  let mut out = String::with_capacity(body.len());
  let mut chars = body.chars();
  while let Some(c) = chars.next() {
    if c != '\\' {
      out.push(c);
      continue;
    }
    let esc = chars.next().ok_or("末尾是孤立的反斜杠")?;
    match esc {
      'n' => out.push('\n'),
      'r' => out.push('\r'),
      't' => out.push('\t'),
      'b' => out.push('\u{8}'),
      'f' => out.push('\u{c}'),
      '0' => out.push('\0'),
      'u' => {
        let hex: String = chars.by_ref().take(4).collect();
        let cp =
          u32::from_str_radix(&hex, 16).map_err(|_| format!("非法 \\u 转义：{hex}"))?;
        out.push(char::from_u32(cp).ok_or_else(|| format!("非法码点 U+{cp:X}"))?);
      }
      other => out.push(other),
    }
  }
  Ok(out)
}
