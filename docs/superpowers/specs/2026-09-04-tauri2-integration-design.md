# Tauri 2 集成设计文档

**日期：** 2026-09-04
**项目：** Xulux Base Assistant UI - Desktop Application

## 1. 项目目标

### 主要目标
- 保留现有Web应用，添加桌面应用版本
- 支持平台：macOS、Windows
- 提供桌面特有功能：系统托盘、本地文件访问、全局快捷键

### 成功标准
- ✅ Web应用功能完整保留（AI聊天、线程管理、附件等）
- ✅ 桌面应用可独立运行和分发
- ✅ 支持系统托盘后台运行
- ✅ 支持本地文件访问（读写文件、选择文件夹）
- ✅ 支持全局快捷键唤醒应用
- ✅ 构建产物可安装运行

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────┐
│         Next.js Application         │
│  (前端UI + API路由 + AI功能)        │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│          Tauri 2 Runtime            │
│  (原生容器 + 插件系统)              │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│       Desktop Application           │
│  (macOS / Windows)                  │
└─────────────────────────────────────┘
```

### 2.2 技术栈

**现有技术栈：**
- Next.js 16.3.4
- React 19.2.8
- TypeScript 7.0.2
- Tailwind CSS 4.3.3

**新增技术：**
- Tauri 2.x
- Rust（Tauri核心）
- Tauri插件：shell、fs、global-shortcut、tray

### 2.3 开发与构建模式

**开发环境：**
- Tauri dev server 连接 Next.js dev server (`http://localhost:3000`)
- 支持热重载和调试

**生产环境：**
- 方案：Tauri加载Next.js静态导出 + 内嵌静态服务器
- 或者：使用`@tauri-apps/plugin-shell`运行Next.js服务

## 3. 项目结构

### 3.1 新增目录结构

```
ai-teamplte/
├── src-tauri/                    # Tauri配置目录
│   ├── src/                      # Rust源代码
│   │   └── main.rs              # 主入口
│   ├── tauri.conf.json          # Tauri配置
│   ├── Cargo.toml               # Rust依赖
│   └── capabilities/            # 权限配置
│       └── default.json
├── app/                          # Next.js应用（现有）
├── components/                   # React组件（现有）
└── package.json                  # 项目配置（更新）
```

### 3.2 配置文件

**tauri.conf.json 核心配置：**
```json
{
  "productName": "Xulux Assistant",
  "version": "0.1.0",
  "identifier": "com.xulux.assistant",
  "build": {
    "frontendDist": "../out",
    "devUrl": "http://localhost:3000",
    "beforeBuildCommand": "npm run build",
    "beforeDevCommand": "npm run dev"
  },
  "app": {
    "windows": [
      {
        "title": "Xulux Assistant",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600
      }
    ],
    "trayIcon": {
      "iconPath": "icons/icon.png",
      "iconAsTemplate": true
    }
  },
  "plugins": {
    "fs": {},
    "shell": {
      "open": true
    },
    "global-shortcut": {},
    "tray": {}
  }
}
```

## 4. 桌面功能设计

### 4.1 系统托盘

**功能：**
- 窗口关闭时最小化到托盘
- 托盘菜单：显示/隐藏窗口、退出应用
- 托盘图标状态指示

**实现：**
```rust
// src-tauri/src/main.rs
use tauri::tray::TrayIconBuilder;
use tauri::menu::{Menu, MenuItem};

fn setup_tray(app: &App) {
    let show = MenuItem::new("显示窗口", true, None::<&str>);
    let quit = MenuItem::new("退出", true, None::<&str>);
    let menu = Menu::new(&app, &[&show, &quit]);

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap())
        .menu(&menu)
        .on_menu_event(|app, event| {
            match event.id {
                "显示窗口" => { /* 显示窗口 */ },
                "退出" => { /* 退出应用 */ },
                _ => {}
            }
        })
        .build(app);
}
```

### 4.2 本地文件访问

**功能：**
- 选择文件/文件夹
- 读写本地文件
- 拖拽文件到应用

**实现：**
- 使用 `@tauri-apps/plugin-fs`
- 使用 `@tauri-apps/plugin-dialog`
- 前端调用示例：
```typescript
import { open } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';

// 选择文件
const file = await open({
  multiple: false,
  filters: [{ name: 'Text', extensions: ['txt', 'md'] }]
});

// 读取文件
const contents = await readFile(file.path);

// 写入文件
await writeFile(file.path, contents);
```

### 4.3 全局快捷键

**功能：**
- 注册系统级快捷键
- 快捷键唤醒应用窗口

**实现：**
```rust
// src-tauri/src/main.rs
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

fn setup_shortcuts(app: &App) {
    let shortcut = Shortcut::new(Some(Key::Meta), Key::Space);

    app.global_shortcut().on_shortcut(shortcut, |app, shortcut| {
        // 显示/隐藏窗口
        if let Some(window) = app.get_webview_window("main") {
            if window.is_visible().unwrap() {
                window.hide();
            } else {
                window.show();
                window.set_focus();
            }
        }
    });
}
```

