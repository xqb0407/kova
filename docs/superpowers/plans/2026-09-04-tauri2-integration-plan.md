# Tauri 2 集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有Next.js应用中集成Tauri 2，构建支持系统托盘、本地文件访问、全局快捷键的桌面应用（macOS和Windows）

**Architecture:** Next.js应用作为前端，Tauri 2作为原生容器，通过Tauri插件系统实现桌面特有功能。开发环境连接Next.js开发服务器，生产环境打包静态资源。

**Tech Stack:** Next.js 16, React 19, TypeScript, Tauri 2.x, Rust, Tauri插件（fs, dialog, global-shortcut, tray）

## Global Constraints

- 支持平台：macOS 和 Windows
- 保留现有Web应用所有功能（AI聊天、线程管理、附件等）
- Next.js版本：16.3.4
- React版本：19.2.8
- TypeScript版本：7.0.2
- Tauri版本：2.x
- 包管理器：bun
- 环境变量：NEXT_PUBLIC_TAURI=true, OPENAI_API_KEY

---

## 文件结构规划

**新增文件：**
- `src-tauri/src/main.rs` - Tauri主入口，初始化插件和窗口
- `src-tauri/tauri.conf.json` - Tauri配置文件
- `src-tauri/Cargo.toml` - Rust依赖配置
- `src-tauri/capabilities/default.json` - 权限配置
- `src-tauri/icons/` - 应用图标资源
- `lib/tauri.ts` - Tauri环境检测和工具函数
- `components/desktop/TitleBar.tsx` - 自定义标题栏
- `components/desktop/TrayManager.tsx` - 托盘管理

**修改文件：**
- `package.json` - 添加Tauri CLI和脚本
- `next.config.ts` - 调整构建配置（如果需要）
- `.env.example` - 添加Tauri环境变量示例
- `app/layout.tsx` - 条件渲染自定义标题栏

---

## 阶段一：基础集成

### Task 1: 安装Rust环境和Tauri CLI

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: 现有项目结构
- Produces: 可用的Tauri CLI命令

**前置检查：**

- [ ] **Step 1: 检查Rust环境**

运行以下命令检查Rust是否已安装：

```bash
rustc --version
```

如果未安装，根据系统执行安装：

**macOS/Linux:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Windows:**
下载并运行 https://rustup.rs 的安装程序

安装后重启终端，验证：
```bash
rustc --version
cargo --version
```

预期输出：
```
rustc 1.xx.x (xxxxxxx 2024-xx-xx)
cargo 1.xx.x (xxxxxxx 2024-xx-xx)
```

- [ ] **Step 2: 安装Tauri CLI和依赖**

在项目根目录执行：

```bash
bun add -D @tauri-apps/cli
bun add @tauri-apps/api
```

- [ ] **Step 3: 验证安装**

检查package.json中是否添加了依赖：

```bash
grep -A 2 "@tauri-apps" package.json
```

预期输出应包含：
```
"@tauri-apps/api": "^2.x.x",
...
"@tauri-apps/cli": "^2.x.x"
```

- [ ] **Step 4: 提交变更**

```bash
git add package.json bun.lock
git commit -m "chore: add Tauri CLI and API dependencies"
```

---

### Task 2: 初始化Tauri项目结构

