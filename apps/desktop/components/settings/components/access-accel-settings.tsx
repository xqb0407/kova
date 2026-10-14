"use client";

import { useState, type FC } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { toast } from "@/components/ui/toast";
import {
  DEFAULT_GITHUB_PREFIX,
  saveMirrorConfig,
  useMirrorConfig,
  type MirrorConfig,
} from "@/lib/settings/mirror-config";

/**
 * 访问加速设置页：AI 联网时的镜像改写总闸。
 *
 * 做的事很窄：把「已知慢/不通的地址」换成「加速前缀 + 原地址」。内建规则只覆盖
 * GitHub 的 raw 文件、发行包与源码包（国内真正卡死的那几步），另外留了自定义
 * 规则给别的站点（如 huggingface → hf-mirror）。仓库页面不改写——多数网络能开，
 * 绕第三方反而更慢。
 *
 * 事实源在 sidecar（SQLite kv），WebFetch 与 bash 的 git 注入每次调用实时读；
 * 这里只做镜像（lib/settings/mirror-config），乐观更新失败回滚并提示。
 *
 * 两条硬边界写死在 sidecar（url-mirror.ts），设置页改不了也不打算暴露：
 * 带 Authorization/token 的链接不改写（凭据不发第三方），git push 不注入
 * （镜像只代理读）。
 *
 * 规则的编辑是**逐字符落库**的：列表直接渲染事实源，增删改都立刻 save。
 * 曾经写过"失焦才提交 + 提交时筛掉填一半的行"的版本，结果是点开第一个输入框
 * 再点第二个时，第一个输入框的 blur 把两栏还空着的行当成空规则筛掉，整行当场
 * 消失。现在半截行原样存（sidecar 侧 verbatim），能不能用由改写侧判定。
 * 加速前缀是唯一例外，仍走失焦提交——它是拼在地址前面的，半截值会拼出坏链接。
 */
export const AccessAccelSettings: FC = () => {
  const config = useMirrorConfig();
  // 加速前缀是受控的本地草稿，失焦（或回车）才落库：前缀是**拼**在地址前面的，
  // 输入途中的半截值（https://h）会拼出能发出去但必然失败的链接。自定义规则相反，
  // 见下面 rules 的注释。
  const [prefixDraft, setPrefixDraft] = useState<string | null>(null);
  const prefixValue = prefixDraft ?? config.githubPrefix;
  const rules = config.customRules;

  const save = (next: MirrorConfig) => {
    saveMirrorConfig(next).catch(() => toast.error("保存失败，请重试"));
  };

  const commitPrefix = () => {
    const draft = prefixDraft;
    setPrefixDraft(null);
    if (draft === null || draft === config.githubPrefix) return;
    save({ ...config, githubPrefix: draft });
  };

  const commitOnEnter = (e: { key: string; currentTarget: { blur: () => void } }) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">访问加速</h1>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">GitHub</h2>
          <p className="text-muted-foreground text-sm">
            AI 读到或下载 GitHub 地址时自动改走加速站，你不需要自己拼镜像链接。
            只改写 raw 文件、发行包（releases/download）与源码包（archive）——
            仓库页面、issue 这些照原样直连。
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label="访问加速"
              desc="总开关。关闭后所有地址原样直连，自定义规则也一并停用。"
            >
              <Switch
                checked={config.enabled}
                onCheckedChange={(v) => save({ ...config, enabled: v })}
              />
            </SettingRow>
            <SettingRow
              label="加速前缀"
              desc={`前缀 + 原地址即得加速链接，例如 ${DEFAULT_GITHUB_PREFIX}/https://github.com/…。留空表示不改写 GitHub，只保留下面的自定义规则。可用 ${DEFAULT_GITHUB_PREFIX}、https://gh-proxy.com、https://ghproxy.net 等。`}
            >
              <Input
                className="h-8 w-64 text-sm"
                value={prefixValue}
                placeholder={DEFAULT_GITHUB_PREFIX}
                spellCheck={false}
                onChange={(e) => setPrefixDraft(e.target.value)}
                onBlur={commitPrefix}
                onKeyDown={commitOnEnter}
              />
            </SettingRow>
            <SettingRow
              label="git 命令也走加速"
              desc="AI 在终端里 git clone / git fetch 时，github.com 地址自动换成上面的加速前缀。只影响这一条命令的进程，不改你机器上的 git 配置；git push 始终直连（镜像不代理写操作）。"
            >
              <Switch
                checked={config.gitInsteadOf}
                disabled={!config.enabled || !config.githubPrefix}
                onCheckedChange={(v) => save({ ...config, gitInsteadOf: v })}
              />
            </SettingRow>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">自定义规则</h2>
          <p className="text-muted-foreground text-sm">
            前缀替换：命中「原前缀」的地址会换成「替换前缀」，其余部分保持不变。
            例如把 https://huggingface.co 换成 https://hf-mirror.com。自定义规则
            优先于上面的内建 GitHub 规则。
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            {rules.length === 0 ? (
              <div className="text-muted-foreground px-3 py-4 text-xs">
                还没有自定义规则。GitHub 之外常用的镜像站都可以加在这里。
              </div>
            ) : (
              rules.map((rule, index) => (
                <div
                  // 规则没有稳定 id（新增的空行也要能渲染），编辑期间列表不重排，
                  // 位置即身份
                  key={index}
                  className="flex items-center gap-2 px-3 py-2"
                >
                  <Input
                    className="h-8 flex-1 text-sm"
                    value={rule.from}
                    placeholder="https://huggingface.co"
                    spellCheck={false}
                    onChange={(e) =>
                      save({
                        ...config,
                        customRules: rules.map((r, i) =>
                          i === index ? { ...r, from: e.target.value } : r,
                        ),
                      })
                    }
                  />
                  <span className="text-muted-foreground text-sm">→</span>
                  <Input
                    className="h-8 flex-1 text-sm"
                    value={rule.to}
                    placeholder="https://hf-mirror.com"
                    spellCheck={false}
                    onChange={(e) =>
                      save({
                        ...config,
                        customRules: rules.map((r, i) =>
                          i === index ? { ...r, to: e.target.value } : r,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="删除这条规则"
                    onClick={() =>
                      save({ ...config, customRules: rules.filter((_, i) => i !== index) })
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              ))
            )}
            <div className="px-3 py-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  save({ ...config, customRules: [...rules, { from: "", to: "" }] })
                }
              >
                <PlusIcon className="size-3.5" />
                添加规则
              </Button>
            </div>
          </div>
          <p className="text-muted-foreground/60 text-xs">
            两侧都填成完整地址才会生效：只填一半的行会照原样留着（下次打开还在），
            但要等两侧补齐才参与改写——不会拿半截字符串去拼链接。加速站是第三方
            服务，带 Authorization 头或 token 查询参数的链接不会被改写，避免把
            凭据发出去。
          </p>
        </section>
      </div>
    </div>
  );
};
