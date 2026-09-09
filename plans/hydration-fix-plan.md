# Hydration 错误修复计划

## 问题分析

根据错误堆栈和代码审查，Hydration 错误的根本原因是：

1. **`isTauri()` 函数在 SSR 和客户端返回不一致的值**
   - [`isTauri()`](lib/tauri.ts:8) 依赖 `typeof window !== 'undefined'` 和 `__TAURI_INTERNALS__` 检测
   - 在 SSR 期间，`window` 未定义，返回 `false`
   - 在客户端，如果在 Tauri 环境中运行，返回 `true`
   - 这导致 `WorkspacePill` 组件在 SSR 时渲染 `null`，但在客户端渲染实际内容

2. **`ThreadWelcome` 组件使用 `new Date()`**
   - [`getGreeting()`](components/agent-thread/thread-welcome.tsx:5) 函数在每次调用时返回不同的问候语
   - 这会导致 SSR 和客户端渲染的 HTML 不一致

## 需要修复的组件

1. **[`lib/tauri.ts`](lib/tauri.ts:8)** - `isTauri()` 函数
2. **[`components/agent-thread/composer.tsx`](components/agent-thread/composer.tsx:164)** - `WorkspacePill` 组件
3. **[`components/agent-thread/thread-welcome.tsx`](components/agent-thread/thread-welcome.tsx:5)** - `ThreadWelcome` 组件

## 修复方案

### 方案 1: 修复 `isTauri()` 函数

**问题**: `isTauri()` 在 SSR 期间返回 `false`，但在客户端可能返回 `true`，导致条件渲染不一致。

**解决方案**: 创建一个 `isTauriClient` 变量，在客户端模块加载时确定环境，并在 SSR 期间始终返回 `false`。

```typescript
// lib/tauri.ts
let isTauriClient: boolean | undefined;

export const isTauri = (): boolean => {
  if (typeof window === "undefined") {
    return false; // SSR 期间始终返回 false
  }
  if (isTauriClient !== undefined) {
    return isTauriClient;
  }
  isTauriClient =
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
  return isTauriClient;
};
```

### 方案 2: 修复 `WorkspacePill` 组件

**问题**: `WorkspacePill` 组件依赖 `isTauri()` 和 `hasMessages`，在 SSR 和客户端可能返回不同的值。

**解决方案**: 使用 `useEffect` 确保仅在客户端更新状态，避免 SSR 渲染。

```typescript
// components/agent-thread/composer.tsx
const WorkspacePill: FC = () => {
  const workspace = useWorkspace();
  const recents = useWorkspaceRecents();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasMessages, setHasMessages] = useState(true); // 初始值确保 SSR 一致

  useEffect(() => {
    setHasMessages(useAuiState((s) => s.thread.messages.length > 0));
  }, []);

  if (!isTauri() || hasMessages) return null;
  // ...
};
```

### 方案 3: 修复 `ThreadWelcome` 组件

**问题**: `getGreeting()` 使用 `new Date()`，在 SSR 和客户端返回不同的值。

**解决方案**: 使用固定的问候语或在客户端动态生成。

```typescript
// components/agent-thread/thread-welcome.tsx
export const ThreadWelcome: FC = () => {
  const [greeting, setGreeting] = useState("");

  useEffect(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 11) setGreeting("早安呀，新的一天开始了，接下去让我来发挥");
    else if (hour >= 11 && hour < 13) setGreeting("中午好呀，接下去让我来发挥");
    else if (hour >= 13 && hour < 18) setGreeting("下午好呀，接下去让我来发挥");
    else if (hour >= 18 && hour < 22) setGreeting("晚上好呀，接下去让我来发挥");
    else setGreeting("夜深了，注意休息，接下去让我来发挥");
  }, []);

  return (
    <div className="aui-thread-welcome-root mx-auto mb-6 flex w-full max-w-(--thread-max-width) flex-col items-center px-4 text-center">
      <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">
        {greeting}
      </p>
    </div>
  );
};
```

## 实施步骤

1. 修改 [`lib/tauri.ts`](lib/tauri.ts:8) 添加 `isTauriClient` 缓存
2. 修改 [`components/agent-thread/composer.tsx`](components/agent-thread/composer.tsx:164) 修复 `WorkspacePill` 组件
3. 修改 [`components/agent-thread/thread-welcome.tsx`](components/agent-thread/thread-welcome.tsx:5) 修复 `ThreadWelcome` 组件
4. 运行开发服务器验证修复