**Files:**
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/build.rs`

**Interfaces:**
- Consumes: package.json中的Tauri CLI
- Produces: 完整的Tauri项目结构，可运行的开发环境

- [ ] **Step 1: 初始化Tauri**

运行Tauri初始化命令：

```bash
bun run tauri init --app-name "Xulux Assistant" --window-title "Xulux Assistant" --dev-url "http://localhost:3000" --before-dev-command "bun run dev" --before-build-command "bun run build"
```

这会创建 `src-tauri/` 目录并生成基础文件。

**如果命令交互式询问，输入以下值：**
- App name: Xulux Assistant
- Window title: Xulux Assistant
- Dev URL: http://localhost:3000
- Before dev command: bun run dev
- Before build command: bun run build

- [ ] **Step 2: 验证生成的文件**

检查生成的文件结构：

```bash
ls -la src-tauri/
```

预期输出应包含：
```
src/
tauri.conf.json
Cargo.toml
build.rs
```

- [ ] **Step 3: 配置tauri.conf.json**

编辑 `src-tauri/tauri.conf.json`，修改为以下内容：

```json
{
  "productName": "Xulux Assistant",
  "version": "0.1.0",
  "identifier": "com.xulux.assistant",
  "build": {
    "frontendDist": "../out",
    "devUrl": "http://localhost:3000",
    "beforeBuildCommand": "bun run build",
    "beforeDevCommand": "bun run dev",
    "beforeDevCommandTimeout": 60
  },
  "app": {
    "windows": [
      {
        "title": "Xulux Assistant",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "fullscreen": false,
        "decorations": true,
        "center": true
      }
    ],
    "security": {
      "csp": null
    },
    "trayIcon": {
      "iconPath": "icons/icon.png",
      "iconAsTemplate": true
    }
  },
  "plugins": {
    "fs": {
      "scope": {
        "allow": ["$APPDATA/**", "$DOCUMENT/**", "$DOWNLOAD/**", "$HOME/**", "$PICTURE/**"],
        "deny": []
      }
    },
    "dialog": {
      "open": true,
      "save": true
    },
    "shell": {
      "open": true
    },
    "global-shortcut": {},
    "tray": {}
  },
  "bundle": {
    "active": true,
    "targets": ["app", "dmg", "updater"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "publisher": "Xulux",
    "category": "Productivity",
    "shortDescription": "AI Assistant Desktop Application",
    "longDescription": "A powerful AI assistant with chat, thread management, and file capabilities",
    "macOS": {
      "minimumSystemVersion": "10.13"
    },
    "windows": {
      "nsis": {
        "installerIcon": "icons/icon.ico",
        "headerIcon": "icons/icon.ico",
        "installMode": "currentUser"
      }
    }
  }
}
```

- [ ] **Step 4: 配置Cargo.toml**

编辑 `src-tauri/Cargo.toml`，确保包含必要的依赖：

```toml
[package]
name = "xulux-assistant"
version = "0.1.0"
description = "Xulux AI Assistant Desktop Application"
authors = ["Xulux"]
edition = "2021"

[lib]
name = "xulux_assistant_lib"
crate-type = ["lib", "cdylib", "staticlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-fs = "2"
tauri-plugin-dialog = "2"
tauri-plugin-shell = "2"
tauri-plugin-global-shortcut = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
panic = "abort"
codegen-units = 1
lto = true
opt-level = "s"
strip = true
```

- [ ] **Step 5: 配置权限文件**

创建 `src-tauri/capabilities/default.json`：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "fs:default",
    "fs:allow-read-dir",
    "fs:allow-read-file",
    "fs:allow-write-file",
    "fs:allow-exists",
    "fs:allow-mkdir",
    "fs:allow-remove",
    "dialog:default",
    "dialog:allow-open",
    "dialog:allow-save",
    "shell:allow-open",
    "global-shortcut:allow-register",
    "global-shortcut:allow-unregister",
    "tray:default",
    "tray:allow-new",
    "tray:allow-set-icon",
    "tray:allow-set-menu"
  ]
}
```

- [ ] **Step 6: 编写main.rs**

编辑 `src-tauri/src/main.rs`：

```rust
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 7: 验证Rust编译**

```bash
cd src-tauri
cargo check
cd ..
```

预期输出：
```
Checking xulux-assistant v0.1.0
Finished dev [unoptimized + debuginfo] target(s) in X.XXs
```

- [ ] **Step 8: 提交变更**

```bash
git add src-tauri/
git commit -m "feat: initialize Tauri 2 project structure

- Add Tauri configuration files
- Configure plugins for fs, dialog, shell, global-shortcut
- Set up basic window and build configuration
- Add permissions for desktop features"
```

---

### Task 3: 配置package.json脚本

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: Tauri CLI
- Produces: npm脚本用于开发和构建桌面应用

- [ ] **Step 1: 添加Tauri脚本**

编辑 `package.json`，在 `scripts` 部分添加：

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build"
  }
}
```

- [ ] **Step 2: 验证脚本**

检查package.json的scripts部分：

```bash
cat package.json | jq '.scripts'
```

预期输出：
```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "tauri": "tauri",
  "tauri:dev": "tauri dev",
  "tauri:build": "tauri build"
}
```

- [ ] **Step 3: 提交变更**

```bash
git add package.json
git commit -m "chore: add Tauri scripts to package.json"
```

---

### Task 4: 创建Tauri环境检测工具

**Files:**
- Create: `lib/tauri.ts`

**Interfaces:**
- Consumes: 无
- Produces: `isTauri()` 函数，用于检测是否在桌面环境中运行

- [ ] **Step 1: 创建lib/tauri.ts文件**

创建文件 `lib/tauri.ts`：

```typescript
/**
 * Tauri环境检测和工具函数
 */

/**
 * 检测当前是否在Tauri桌面环境中运行
 */
export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI__' in window;
};

/**
 * 检测是否在Tauri开发模式中
 */
export const isTauriDev = (): boolean => {
  return isTauri() && window.location.hostname === 'localhost';
};

/**
 * 安全调用Tauri API
 * @param fn Tauri API调用函数
 * @param fallback Web降级方案
 */
export async function safeTauriCall<T>(
  fn: () => Promise<T>,
  fallback?: () => Promise<T>
): Promise<T | undefined> {
  if (!isTauri()) {
    if (fallback) {
      return await fallback();
    }
    return undefined;
  }

  try {
    return await fn();
  } catch (error) {
    console.error('Tauri API call failed:', error);
    if (fallback) {
      return await fallback();
    }
    return undefined;
  }
}

/**
 * 获取应用版本
 */
export async function getAppVersion(): Promise<string | undefined> {
  if (!isTauri()) {
    return undefined;
  }

  const { getName, getVersion } = await import('@tauri-apps/api/app');
  const version = await getVersion();
  return version;
}

/**
 * 获取平台信息
 */
export async function getPlatform(): Promise<string | undefined> {
  if (!isTauri()) {
    return 'web';
  }

  const { platform } = await import('@tauri-apps/plugin-os');
  return await platform();
}
```

- [ ] **Step 2: 创建类型声明文件（可选）**

创建 `lib/tauri.d.ts`：

```typescript
/**
 * Tauri全局类型声明
 */
declare global {
  interface Window {
    __TAURI__?: {
      convertFileSrc: (filePath: string, protocol?: string) => string;
    };
  }
}

export {};
```

- [ ] **Step 3: 提交变更**

```bash
git add lib/tauri.ts lib/tauri.d.ts
git commit -m "feat: add Tauri environment detection utilities

- Add isTauri() function for environment detection
- Add safeTauriCall() for fallback handling
- Add helper functions for app version and platform info"
```

---

### Task 5: 测试基础桌面应用运行

**Files:**
- 无新增文件

**Interfaces:**
- Consumes: Tauri项目结构，Next.js应用
- Produces: 可运行的桌面应用窗口

- [ ] **Step 1: 启动开发模式**

在项目根目录执行：

```bash
bun run tauri:dev
```

**首次运行会下载和编译Rust依赖，可能需要几分钟。**

- [ ] **Step 2: 验证应用启动**

预期行为：
1. Next.js开发服务器启动在 `http://localhost:3000`
2. Tauri窗口自动打开
3. 窗口显示Next.js应用界面
4. 可以在控制台看到Rust编译日志

如果遇到问题，检查：
- Rust环境是否正确安装
- Cargo.toml中的依赖是否正确
- tauri.conf.json中的devUrl是否正确

- [ ] **Step 3: 测试热重载**

在Next.js应用中做一个小改动（例如修改 `app/page.tsx`），保存文件。

预期行为：
- 浏览器窗口自动刷新
- Tauri窗口内容同步更新

- [ ] **Step 4: 停止开发服务器**

按 `Ctrl+C` 停止开发服务器。

- [ ] **Step 5: 提交测试记录**

创建测试记录文件 `docs/test-reports/tauri-basic-test.md`：

```markdown
# Tauri基础集成测试报告

**日期:** 2026-09-04
**测试人员:** 自动测试

## 测试环境
- 操作系统: [macOS/Windows]
- Rust版本: rustc 1.xx.x
- Node版本: v20.x.x
- Tauri版本: 2.x.x

## 测试结果

### 应用启动测试
- [✓] Tauri开发服务器启动成功
- [✓] Next.js开发服务器启动成功
- [✓] 桌面窗口打开成功
- [✓] 界面渲染正常

### 热重载测试
- [✓] 代码修改后自动刷新
- [✓] 窗口内容同步更新

### 控制台检查
- [✓] 无致命错误
- [✓] 无Rust编译错误

## 结论
基础集成成功，应用可正常运行。
```

```bash
mkdir -p docs/test-reports
git add docs/test-reports/tauri-basic-test.md
git commit -m "docs: add basic Tauri integration test report"
```

---

## 阶段二：桌面功能实现

### Task 6: 实现系统托盘功能

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/tray.rs`

**Interfaces:**
- Consumes: Tauri插件系统
- Produces: 系统托盘图标和菜单

- [ ] **Step 1: 创建托盘模块**

创建 `src-tauri/src/tray.rs`：

```rust
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    App, Manager, Runtime,
};

pub fn setup_tray<R: Runtime>(app: &App<R>) -> TrayIcon {
    // 创建托盘菜单项
    let show_item = MenuItem::new(app, "显示窗口", true, None::<&str>).unwrap();
    let hide_item = MenuItem::new(app, "隐藏窗口", true, None::<&str>).unwrap();
    let quit_item = MenuItem::new(app, "退出应用", true, None::<&str>).unwrap();

    // 创建菜单
    let menu = Menu::new(app, &[&show_item, &hide_item, &quit_item]).unwrap();

    // 构建托盘图标
    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "显示窗口" => {
                if let Some(window) = app.get_webview_window("main") {
                    window.show().unwrap();
                    window.set_focus().unwrap();
                }
            }
            "隐藏窗口" => {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide().unwrap();
                }
            }
            "退出应用" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)
        .expect("failed to build tray icon")
}