### 4.4 窗口管理

**功能：**
- 自定义窗口控制按钮（最小化、最大化、关闭）
- 窗口状态记忆（位置、大小）
- 多窗口支持（可选）

**实现：**
```typescript
// 前端窗口控制
import { getCurrentWindow } from '@tauri-apps/api/window';

const window = getCurrentWindow();

// 最小化到托盘
document.getElementById('close-btn').addEventListener('click', () => {
  window.hide();
});

// 最大化/还原
document.getElementById('maximize-btn').addEventListener('click', () => {
  window.toggleMaximize();
});
```

## 5. Next.js 调整

### 5.1 静态资源处理

**需要调整的部分：**
- 图片资源：移到 `public/` 目录
- API路由：保留（使用Tauri shell插件或静态导出）

**两种方案：**

**方案A：静态导出 + 外部API**
```javascript
// next.config.ts
export default {
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true
  }
}
```
- 优点：打包简单
- 缺点：需要将AI API移到外部服务

**方案B：内嵌服务器（推荐）**
- 使用 `@tauri-apps/plugin-shell` 运行Next.js内置服务器
- 优点：保留所有Next.js功能
- 缺点：包体积稍大

### 5.2 环境变量

**开发环境：**
```
NEXT_PUBLIC_TAURI=true
OPENAI_API_KEY=sk-xxx
```

**生产环境：**
- 通过Tauri注入环境变量
- 或使用 `@tauri-apps/plugin-store` 存储

## 6. 构建与分发

### 6.1 开发流程

```bash
# 安装Tauri CLI
npm install -D @tauri-apps/cli

# 初始化Tauri
npm run tauri init

# 开发模式
npm run tauri dev

# 构建生产版本
npm run tauri build
```

### 6.2 构建产物

**macOS：**
- `.app` - 应用程序包
- `.dmg` - 磁盘镜像

**Windows：**
- `.exe` - 安装程序
- `.msi` - Windows安装包

### 6.3 CI/CD（未来）

```yaml
# GitHub Actions示例
- name: Build Tauri App
  uses: tauri-apps/tauri-action@v0
  with:
    tagName: v__VERSION__
    releaseName: 'Xulux Assistant v__VERSION__'
    publish: true
```

## 7. 错误处理

### 7.1 Tauri插件错误

**策略：**
- 插件不可用时降级到Web功能
- 错误边界捕获并显示友好提示
- 日志记录供调试

**示例：**
```typescript
// 检测是否在Tauri环境
const isTauri = window.__TAURI__ !== undefined;

// 条件调用桌面功能
if (isTauri) {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const file = await open();
} else {
  // Web降级方案
  const input = document.createElement('input');
  input.type = 'file';
  input.click();
}
```

### 7.2 网络错误

- AI API调用失败时显示重试选项
- 离线模式提示
- 网络状态检测

## 8. 测试策略

### 8.1 单元测试
- 测试Tauri插件调用逻辑
- 测试Web/桌面双平台兼容代码

### 8.2 集成测试
- 测试文件系统操作
- 测试快捷键注册
- 测试系统托盘交互

### 8.3 手动测试清单

**桌面功能：**
- [ ] 应用启动和关闭
- [ ] 窗口最小化到托盘
- [ ] 托盘菜单操作
- [ ] 文件选择和读写
- [ ] 全局快捷键响应
- [ ] 窗口状态记忆

**跨平台测试：**
- [ ] macOS (Intel + Apple Silicon)
- [ ] Windows 10/11

**兼容性测试：**
- [ ] Web版本功能不受影响
- [ ] API调用正常
- [ ] AI聊天功能正常

## 9. 实施计划

### 阶段一：基础集成（1-2天）
1. 安装Tauri CLI和依赖
2. 初始化Tauri项目结构
3. 配置Next.js构建
4. 实现基础桌面应用运行

### 阶段二：桌面功能（2-3天）
1. 实现系统托盘
2. 实现本地文件访问
3. 实现全局快捷键
4. 实现自定义窗口控制

### 阶段三：优化与测试（1-2天）
1. 错误处理和降级方案
2. 性能优化
3. 跨平台测试
4. 构建安装包

## 10. 风险与缓解

### 风险1：Rust环境配置
- **影响：** 需要安装Rust工具链
- **缓解：** 提供详细的安装指南

### 风险2：API路由处理
- **影响：** 静态导出会丢失API功能
- **缓解：** 使用内嵌服务器或外部API服务

### 风险3：包体积
- **影响：** Tauri会增加包体积
- **缓解：** 优化资源、压缩打包

## 11. 未来扩展

- 自动更新功能
- 多窗口支持
- 更多桌面集成（通知、剪贴板等）
- 应用商店发布（Mac App Store、Microsoft Store）

---

**设计审核：** 待用户确认
**下一步：** 编写实施计划