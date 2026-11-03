# Office 性能基准

两套可复现基准，用于优化前后对比与 Univer 升级后的劣化检查（同一台机器比较相对值）：

```bash
bun run bench          # 纯函数层：parse/serialize/buildScene/retheme/快照卫生化/MCP 读写
bun run bench:browser  # 真实浏览器：模拟宿主 iframe 推 200 页 deck（首屏/选中/滚动）
bun run bench:sheet    # 真实浏览器：5 万格表格 + 12 次命令连发（防抖前后对照）
```

- `bench/pure.ts`：合成档 → 计时（median of N），依赖为零、秒级跑完。
- `bench/run.ts`：自动起 vite（默认 5399）与静态宿主（5300），Chrome headless 量
  deck 首屏就绪、缩略图选中重渲染、列表滚动长任务。`PAGES` 可调页数。
- `bench/sheet-bench.ts`：5 万格工作簿 + 12 次「粗体」点击，对比
  `EMIT_DELAY=0`（每条命令立即整档序列化）与默认 250ms 合并窗口的上报次数/字节。
- `bench/host.html`：模拟宿主（postMessage 协议），可单独打开调试。

2026-11 基线（200 页 deck 1400 元素 / 200×250=5 万格，M 系 Mac，Chrome headless）：

| 指标 | 优化前 | 优化后 |
|---|---|---|
| deck 首屏就绪（doc.open → 缩略图可交互） | 520 ms | 289–374 ms |
| deck 选中第 150 页重渲染 | 85.8 ms | 33–48 ms* |
| deck 列表滚动 1.2s | 0 长任务 / 17 ms 最大帧间隔 | 同 |
| sheet（5 万格）12 次命令连发：宿主收到 doc.change | 12 次 / 34.2 MB | 1 次 / 2.8 MB |
| sheet 命令连发最大帧间隔 | 33 ms | 33 ms |

\* 测量包含两次 rAF 的 ~33ms 基线；实际 React+绘制开销约 15ms。

优化项：
1. **缩略图栏虚拟化**（`editor/SlidesRail.tsx`）：外层撑总高度，只挂可视区 ±320px 的条目，
   滚动容器带 `data-rail-*` 测试钩子；200 页文档选中/滚动不再全量重渲染。
2. **表格快照防抖**（`sheet/univer.ts`）：命令执行立即标 dirty，整档 save+stringify 走
   250ms 合并窗口（`EMIT_DELAY`/`?sheetEmitDelay=` 可调，0 为对照），销毁前 flush。
   5 万格档单次序列化约 2.8MB——连发 12 条命令时从 34.2MB 降到 2.8MB，CPU/iframe IPC 显著下降；
   帧间隔两者均已低于 40ms（该机无可见掉帧），收益主要体现在 CPU 与消息体量。

纯函数基线（200 页 deck / 5 万格 sheet）：serialize 2.4ms、parse 2.6ms、单页 buildScene 0.1ms、
全档 buildScene 10.7ms、换肤 1.1ms、sheet 卫生化 8.7ms、MCP patch_sheet 单格 25.0ms。