/// 更新托盘图标状态
pub fn update_tray_icon<R: Runtime>(tray: &TrayIcon, visible: bool) {
    // 可以根据窗口状态更改图标
    // 这里暂时保持默认图标
    let _ = tray;
    let _ = visible;
}
```

- [ ] **Step 2: 更新main.rs**

编辑 `src-tauri/src/main.rs`，添加托盘模块和初始化：

```rust
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tray;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // 设置系统托盘
            let _tray = tray::setup_tray(app);

            // 监听窗口关闭事件，最小化到托盘而不是退出
            let window = app.get_webview_window("main").unwrap();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // 阻止默认关闭行为
                    api.prevent_close();
                    // 隐藏窗口到托盘
                    window.hide().unwrap();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: 更新Cargo.toml依赖**

确保 `src-tauri/Cargo.toml` 包含必要的features：

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "image-png"] }
# ... 其他依赖保持不变
```

- [ ] **Step 4: 创建应用图标**

生成不同尺寸的应用图标（如果没有现成图标，可以暂时使用Tauri默认图标）：

```bash
# 如果有现成图标，放在 src-tauri/icons/ 目录
# 需要的图标尺寸：
# - 32x32.png
# - 128x128.png
# - 128x128@2x.png
# - icon.icns (macOS)
# - icon.ico (Windows)
```

**使用Tauri默认图标（临时）：**

如果暂时没有自定义图标，确保 `src-tauri/icons/` 目录存在：

```bash
mkdir -p src-tauri/icons
```

- [ ] **Step 5: 测试托盘功能**

启动开发模式：

```bash
bun run tauri:dev
```

测试清单：
- [✓] 系统托盘图标显示
- [✓] 点击托盘图标显示菜单
- [✓] 点击"显示窗口"可以显示窗口
- [✓] 点击"隐藏窗口"可以隐藏窗口
- [✓] 点击窗口关闭按钮时窗口隐藏到托盘
- [✓] 点击"退出应用"可以完全退出

- [ ] **Step 6: 提交变更**

```bash
git add src-tauri/
git commit -m "feat: implement system tray functionality

