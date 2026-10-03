开始实施（静态优先）。

第一步：在 `/Users/herther/Desktop/pi-kova-mobile` 建工程骨架 —— package.json、app.json、tsconfig.json、metro.config.js、babel.config.js、.gitignore、README。

第二步：把主工程 `apps/desktop/lib/pi/` 里的传输无关运行时按依赖闭包拷进 `src/runtime` 与 `src/reducers`，并做三处改造：抽 `HostEffects` 端口替掉 `window.dispatchEvent` 与面板耦合、拆分 `PiChannel` 类型、`crypto.randomUUID` 换成 expo-crypto。

第三步：编写 UI —— 配对屏、`app/_layout.tsx`（AssistantRuntimeProvider + 断线横幅）、聊天主界面（thread / message-row / composer）、工具行与审批卡与提问卡与 todo 与思考块、附件适配器与会话列表。

全程不修改 `/Users/herther/Desktop/ai-teamplte` 任何文件，结束时用 `git status` 自证。