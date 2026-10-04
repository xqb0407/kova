//! Playwright 注入脚本的构建期提取与调用封装。
//!
//! 背景：面板 webview 里 agent 原来靠 `browser_scripts::SNAPSHOT_JS` 取页面结构，
//! 那是一份手写的文本提取——把可见且可交互的元素铺成线性文本，400 行封顶。
//! 它有两个结构性问题：`<canvas>` 里没有 DOM 也没有文本，于是页面"看起来什么都没有"
//! （Three.js 复刻土楼那次 agent 就是这么误判面板坏了的）；文本里没有元素句柄，
//! click 只能靠再猜一次选择器。
//!
//! Playwright 的 `ariaSnapshotForRecorder()` 给的是 ARIA 树 + 元素 ref 表，
//! 前者解决"看不见 canvas"（agent 能正确判断"这页没有交互元素"并转去截图），
//! 后者让 click/type 能精确定位到快照时的那个元素。
//!
//! 为什么不用 Playwright 本尊：它是 Node 库，页面在 WKWebView 里，只能注入。
//! 这里注入的是它内部的 `injectedScriptSource.js`——非 public export，
//! 所以提取在 build.rs 做（带完整性校验），不在运行时读 node_modules。

/// build.rs 从 playwright-core 抽出的注入脚本（约 290KB，随二进制走）。
/// 提取失败/结构变更会在构建期炸，不会带到运行时。
const PW_INJECTED: &str = include_str!(concat!(env!("OUT_DIR"), "/playwright-injected.js"));

/// 注入脚本在页面侧的挂载点。跨快照持久：ARIA 树每次现算，runtime 只装一次。
const PW_GLOBAL: &str = "__xrPlaywrightInjected";

/// 快照体积上限。与旧 SNAPSHOT_JS 同量级——ARIA 树比线性文本更密，
/// 不封顶的话一个长列表页能轻易撑爆模型的上下文。
const MAX_LINES: usize = 400;
const MAX_CHARS: usize = 20_000;

/// 安装 Playwright runtime（幂等）。返回 true 表示本次真的装了。
///
/// 拆成独立一步是有意的：注入 290KB 比取一次快照贵得多，
/// 页面没变时后续快照只跑 [`aria_snapshot_js`]，不重复注入。
///
/// 导出值有两种形态，都要认：1.56 的 esbuild `__export` 是急切拷贝，
/// 拷进去的是惰性 thunk `() => InjectedScript`（无 prototype，像函数但不能 new）；
/// 1.59 起改成 getter，拿到的是类本身。判 prototype 而不是判版本号——
/// 版本判错会退化成"类不是构造函数"，而这里判的是形状。
pub fn install_js() -> String {
    format!(
        r#"(() => {{
  try {{
    if (globalThis.{PW_GLOBAL}) return JSON.stringify({{ ok: true, installed: false }});
    const module = {{}};
    {PW_INJECTED}
    let ctor = module.exports.InjectedScript;
    if (typeof ctor === "function" && !ctor.prototype) ctor = ctor();
    if (typeof ctor !== "function" || !ctor.prototype) {{
      return JSON.stringify({{ ok: false, error: "InjectedScript export shape unrecognized" }});
    }}
    globalThis.{PW_GLOBAL} = new ctor(globalThis, {{
      lang: "js",
      preserveCrossOrigin: true,
      sdkLanguage: "javascript",
      stableRafCount: 1,
      testIdAttributeName: "data-testid",
      customEngines: [],
      isUnderTest: false,
    }});
    return JSON.stringify({{ ok: true, installed: true }});
  }} catch (err) {{
    return JSON.stringify({{ ok: false, error: String((err && err.stack) || err) }});
  }}
}})()"#
    )
}

