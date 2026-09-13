"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  // relative：指示器是列表的绝对定位子元素，几何锚定在列表上。
  "group/tabs-list relative inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-9 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
        // 描边紧凑分段样式：透明底 + 细边框容器，选中块用 bg-muted
        outline: "gap-0.5 border border-border/60 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      <TabsIndicator />
      {children}
    </TabsPrimitive.List>
  )
}

/**
 * 激活态高亮块：常驻在 TabsList 里的单个元素，几何取自 base-ui Indicator
 * 维护的 CSS 变量（--active-tab-left/top/width/height），变量是"活动 tab
 * 相对列表"的布局偏移，每次布局变化后重新测量；再用 CSS transition 把变量
 * 的阶跃变化滑成动画。
 *
 * 为什么不用 framer 共享布局（layoutId / layout 投影）：portal 化的 dialog
 * popup 按内容高度垂直居中，页签切换的提交帧里面板会瞬时塌缩/重挂，整个
 * 列表在视口里跳一百多像素；framer 按视口坐标测 delta，会把这次祖先位移
 * 回放成指示器动画——即"切换时从上往下飞"的 bug。CSS 变量是列表相对系，
 * 对 popup 重定位天然免疫；transition 只作用在 left/top/width/height 本身
 * 的真实变化上。时长曲线取 EASE_OUT（cubic-bezier(0.16,1,0.3,1)），观感与
 * 参考实现的 no-overshoot spring 基本一致。
 *
 * 样式按 TabsList 的 variant（data-variant）在胶囊/下划线之间切换，几何与
 * 旧版（按钮自身背景 / after: 伪元素）保持一致。
 */
function TabsIndicator() {
  return (
    <TabsPrimitive.Indicator
      data-slot="tabs-indicator"
      className={cn(
        // 基础几何 = 胶囊：贴住活动 tab 的完整盒，继承列表圆角
        // （消费方通常同款 rounded-*）。transition-all 只覆盖这组盒属性
        // 的变化；hidden（display:none）切换不产生过渡，打开即定位无入场飞。
        "pointer-events-none absolute left-(--active-tab-left) top-(--active-tab-top) h-(--active-tab-height) w-(--active-tab-width) rounded-[inherit] border border-transparent",
        "motion-safe:transition-all motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]",
        "group-data-[variant=default]/tabs-list:bg-background group-data-[variant=default]/tabs-list:shadow-sm group-data-[variant=default]/tabs-list:dark:border-input group-data-[variant=default]/tabs-list:dark:bg-input/30",
        "group-data-[variant=outline]/tabs-list:bg-muted",
        // 下划线（line）：横向贴在活动 tab 底边下方 3~5px（同旧版
        // after: bottom-[-5px] h-0.5），纵向贴右边外 2~4px。变体规则
        // 排序在普通工具类之后，能稳定赢过基础几何。
        "group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:bg-foreground",
        "group-data-[variant=line]/tabs-list:group-data-horizontal/tabs:top-[calc(var(--active-tab-top)_+_var(--active-tab-height)_+_3px)] group-data-[variant=line]/tabs-list:group-data-horizontal/tabs:h-0.5",
        "group-data-[variant=line]/tabs-list:group-data-vertical/tabs:left-[calc(var(--active-tab-left)_+_var(--active-tab-width)_+_2px)] group-data-[variant=line]/tabs-list:group-data-vertical/tabs:w-0.5",
      )}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-colors group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "data-active:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