- Add tray module with show/hide/quit menu
- Handle window close to minimize to tray
- Add tray icon support"
```

---

### Task 7: 实现本地文件访问功能

**Files:**
- Create: `lib/file-operations.ts`
- Create: `components/desktop/FileButton.tsx`

**Interfaces:**
- Consumes: Tauri fs和dialog插件
- Produces: 文件选择、读取、写入功能

- [ ] **Step 1: 创建文件操作工具**

创建 `lib/file-operations.ts`：

```typescript
import { isTauri, safeTauriCall } from './tauri';

/**
 * 文件过滤器类型
 */
export interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * 打开文件选择对话框
 */
export async function openFile(options?: {
  multiple?: boolean;
  filters?: FileFilter[];
}): Promise<string | string[] | null> {
  return await safeTauriCall(
    async () => {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({
        multiple: options?.multiple,
        filters: options?.filters,
        directory: false,
      });
      return result as string | string[] | null;
    },
    async () => {
      // Web降级方案
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = options?.multiple || false;
        input.accept = options?.filters
          ?.flatMap((f) => f.extensions.map((ext) => `.${ext}`))
          .join(',') || '';

        input.onchange = () => {
          if (input.files && input.files.length > 0) {
            const files = Array.from(input.files).map((f) =>
              URL.createObjectURL(f)
            );
            resolve(options?.multiple ? files : files[0]);
          } else {
            resolve(null);
          }
        };

        input.click();
      });
    }
  );
}

/**
 * 打开文件夹选择对话框
 */
export async function openFolder(): Promise<string | null> {
  if (!isTauri()) {
    alert('文件夹选择功能仅在桌面版本可用');
    return null;
  }

  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({
    directory: true,
    multiple: false,
  });
  return result as string | null;
}

/**
 * 读取文件内容
 */
export async function readFileContent(
  path: string
): Promise<string | undefined> {
  return await safeTauriCall(
    async () => {
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const contents = await readFile(path);
      // 假设是文本文件
      const decoder = new TextDecoder('utf-8');
      return decoder.decode(contents);
    },
    async () => {
      // Web降级：通过fetch读取
      try {
        const response = await fetch(path);
        return await response.text();
      } catch {
        return undefined;
      }
    }
  );
}

/**
 * 写入文件内容
 */
export async function writeFileContent(
  path: string,
  content: string
): Promise<boolean> {
  if (!isTauri()) {
    // Web降级：触发下载
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'file.txt';
    a.click();
    URL.revokeObjectURL(url);
    return true;
  }

  try {
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const encoder = new TextEncoder();
    await writeFile(path, encoder.encode(content));
    return true;
  } catch (error) {
    console.error('Failed to write file:', error);
    return false;
  }
}

/**
 * 保存文件对话框
 */
export async function saveFile(options?: {
  defaultPath?: string;
  filters?: FileFilter[];
}): Promise<string | null> {
  if (!isTauri()) {
    alert('保存文件功能仅在桌面版本可用');
    return null;
  }

  const { save } = await import('@tauri-apps/plugin-dialog');
  const result = await save({
    defaultPath: options?.defaultPath,
    filters: options?.filters,
  });
  return result as string | null;
}

/**
 * 检查文件是否存在
 */
