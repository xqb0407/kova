# 性能基线（迭代 0 产物）

> 每个迭代完成后重跑同一组场景，把对比三行数字写进该迭代的 commit message。

## 工具

```bash
bun scripts/perf-sample.mjs <场景名> [--interval 2] [--duration 秒] [--webview-pid PID]
# 输出 perf-samples/<日期>-<场景名>.csv（ts,pid,role,rss_kb），Ctrl-C 收尾落盘
```

- webview 归因启发式：取"启动不早于主 App"的 WebKit WebContent 中 RSS 最大者；
  多开其他浏览器时若怀疑归因错，`--webview-pid` 手动钉死。
- DOM 节点数（P5 直接指标）：dev 构建里右键检查 → 控制台执行
  `document.getElementsByTagName('*').length`，手记进对应场景行。
- 主线程忙碌占比：DevTools → Performance → 录制流式输出 30s →
  火焰图底部 Σ空闲外时间 / 30s；同时记"最长任务"。

## 快照（2026-09-12，长时间运行的 dev 实例，空闲态）

| 角色 | pid | RSS |
|------|-----|-----|
| app（xulux-assistant debug） | 14216 | 183 MB |
| sidecar（pi-agent） | 14325 | 123 MB |
| webview（WebContent） | 14322 | **1327 MB** |

空闲即 1.3GB，主要对应 P2（会话驻留）+ P5（DOM/线程缓存）的长期累积；
本表是"优化前"起点，各迭代验收以下面三个场景为准绳。

## 进度

- 迭代1 已合入（1ad79d8）。S2 对比数字需**完全重启应用**加载新 bundle 后采集
  （当前在线 webview 1327MB 属旧包，热更新不回退已驻留内存）。
- 迭代1b 已合入（8ac59ee）：设置页 dynamic import、AgentPanel 首开挂载、
  splash 3s→0.8s。shiki/mermaid 核查结论见计划文档（延后为 1c 专项）。
- 迭代2 已合入（b25901a）：sidecar 会话驻留 LRU 上限 8 + context_info
  只读投影（浏览不再物化 Agent）→ S1 可采。
- 迭代3 已合入（bfa833e）：sidecar 日志分级（PI_LOG_LEVEL 默认 event）、
  Rust→webview 20ms 合帧（pi-chunk-batch）、stdout 每行单次 parse、
  远程出站队列有界 2048（写满踢线）→ S2 的事件数指标可采。
- 迭代3b 已合入：state.db WAL + synchronous=NORMAL + busy_timeout；
  日志落盘 BufWriter（256KB/1s）；检查点快照 for-each-ref 单次遍历 +
  同树复用 parent commit（空转轮零新对象）。附带修复既有测试互扰
  （cancel_all_tools 全局 drain 误杀并行 timeout 测试）。
- 迭代4 已合入（59e3ac2）：sessions.message_count 增量列（persist 时
  随 touch 累加）+ Rust 启动同步回填（无迁移窗口）；list_sessions
  零文件扫描；get_history 合并为 scanTranscript 单遍。注意不变式：
  直接手造 JSONL 的调用/测试需同步 sessionTouch，否则计数不升。
- 迭代5a（窗口化）已实现后回滚（revert 4fd7c96/4e6d1df）：与
  turnAnchor/平滑滚动/贴底跟随冲突（抖动、发送后空白、回底失效），
  根因与替代方向见计划文档「5a 尝试记录」。
- 实测快照（重启加载新包后，空闲 4min）：app 133MB / sidecar 120MB /
  webview ~700MB（基线 183/123/1327）。

## 场景与待填数字（跑一个填一个）

### S1 sidecar 会话驻留（P2）
步骤：完全重启应用 → 依次打开 5 个大会话各发一条消息 → 全部切走 →
`perf-sample s1` 采样 60s。
- 基线：______（预期：每开一个会话阶梯 +N0MB 且不回落）
- 迭代2后：______（验收：稳定在上限 8 会话 + 基线附近，切走可回落）

### S2 流式输出主线程（P1/P3）
步骤：长会话（≥100 工具调用）里发一个会触发流式长回复的 prompt →
流式开始即 DevTools Performance 录 30s。
- 基线：忙碌 ____% / 最长任务 ____ms / 事件数 ____/s
- 迭代1后：忙碌显著下降，collect 不再逐 token 全量；
- 迭代3后：pi-chunk 事件 ≤60/s。

### S3 冷启动（P4/P6）
步骤：完全重启 → 采样脚本记 sidecar/webview 首值 + 肉测会话列表可见耗时。
- 基线：列表可见 ____s；entry chunk ____KB(gzip)（`next build` 产物读）
- 迭代1b后：chunk 下降；迭代4后：list_sessions <100ms。
