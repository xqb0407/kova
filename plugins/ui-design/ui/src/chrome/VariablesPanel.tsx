/**
 * VariablesPanel：共享颜色变量管理器（左侧栏「变量」页签）。
 * 列表 = 色值（取色器直改）+ 名称（行内改）+ 引用次数；新建/删除走 store——
 * 一次 commit = 一步撤销。改 value 全稿实时联动（画布/导出/CSS 三端渲染期解析 var: 引用）。
 * 删除不隐式解绑：引用处变警示粉（MCP delete 带 detach:true 才烘焙色值）。
 */
import { useState, type FC } from "react";
import { Plus, Trash2 } from "lucide-react";
import { collectVarRefs, type VariableDef } from "../doc";
import type { DesignStore } from "../state";
import { ColorInput, IconBtn } from "./ui";

const NameField: FC<{ value: string; onCommit: (v: string) => void }> = ({ value, onCommit }) => {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className="w-full min-w-0 bg-transparent text-[12px] outline-none"
      style={{ color: "var(--foreground)" }}
      value={text ?? value}
      title="变量名（回车或失焦提交）"
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        const t = e.target.value.trim();
        if (t && t !== value) onCommit(t);
        setText(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        e.stopPropagation();
      }}
    />
  );
};

const VarRow: FC<{ v: VariableDef; usage: number; store: DesignStore }> = ({ v, usage, store }) => (
  <div className="group flex h-8 items-center gap-1.5 rounded-md px-1.5 hover:bg-[var(--secondary)]">
    <ColorInput compact value={v.value} onChange={(c) => store.upsertVariable({ id: v.id, name: v.name, value: c })} />
    <div className="min-w-0 flex-1">
      <NameField value={v.name} onCommit={(name) => store.upsertVariable({ id: v.id, name, value: v.value })} />
    </div>
    <span
      className="shrink-0 rounded px-1 text-[10px] tabular-nums"
      style={{ background: "var(--secondary)", color: usage ? "var(--muted-foreground)" : "var(--destructive)" }}
      title={usage ? `被 ${usage} 处颜色引用` : "未被引用"}
    >
      {usage ? `${usage}` : "未引用"}
    </span>
    <IconBtn tip="删除变量（引用处将显示警示粉）" size={24} onClick={() => store.deleteVariable(v.id)}>
      <Trash2 size={12} />
    </IconBtn>
  </div>
);

export const VariablesManager: FC<{ store: DesignStore }> = ({ store }) => {
  const { doc } = store;
  const vars = doc.variables ?? [];
  const usage = collectVarRefs(doc);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {vars.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px]" style={{ color: "var(--muted-foreground)" }}>
            还没有共享变量。
            <br />
            新建后把颜色字段写成 var:引用，改一处全稿联动；
            <br />
            选中节点的填充/描边行也能「存为变量并绑定」。
          </div>
        )}
        {vars.map((v) => (
          <VarRow key={v.id} v={v} usage={usage.get(v.id) ?? 0} store={store} />
        ))}
      </div>
      <button
        type="button"
        onClick={() => store.upsertVariable({ name: `颜色 ${vars.length + 1}`, value: "#0d99ff" })}
        className="mx-2 mb-2 flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors hover:bg-[var(--secondary)]"
        style={{ color: "var(--foreground)" }}
      >
        <Plus size={12} /> 新建变量
      </button>
    </div>
  );
};