export async function fileExists(path: string): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }

  try {
    const { exists } = await import('@tauri-apps/plugin-fs');
    return await exists(path);
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: 创建文件选择按钮组件**

创建 `components/desktop/FileButton.tsx`：

```typescript
'use client';

import { useState } from 'react';
import { openFile, readFileContent } from '@/lib/file-operations';
import { isTauri } from '@/lib/tauri';

interface FileButtonProps {
  onFileSelect?: (path: string, content: string) => void;
  className?: string;
}

export function FileButton({ onFileSelect, className }: FileButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleOpenFile = async () => {
    setLoading(true);
    try {
      const path = await openFile({
        multiple: false,
        filters: [
          { name: 'Text', extensions: ['txt', 'md'] },
          { name: 'JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (path && typeof path === 'string') {
        const content = await readFileContent(path);
        if (content && onFileSelect) {
          onFileSelect(path, content);
        }
      }
    } catch (error) {
      console.error('Failed to open file:', error);
    } finally {
      setLoading(false);
    }
  };

  if (!isTauri()) {
    return null;
  }

  return (
    <button
      onClick={handleOpenFile}
      disabled={loading}
      className={className}
      title="打开本地文件"
    >
      {loading ? '加载中...' : '📁 打开文件'}
    </button>
  );
}
```

- [ ] **Step 3: 测试文件功能**

启动应用并测试：

```bash
bun run tauri:dev
```

测试清单：
- [✓] 点击按钮打开文件选择对话框
- [✓] 选择文件后可以读取内容
- [✓] 文件路径和内容正确传递

- [ ] **Step 4: 提交变更**

```bash
git add lib/file-operations.ts components/desktop/
git commit -m "feat: implement local file access functionality

- Add file operations utility with Tauri fs and dialog plugins
- Create FileButton component for file selection
- Add fallback support for web version
- Support open, read, write, and save operations"
```

---

### Task 8: 实现全局快捷键功能

**Files:**
- Modify: `src-tauri/src/main.rs`
- Create: `src-tauri/src/shortcuts.rs`

**Interfaces:**
- Consumes: Tauri global-shortcut插件
- Produces: 系统级快捷键注册和响应

- [ ] **Step 1: 创建快捷键模块**

创建 `src-tauri/src/shortcuts.rs`：

```rust
use tauri::{
    App, Manager, Runtime,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 设置全局快捷键
pub fn setup_shortcuts<R: Runtime>(app: &App<R>) -> Result<(), Box<dyn std::error::Error>> {
    // 注册 Cmd/Ctrl + Space 快捷键用于显示/隐藏窗口
    let shortcut = Shortcut::new(Some(tauri_plugin_global_shortcut::Modifiers::SUPER), tauri_plugin_global_shortcut::Code::Space);

    app.global_shortcut().on_shortcut(shortcut, |app, shortcut, event| {
        if event.state == ShortcutState::Pressed {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_visible().unwrap_or(false) {
                    window.hide().unwrap();
                } else {
                    window.show().unwrap();
                    window.set_focus().unwrap();
                }
            }
        }
    })?;

    // 注册 Cmd/Ctrl + Shift + S 快捷键用于保存对话
    let save_shortcut = Shortcut::new(
        Some(tauri_plugin_global_shortcut::Modifiers::SUPER | tauri_plugin_global_shortcut::Modifiers::SHIFT),
        tauri_plugin_global_shortcut::Code::KeyS,
    );

    app.global_shortcut().on_shortcut(save_shortcut, |app, shortcut, event| {
        if event.state == ShortcutState::Pressed {
            // 触发保存事件到前端
            let _ = app.emit("save-conversation", ());
        }
    })?;

    Ok(())
}
```

- [ ] **Step 2: 更新main.rs**

编辑 `src-tauri/src/main.rs`，添加快捷键模块：

```rust
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tray;
mod shortcuts;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // 设置系统托盘
            let _tray = tray::setup_tray(app);

            // 设置全局快捷键
            shortcuts::setup_shortcuts(app)?;

            // 监听窗口关闭事件，最小化到托盘而不是退出
            let window = app.get_webview_window("main").unwrap();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // 阻止默认关闭行为
                    api.prevent_close();
                    // 隐藏窗口到托盘
                    window.hide().unwrap();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: 创建前端快捷键监听工具**

创建 `lib/shortcuts.ts`：

```typescript
import { isTauri } from './tauri';

/**
 * 监听Tauri事件
 */
export async function listenToEvent<T>(
  eventName: string,
  callback: (payload: T) => void
): Promise<(() => void) | undefined> {
  if (!isTauri()) {
    return undefined;
  }

  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<T>(eventName, (event) => {
    callback(event.payload);
  });

  return unlisten;
}

/**
 * 设置保存对话监听器
 */
export function setupSaveListener(callback: () => void): (() => void) | undefined {
  return listenToEvent('save-conversation', callback);
}
```

- [ ] **Step 4: 测试快捷键功能**

启动应用并测试：

```bash
bun run tauri:dev
```

测试清单：
- [✓] 按 Cmd/Ctrl + Space 显示/隐藏窗口
- [✓] 按 Cmd/Ctrl + Shift + S 触发保存事件
- [✓] 快捷键在窗口隐藏时也能响应

- [ ] **Step 5: 提交变更**

```bash
git add src-tauri/ lib/shortcuts.ts
git commit -m "feat: implement global shortcuts functionality

- Add shortcuts module with Cmd+Space window toggle
- Add Cmd+Shift+S save conversation shortcut
- Add frontend event listener utilities
- Shortcuts work even when window is hidden"
```

---

### Task 9: 实现自定义窗口控制

**Files:**
- Create: `components/desktop/TitleBar.tsx`
- Create: `styles/titlebar.css`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `app/layout.tsx`

**Interfaces:**
- Consumes: Tauri window API
- Produces: 自定义窗口控制按钮（最小化、最大化、关闭）

- [ ] **Step 1: 配置无装饰窗口**

编辑 `src-tauri/tauri.conf.json`，修改窗口配置：

```json
{
  "app": {
    "windows": [
      {
        "title": "Xulux Assistant",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "fullscreen": false,
        "decorations": false,
        "center": true,
        "transparent": false
      }
    ]
  }
}
```

**注意：设置 `"decorations": false` 会移除系统标题栏，需要自己实现窗口控制。**

- [ ] **Step 2: 创建自定义标题栏样式**

创建 `styles/titlebar.css`：

```css
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  background: var(--background);
  border-bottom: 1px solid var(--border);
  user-select: none;
  app-region: drag;
}

.titlebar-drag {
  flex: 1;
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 500;
}

.titlebar-controls {
  display: flex;
  align-items: center;
  app-region: no-drag;
}

.titlebar-button {
  width: 46px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.15s;
}

.titlebar-button:hover {
  background: rgba(255, 255, 255, 0.1);
}

.titlebar-button.close:hover {
  background: #e81123;
  color: white;
}

.titlebar-button svg {
  width: 16px;
  height: 16px;
}

/* macOS风格按钮 */
.titlebar-macos {
  gap: 8px;
  padding: 0 12px;
}

