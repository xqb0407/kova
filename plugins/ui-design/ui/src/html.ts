/**
 * 设计档 → 自包含交互式 HTML 原型（纯字符串生成，单文件零依赖）。
 * 每个顶层画板 = 一个 .sc 屏（画面复用 nodesToSvg 的 SVG，位图 dataURL 内嵌），
 * onTap 热点 = 覆盖在 SVG 上的 <a href="#屏id">（浏览器原生前进/后退即原型回退）；
 * 内置脚本做 显示切换 / 适配缩放 / 屏序导航。浏览器直接打开即可点。
 */
import { allFrames, type DesignDoc } from "./doc";
import { nodesToSvg } from "./export";
import { collectHotspots, resolveTargetFrame } from "./prototype";
import type { MeasureFn } from "./leafer/scene";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type PrototypeHtmlOptions = {
  measure: MeasureFn;
  /** 只导某页；缺省 = 全部页面 */
  pageId?: string;
  title?: string;
};

/** 生成原型 HTML；无任何顶层画板返回 null */
export async function docToPrototypeHtml(doc: DesignDoc, opts: PrototypeHtmlOptions): Promise<string | null> {
  const frames = allFrames(doc).filter((f) => !opts.pageId || f.pageId === opts.pageId);
  if (frames.length === 0) return null;
  const screens: string[] = [];
  for (const { frame } of frames) {
    const r = await nodesToSvg(doc, [frame.id], opts.measure);
    if (!r) continue;
    // SVG 去硬尺寸、随容器铺满（容器宽高 = 画板尺寸）
    const svg = r.svg.replace(/ width="\d+(\.\d+)?" height="\d+(\.\d+)?"/, ' width="100%" height="100%"');
    const hot = collectHotspots(frame)
      .map((h) => {
        const target = resolveTargetFrame(doc, h.to);
        if (!target || (opts.pageId && allFrames(doc).find((f) => f.frame.id === target.id)?.pageId !== opts.pageId)) return "";
        const tName = target.name;
        return `<a class="hot" href="#s-${esc(target.id)}" title="${esc(h.name)} → ${esc(tName)}" style="left:${h.box.x}px;top:${h.box.y}px;width:${Math.max(h.box.w, 8)}px;height:${Math.max(h.box.h, 8)}px"></a>`;
      })
      .join("");
    screens.push(
      `<section class="sc" id="s-${esc(frame.id)}" data-name="${esc(frame.name)}" style="width:${frame.w}px;height:${frame.h}px">${svg}${hot}</section>`,
    );
  }
  if (screens.length === 0) return null;
  const title = esc(opts.title ?? doc.meta.name);
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 原型</title>
<style>
  html,body{margin:0;height:100%;background:#18181b;overflow:hidden;
    font-family:ui-sans-serif,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  #wrap{position:relative;height:100%;display:flex;align-items:center;justify-content:center}
  .sc{position:relative;flex:none;background:#fff;display:none;box-shadow:0 12px 48px rgba(0,0,0,.5)}
  .sc.on{display:block}
  .hot{position:absolute;display:block;cursor:pointer;text-decoration:none;
    box-shadow:inset 0 0 0 1px rgba(13,153,255,.7);background:rgba(13,153,255,.05);border-radius:2px}
  .hot:hover{background:rgba(13,153,255,.18)}
  #hud{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);display:flex;gap:8px;align-items:center;
    background:rgba(24,24,27,.92);border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:5px 8px;color:#e4e4e7;
    font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,.45)}
  #hud button{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;
    width:26px;height:26px;border-radius:999px;color:#e4e4e7}
  #hud button:hover{background:rgba(255,255,255,.12)}
  #hud button:disabled{opacity:.3;cursor:default}
  #name{min-width:64px;text-align:center;font-weight:500;max-width:40vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #idx{color:#71717a;font-size:11px}
</style>
</head>
<body>
<div id="wrap">${screens.join("")}</div>
<nav id="hud">
  <button id="back" title="返回上一屏（浏览器回退）">&#8592;</button>
  <button id="prev" title="上一块画板">&#9664;</button>
  <span id="name"></span><span id="idx"></span>
  <button id="next" title="下一块画板">&#9654;</button>
</nav>
<script>
(function(){
  var scs=[].slice.call(document.querySelectorAll('.sc')),cur=-1;
  function fit(){
    var s=scs[cur];if(!s)return;
    var sc=Math.min(1,(innerWidth-56)/s.offsetWidth,(innerHeight-104)/s.offsetHeight);
    s.style.transform='scale('+sc+')';
  }
  function show(i){
    if(i<0||i>=scs.length)return;
    if(cur>=0)scs[cur].classList.remove('on');
    cur=i;scs[i].classList.add('on');
    location.hash='s-'+scs[i].id.slice(2);
    document.getElementById('name').textContent=scs[i].getAttribute('data-name');
    document.getElementById('idx').textContent=(i+1)+'/'+scs.length;
    fit();
  }
  function byHash(){
    var id=decodeURIComponent(location.hash.slice(1));
    var i=scs.findIndex(function(s){return s.id===id});
    show(i>=0?i:0);
  }
  document.getElementById('prev').onclick=function(){show((cur-1+scs.length)%scs.length)};
  document.getElementById('next').onclick=function(){show((cur+1)%scs.length)};
  document.getElementById('back').onclick=function(){history.back()};
  addEventListener('resize',fit);
  addEventListener('hashchange',byHash);
  addEventListener('keydown',function(e){
    if(e.key==='ArrowLeft'&&scs.length>1)document.getElementById('prev').click();
    if(e.key==='ArrowRight'&&scs.length>1)document.getElementById('next').click();
  });
  if(location.hash.length<3){var h=scs[0]?scs[0].id:'';history.replaceState(null,'','#'+h);}
  byHash();
})();
</script>
</body>
</html>`;
}
