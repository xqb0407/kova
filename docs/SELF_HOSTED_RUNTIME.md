# Runtime 配置说明

## 当前状态

项目目前使用 **Demo Runtime**，基于 AI SDK 实现，不需要额外服务。

## Runtime 架构

### 当前使用：Demo Runtime

**文件位置**: `components/runtime/demo-runtime-provider.tsx`

**特点**:
- ✅ 免费，使用自己的 API key
- ✅ 简单，不需要额外服务
- ✅ 适合开发和测试

**API 配置**:
- 接口地址: `/api/chat`
- 需要配置自己的 AI API key

### 自研 Runtime 开发指南

如需开发自己的 runtime，参考以下步骤：

#### 1. 创建 Runtime Provider

```typescript
// components/runtime/my-runtime-provider.tsx
"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useMyRuntime } from "./my-runtime";

export function MyRuntimeProvider({ children }: { children: React.ReactNode }) {
  const runtime = useMyRuntime({
    // 你的配置
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
```

#### 2. 实现 Runtime Hook

```typescript
// hooks/use-my-runtime.ts
import { useExternalStoreRuntime } from "@assistant-ui/react";

export function useMyRuntime(config: MyConfig) {
  return useExternalStoreRuntime({
    // 实现你的 runtime 逻辑
  });
}
```

#### 3. 更新页面入口

```typescript
// app/page.tsx
import { MyRuntimeProvider } from "@/components/runtime/my-runtime-provider";
import { Base } from "@/components/examples/base";

export default function Page() {
  return (
    <main className="h-dvh overflow-hidden">
      <MyRuntimeProvider>
        <Base />
      </MyRuntimeProvider>
    </main>
  );
}
```

## 文档参考

- [assistant-ui Runtime 文档](https://www.assistant-ui.com/docs/runtimes)
- [External Store Runtime](https://www.assistant-ui.com/docs/runtimes/custom/ExternalStoreRuntime)

## 文件结构

```
components/
├── runtime/
│   └── demo-runtime-provider.tsx    # 当前使用的 Demo runtime

app/
└── page.tsx                         # 使用 DemoRuntimeProvider
```

## 下一步

1. 设计自研 runtime 的架构
2. 实现核心功能（消息处理、流式响应等）
3. 集成到项目中
4. 测试和优化