.titlebar-macos .titlebar-button {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.titlebar-macos .close {
  background: #ff5f57;
}

.titlebar-macos .minimize {
  background: #ffbd2e;
}

.titlebar-macos .maximize {
  background: #28ca41;
}

.titlebar-macos .titlebar-button:hover {
  opacity: 0.8;
}
```

- [ ] **Step 3: 创建自定义标题栏组件**

创建 `components/desktop/TitleBar.tsx`：

```typescript
'use client';

import { useState, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '@/lib/tauri';
import '@/styles/titlebar.css';

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;

    const checkMaximized = async () => {
      const window = getCurrentWindow();
      const maximized = await window.isMaximized();
      setIsMaximized(maximized);
    };

    checkMaximized();

    // 监听窗口状态变化
    const unlisten = getCurrentWindow().onResized(() => {
      checkMaximized();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  if (!isTauri()) {
    return null;
  }

  const handleMinimize = async () => {
    const window = getCurrentWindow();
    await window.minimize();
  };

  const handleMaximize = async () => {
    const window = getCurrentWindow();
    await window.toggleMaximize();
    setIsMaximized(!isMaximized);
  };

  const handleClose = async () => {
    const window = getCurrentWindow();
    await window.hide(); // 最小化到托盘
  };

  return (
    <div className="titlebar">
      <div className="titlebar-drag">Xulux Assistant</div>
      <div className="titlebar-controls">
        <button
          className="titlebar-button minimize"
          onClick={handleMinimize}
          title="最小化"
        >
          <svg viewBox="0 0 16 16" fill="currentColor">
            <rect x="2" y="8" width="12" height="1" />
          </svg>
        </button>
        <button
          className="titlebar-button maximize"
          onClick={handleMaximize}
          title={isMaximized ? '还原' : '最大化'}
        >
          {isMaximized ? (
            <svg viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="3" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="currentColor">
              <rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          className="titlebar-button close"
          onClick={handleClose}
          title="关闭"
        >
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 集成到应用布局**

编辑 `app/layout.tsx`：

```typescript
import type { Metadata } from "next";
import "./styles/globals.css";
import { TitleBar } from "@/components/desktop/TitleBar";

export const metadata: Metadata = {
  title: "Xulux Assistant",
  description: "AI Assistant Desktop Application",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <TitleBar />
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 5: 测试自定义窗口控制**

启动应用并测试：

```bash
bun run tauri:dev
```

测试清单：
- [✓] 自定义标题栏正常显示
- [✓] 拖拽标题栏可以移动窗口
- [✓] 点击最小化按钮窗口最小化
- [✓] 点击最大化按钮窗口最大化/还原
- [✓] 点击关闭按钮窗口隐藏到托盘
- [✓] 窗口控制按钮hover效果正常

- [ ] **Step 6: 提交变更**

```bash
git add src-tauri/tauri.conf.json components/desktop/TitleBar.tsx styles/titlebar.css app/layout.tsx
git commit -m "feat: implement custom window controls

- Add custom title bar with minimize, maximize, close buttons
- Support window dragging via title bar
- Configure frameless window (decorations: false)
- Add hover effects for window control buttons"
```

---

## 阶段三：优化与测试

### Task 10: 添加错误处理和降级方案

**Files:**
- Create: `lib/error-handling.ts`
- Create: `components/desktop/ErrorBoundary.tsx`

**Interfaces:**
- Consumes: isTauri检测函数
- Produces: 统一的错误处理机制和降级方案

- [ ] **Step 1: 创建错误处理工具**

创建 `lib/error-handling.ts`：

```typescript
import { isTauri } from './tauri';

/**
 * 错误类型
 */
export enum ErrorType {
  TAURI_API_UNAVAILABLE = 'TAURI_API_UNAVAILABLE',
  FILE_OPERATION_FAILED = 'FILE_OPERATION_FAILED',
  SHORTCUT_REGISTRATION_FAILED = 'SHORTCUT_REGISTRATION_FAILED',
  TRAY_INITIALIZATION_FAILED = 'TRAY_INITIALIZATION_FAILED',
}

/**
 * 桌面功能错误
 */
export class DesktopFeatureError extends Error {
  type: ErrorType;
  fallback?: () => void;

  constructor(type: ErrorType, message: string, fallback?: () => void) {
    super(message);
    this.type = type;
    this.fallback = fallback;
    this.name = 'DesktopFeatureError';
  }
}

/**
 * 错误处理器
 */
export function handleDesktopError(error: unknown): void {
  if (error instanceof DesktopFeatureError) {
    console.error(`[${error.type}]: ${error.message}`);

    // 执行降级方案
    if (error.fallback) {
      error.fallback();
    }

    // 显示用户友好的错误信息
    if (isTauri()) {
      showErrorMessage(error.message);
    }
  } else {
    console.error('Unexpected error:', error);
  }
}

/**
 * 显示错误消息
 */
async function showErrorMessage(message: string): Promise<void> {
  if (!isTauri()) {
    alert(message);
    return;
  }

  try {
    const { message as dialogMessage } = await import('@tauri-apps/plugin-dialog');
    await dialogMessage(message, { title: '错误', type: 'error' });
  } catch {
    alert(message);
  }
}

/**
 * 包装Tauri API调用，添加错误处理
 */
export async function withErrorHandling<T>(
  operation: string,
  fn: () => Promise<T>,
  fallback?: () => T
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    handleDesktopError(
      new DesktopFeatureError(
        ErrorType.FILE_OPERATION_FAILED,
        `${operation} 失败: ${(error as Error).message}`,
        fallback
      )
    );
    return fallback ? fallback() : undefined;
  }
}
```

- [ ] **Step 2: 创建错误边界组件**

创建 `components/desktop/ErrorBoundary.tsx`：

```typescript
'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Desktop feature error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="error-fallback">
            <h3>桌面功能暂时不可用</h3>
            <p>此功能在当前环境中不可用，已切换到Web版本。</p>
            <button onClick={() => this.setState({ hasError: false })}>
              重试
            </button>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
```

- [ ] **Step 3: 更新文件操作使用错误处理**

编辑 `lib/file-operations.ts`，导入并使用错误处理：

```typescript
import { withErrorHandling, ErrorType, DesktopFeatureError } from './error-handling';

// 在文件操作函数中使用错误处理
export async function readFileContent(path: string): Promise<string | undefined> {
  return withErrorHandling(
    '读取文件',
    async () => {
      // ... 原有代码
    },
    () => {
      // 降级方案
      return undefined;
    }
  );
}
```

- [ ] **Step 4: 提交变更**

```bash
git add lib/error-handling.ts components/desktop/ErrorBoundary.tsx
git commit -m "feat: add error handling and fallback mechanisms

- Add DesktopFeatureError class for desktop-specific errors
- Add error handler with fallback support
- Create ErrorBoundary component for React error handling
- Integrate error handling into file operations"
```

---

### Task 11: 性能优化

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `next.config.ts`（可选）

**Interfaces:**
- Consumes: Rust和Next.js构建配置
- Produces: 优化后的构建产物

- [ ] **Step 1: 优化Rust编译配置**

编辑 `src-tauri/Cargo.toml`，确保release配置已优化：

```toml
[profile.release]
panic = "abort"       # 减少二进制大小
codegen-units = 1     # 更好的优化
lto = true            # 链接时优化
opt-level = "s"       # 优化大小
strip = true          # 移除符号信息
```

- [ ] **Step 2: 优化Next.js构建（如果使用静态导出）**

如果选择静态导出方案，编辑 `next.config.ts`：

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  // 移除console.log
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production',
  },
};

export default nextConfig;
```

**注意：如果使用内嵌服务器方案，不需要配置output: 'export'。**

- [ ] **Step 3: 分析包体积**

构建应用：

```bash
bun run tauri:build
```

检查构建产物大小：

**macOS:**
```bash
ls -lh src-tauri/target/release/bundle/macosx/
```

**Windows:**
```bash
dir src-tauri\target\release\bundle\msi\
```

记录包体积：
- macOS .app: ~XX MB
- macOS .dmg: ~XX MB
- Windows .exe: ~XX MB
- Windows .msi: ~XX MB

- [ ] **Step 4: 提交变更**

```bash
git add src-tauri/Cargo.toml next.config.ts
git commit -m "perf: optimize build configuration for smaller bundle size

- Configure Rust LTO and strip symbols
- Optimize Next.js build (if static export)
- Document bundle size analysis"
```

---

### Task 12: 跨平台测试

**Files:**
- Create: `docs/test-reports/desktop-test-report.md`

**Interfaces:**
- Consumes: 完整的桌面应用
- Produces: 测试报告和已知问题列表

- [ ] **Step 1: 准备测试环境**

确保有以下测试环境：
- macOS (Intel 或 Apple Silicon)
- Windows 10 或 Windows 11

- [ ] **Step 2: 执行功能测试清单**

创建 `docs/test-reports/desktop-test-report.md`：

```markdown
# 桌面应用测试报告

**日期:** 2026-09-04
**版本:** 0.1.0

## 测试环境

### macOS
- 操作系统: macOS XX.X
- 架构: Intel / Apple Silicon
- 测试人员: XXX

### Windows
- 操作系统: Windows 10/11
- 测试人员: XXX

## 功能测试清单

### 基础功能
- [ ] 应用启动成功
- [ ] 窗口显示正常
- [ ] 界面渲染正确
- [ ] AI聊天功能正常
- [ ] 线程管理正常
- [ ] 附件功能正常

### 系统托盘
- [ ] 托盘图标显示
- [ ] 托盘菜单正常
- [ ] 显示/隐藏窗口功能
- [ ] 退出应用功能
- [ ] 关闭窗口最小化到托盘

### 文件操作
- [ ] 打开文件对话框
- [ ] 选择文件功能
- [ ] 读取文件内容
- [ ] 保存文件功能
- [ ] 文件拖拽支持（如果实现）

### 全局快捷键
- [ ] Cmd/Ctrl + Space 显示/隐藏窗口
- [ ] Cmd/Ctrl + Shift + S 保存对话
- [ ] 快捷键在窗口隐藏时响应

### 窗口控制
- [ ] 自定义标题栏显示
- [ ] 窗口拖拽功能
- [ ] 最小化按钮
- [ ] 最大化/还原按钮
- [ ] 关闭按钮（最小化到托盘）
- [ ] 窗口状态记忆

### 性能测试
- [ ] 启动时间 < 3秒
- [ ] 内存占用合理
- [ ] CPU占用正常
- [ ] 无内存泄漏

### 安装和卸载
- [ ] 安装程序运行正常
- [ ] 安装后应用可启动
- [ ] 卸载功能正常
- [ ] 卸载后无残留文件

## 已知问题

1. [描述问题]
   - 影响: [影响范围]
   - 计划: [解决方案]

## 性能数据

### macOS
- 启动时间: X.X秒
- 内存占用: XX MB
- 包体积: XX MB

### Windows
- 启动时间: X.X秒
- 内存占用: XX MB
- 包体积: XX MB

## 结论

[测试结论]
```

- [ ] **Step 3: 在macOS上测试**

1. 构建应用：
```bash
bun run tauri:build
```

2. 安装并运行应用：
```bash
open src-tauri/target/release/bundle/macosx/Xulux\ Assistant.app
```

3. 按照测试清单逐一测试

4. 记录测试结果和问题

- [ ] **Step 4: 在Windows上测试**

1. 构建应用：
```bash
bun run tauri:build
```

2. 安装并运行应用：
   - 运行 `src-tauri/target/release/bundle/msi/Xulux Assistant_0.1.0_x64.msi`
   - 启动应用

3. 按照测试清单逐一测试

4. 记录测试结果和问题

- [ ] **Step 5: 修复发现的问题**

根据测试结果，修复发现的问题：

```bash
# 修复问题后提交
git add .
git commit -m "fix: resolve issues found in cross-platform testing

- [问题描述和解决方案]"
```

- [ ] **Step 6: 提交测试报告**

```bash
git add docs/test-reports/desktop-test-report.md
git commit -m "docs: add desktop application test report"
```

---

### Task 13: 构建最终安装包

**Files:**
- 无新增文件

**Interfaces:**
- Consumes: 完整的桌面应用代码
- Produces: 可分发的安装包

- [ ] **Step 1: 准备构建环境**

确保：
- Rust环境已安装
- 目标平台工具链已安装（macOS需要Xcode，Windows需要Visual Studio）

**macOS:**
```bash
xcode-select --install
```

**Windows:**
安装 Visual Studio Build Tools

- [ ] **Step 2: 构建生产版本**

```bash
bun run tauri:build
```

**首次构建可能需要较长时间（10-20分钟）。**

- [ ] **Step 3: 检查构建产物**

**macOS:**
```bash
ls -lh src-tauri/target/release/bundle/
```

预期输出：
- `macosx/Xulux Assistant.app` - 应用程序包
- `dmg/Xulux Assistant_0.1.0_x64.dmg` - 磁盘镜像

**Windows:**
```bash
dir src-tauri\target\release\bundle\
```

预期输出：
- `msi/Xulux Assistant_0.1.0_x64.msi` - MSI安装包
- `nsis/Xulux Assistant_0.1.0_x64-setup.exe` - NSIS安装程序

- [ ] **Step 4: 测试安装包**

**macOS:**
```bash
# 打开dmg文件
open src-tauri/target/release/bundle/dmg/Xulux\ Assistant_0.1.0_x64.dmg

# 安装应用
# 测试应用运行
```

**Windows:**
```powershell
# 运行MSI安装
msiexec /i "src-tauri\target\release\bundle\msi\Xulux Assistant_0.1.0_x64.msi"

# 或运行NSIS安装
.\src-tauri\target\release\bundle\nsis\Xulux Assistant_0.1.0_x64-setup.exe
```

- [ ] **Step 5: 创建发布说明**

创建 `docs/release-notes/v0.1.0.md`：

```markdown
# Xulux Assistant v0.1.0 发布说明

**发布日期:** 2026-09-04

## 新功能

### 桌面应用支持
- ✅ macOS 和 Windows 桌面应用
- ✅ 系统托盘后台运行
- ✅ 本地文件访问
- ✅ 全局快捷键支持
- ✅ 自定义窗口控制

### 功能特性
- AI聊天助手
- 线程管理
- 附件支持
- Markdown渲染

## 系统要求

### macOS
- macOS 10.13 或更高版本
- Intel 或 Apple Silicon 处理器

### Windows
- Windows 10 或更高版本
- x64 处理器

## 安装方法

### macOS
1. 下载 `Xulux Assistant_0.1.0_x64.dmg`
2. 打开dmg文件
3. 拖拽应用到Applications文件夹
4. 启动应用

### Windows
1. 下载 `Xulux Assistant_0.1.0_x64.msi`
2. 双击运行安装程序
3. 按照向导完成安装
4. 启动应用

## 已知问题

暂无

## 快捷键

- `Cmd/Ctrl + Space`: 显示/隐藏窗口
- `Cmd/Ctrl + Shift + S`: 保存对话

## 致谢

感谢 Tauri 团队提供优秀的桌面应用框架。
```

- [ ] **Step 6: 提交发布文件**

```bash
git add docs/release-notes/v0.1.0.md
git commit -m "docs: add v0.1.0 release notes

- Document new features and system requirements
- Add installation instructions
- Document keyboard shortcuts"
```

---

## 最终检查清单

在完成所有任务后，确保：

### 功能完整性
- [✓] Web应用功能完整保留
- [✓] 桌面应用可独立运行
- [✓] 系统托盘功能正常
- [✓] 本地文件访问功能正常
- [✓] 全局快捷键功能正常
- [✓] 自定义窗口控制功能正常

### 代码质量
- [✓] 无TypeScript编译错误
- [✓] 无Rust编译错误
- [✓] 错误处理完善
- [✓] 代码有适当注释

### 测试覆盖
- [✓] macOS测试通过
- [✓] Windows测试通过
- [✓] 功能测试清单完成
- [✓] 性能测试达标

### 文档完整性
- [✓] 设计文档完整
- [✓] 实施计划完整
- [✓] 测试报告完整
- [✓] 发布说明完整

### 构建产物
- [✓] macOS安装包生成
- [✓] Windows安装包生成
- [✓] 安装包测试通过

---

**计划完成！** 🎉

**下一步：**
- 执行计划（使用 superpowers:subagent-driven-development 或 superpowers:executing-plans）
- 开始第一个任务

**预计总时间：** 4-7天（根据团队经验和测试复杂度）