/// 取 ARIA 快照。调用前必须先跑过 [`install_js`]。
///
/// 返回 `{ ok, snapshot, refs, truncated }`：snapshot 是给模型读的 ARIA 树文本
/// （每行自带 `[ref=eN]`），refs 是本轮可点元素数，truncated 为封顶标记。
///
/// ref 落地：ARIA 树给的是 `Map<Element, refId>`（不是普通对象），
/// 遍历后把 `data-xr-ref` 写回元素，click/type 的既有解析链路原样可用；
/// 另记一条 CSS 路径到 `window.__xrSelectors` 兜住"重渲染后属性被抹掉"。
pub fn aria_snapshot_js() -> String {
    format!(
        r##"(() => {{
  try {{
    const injected = globalThis.{PW_GLOBAL};
    if (!injected) return JSON.stringify({{ ok: false, error: "playwright runtime not installed" }});
    if (!document.body) return JSON.stringify({{ ok: true, url: location.href, title: document.title || "", snapshot: "", refs: 0, truncated: false }});

    const result = injected.ariaSnapshotForRecorder();
    let text = String(result.ariaSnapshot || "");

    // 封顶：先按行截（保住树的缩进结构），再按字符硬截（防单行超长）
    let lines = text.split("\n");
    let truncated = false;
    if (lines.length > {MAX_LINES}) {{
      lines.length = {MAX_LINES};
      text = lines.join("\n");
      truncated = true;
    }}
    if (text.length > {MAX_CHARS}) {{
      text = text.slice(0, {MAX_CHARS});
      truncated = true;
    }}

    // refs 是 Map<Element, refId>；Object.keys 会拿到空数组。逐个写回属性。
    // 每轮重建这张表：SPA 长驻页面上它会无界增长，而上一轮的 ref 本就已失效。
    const store = (window.__xrSelectors = {{}});
    let count = 0;
    const table = result.refs;
    if (table && typeof table.forEach === "function") {{
      table.forEach((refId, el) => {{
        if (!el || el.nodeType !== 1) return;
        count++;
        try {{
          el.setAttribute("data-xr-ref", refId);
          store[refId] = cssPath(el);
        }} catch (err) {{}}
      }});
    }} else {{
      return JSON.stringify({{ ok: false, error: "aria refs table has unexpected shape" }});
    }}

    return JSON.stringify({{ ok: true, url: location.href, title: document.title || "", snapshot: text, refs: count, truncated: truncated }});
  }} catch (err) {{
    return JSON.stringify({{ ok: false, error: String((err && err.stack) || err) }});
  }}

  // 稳定 CSS 路径：id 唯一就用 id，否则 tag:nth-of-type 链，最多 6 段。
  // 只是 data-xr-ref 失效时的回落，不追求"一定唯一"，撞了就报 stale ref。
  function cssPath(el) {{
    if (!el) return "";
    try {{
      if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {{
        return "#" + CSS.escape(el.id);
      }}
    }} catch (err) {{}}
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {{
      let seg = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {{
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (same.length > 1) seg += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }}
      parts.unshift(seg);
      if (node.tagName === "BODY") break;
    }}
    return parts.join(" > ");
  }}
}})()"##
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 提取出的脚本必须真的能装上——完整性校验在 build.rs，这里再钉一次产物本身。
    #[test]
    fn injected_script_carries_the_api_we_call() {
        assert!(PW_INJECTED.contains("InjectedScript"));
        assert!(PW_INJECTED.contains("ariaSnapshotForRecorder"));
        // 体积下限：一份被截断/取错文件的产物也能通过符号检查
        assert!(
            PW_INJECTED.len() > 100_000,
            "注入脚本只有 {} 字节，提取多半取错了位置",
            PW_INJECTED.len()
        );
    }

    #[test]
    fn install_js_is_idempotent_and_guards_on_reentry() {
        let js = install_js();
        assert!(js.contains(&format!("globalThis.{PW_GLOBAL}")));
        // 二次调用直接返回，不重复注入
        assert!(js.contains("if (globalThis.__xrPlaywrightInjected)"));
        // 异常必须被兜住：WebView2 会吞未捕获异常，eval_with_callback 会收不到结果
        assert!(js.contains("catch (err)"));
    }

    /// 钉住那个真实踩到的坑：1.56 的导出是未调用的 thunk，判 prototype 才能认出来。
    /// 没有这一行时 `new module.exports.InjectedScript(...)` 抛 "is not a constructor"，
    /// 而字符串级的断言全都能通过。
    #[test]
    fn install_js_unwraps_the_lazy_thunk_export() {
        let js = install_js();
        assert!(
            js.contains("if (typeof ctor === \"function\" && !ctor.prototype) ctor = ctor();"),
            "install_js 必须解包惰性 thunk 导出，否则真浏览器里 new 会失败"
        );
        // 直接 new module.exports.InjectedScript 的写法一旦回归，这里要响
        assert!(!js.contains("new module.exports.InjectedScript"));
        // 解包后仍不是类时给明确错误，而不是让下游收到难懂的 TypeError
        assert!(js.contains("InjectedScript export shape unrecognized"));
    }

    #[test]
    fn snapshot_js_reports_missing_runtime_instead_of_throwing() {
        let js = aria_snapshot_js();
        // runtime 没装时返回结构化错误，交给调用方降级，而不是抛异常
        assert!(js.contains("playwright runtime not installed"));
        assert!(js.contains("catch (err)"));
    }

    /// refs 是 Map 不是普通对象——这条错了会静默返回 refs: 0，
    /// 快照看起来正常但所有 ref 都点不动。
    #[test]
    fn snapshot_js_walks_refs_as_a_map() {
        let js = aria_snapshot_js();
        assert!(js.contains("table.forEach"));
        assert!(js.contains("el.setAttribute(\"data-xr-ref\", refId)"));
        // 形状不认识时报错，不返回一份没有 ref 的快照
        assert!(js.contains("aria refs table has unexpected shape"));
        // cssPath 兜底被登记进 click/type 已在读的那个表
        assert!(js.contains("window.__xrSelectors"));
    }

    #[test]
    fn snapshot_js_caps_output() {
        let js = aria_snapshot_js();
        assert!(js.contains(&MAX_LINES.to_string()));
        assert!(js.contains(&MAX_CHARS.to_string()));
        assert!(js.contains("truncated"));
    }
}
