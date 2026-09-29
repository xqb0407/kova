/**
 * 模型命令：清单/过滤/选择/思考档位与 thinkingLevelMap 覆盖/属性种子反查。
 * 目录本体在 model/（catalog + state + thinking），覆盖应用见 custom-providers。
 */
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { send } from "../stream";
import { getImageGenConfig } from "../../tools/imagegen-config";
import { findRunBySession, running } from "../../sessions/sessions";
import {
  appendModelChangeRow,
  appendThinkingLevelChangeRow,
} from "../../sessions/transcript";
import { composeModeSystemPrompt } from "../../agent/modes";
import { kvSet, modelsAll, modelsDeleteProvider, modelsList, modelsReplace, sessionGet, sessionPrefsSet, type ModelReplaceItem } from "../../storage/hostdb";
import {
  applyRowToCatalogModel,
  getCurrentModelKey,
  getModelDefaultedAttrs,
  getModels,
  lookupCatalogModelSeed,
  setCurrentModelKey,
  setCurrentThinkingLevel,
  setThinkingMapOverrides,
  THINKING_LEVELS,
  type DefaultedAttr,
  type ThinkingLevel,
} from "../../model/model-catalog";
import type { CommandHandler } from "../command";
import type { Running } from "../../types";

export const handlers: Record<string, CommandHandler> = {
  list_models: async (reqId) => {
    const models = getModels();
    const out: {
      provider: string;
      providerName: string;
      id: string;
      name: string;
      reasoning: boolean;
      /** 该模型实际支持的思考档位（pi-ai 按 reasoning + thinkingLevelMap 推导，不含 off） */
      supportedThinkingLevels: string[];
      /** 生效中的思考参数映射（目录原值 + 前端覆盖合并；编辑器种子） */
      thinkingLevelMap: Record<string, string | null> | null;
      contextWindow: number;
      maxTokens: number;
      /** 仍由 sidecar 缺省猜测值占位的属性（空 = 目录真值或用户已填） */
      defaultedAttrs: DefaultedAttr[];
      input: string[];
      cost: Record<string, unknown>;
      enabled: boolean;
      authed: boolean;
      /** 用户标记"可生成图片"（设置 → 模型属性勾选）：文生图默认模型下拉据此过滤 */
      t2i: boolean;
    }[] = [];
    const providerMap = new Map<string, { id: string; name: string; authed: boolean }>();
    // models 表行：enabled 位 + 属性覆盖（属性已在启动/保存时合并进目录模型对象）。
    // 行语义是稀疏白名单：provider 有行时，行 enabled=1 可见、无行/enabled=0 隐藏；无任何行 = 全可见。
    const rows = await modelsAll();
    const enabledMap = new Map<string, boolean>();
    const hasRows = new Set<string>();
    for (const r of rows) {
      enabledMap.set(`${r.provider}/${r.modelId}`, r.enabled);
      hasRows.add(r.provider);
    }
    // 生图能力标记：imagegen 配置里的 imageModels 清单（"provider/modelId"）覆盖层
    const t2iSet = new Set(getImageGenConfig().imageModels);
    for (const p of models.getProviders()) {
      let authed = false;
      try {
        authed = (await models.getAuth(p.id)) !== undefined;
      } catch {
        authed = false;
      }
      providerMap.set(p.id, { id: p.id, name: p.name, authed });
      for (const m of p.getModels()) {
        out.push({
          provider: p.id,
          providerName: p.name,
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          supportedThinkingLevels: getSupportedThinkingLevels(m).filter(
            (l) => l !== "off",
          ),
          thinkingLevelMap: (m.thinkingLevelMap ??
            null) as Record<string, string | null> | null,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          defaultedAttrs: getModelDefaultedAttrs(p.id, m.id),
          input: m.input,
          cost: m.cost as unknown as Record<string, unknown>,
          enabled: hasRows.has(p.id)
            ? (enabledMap.get(`${p.id}/${m.id}`) ?? false)
            : true,
          authed,
          t2i: t2iSet.has(`${p.id}/${m.id}`),
        });
      }
    }
    send({
      id: reqId,
      type: "models",
      models: out,
      providers: [...providerMap.values()],
    });
  },

  get_provider_filter: async (reqId, msg) => {
    const provider = String(msg.provider ?? "");
    const rows = await modelsList(provider);
    // 无行 = 从未设置过滤（目录全可见）；有行 = 勾选集为 enabled=1 的行
    const modelIds = rows.length
      ? rows.filter((r) => r.enabled).map((r) => r.modelId)
      : null;
    send({ id: reqId, type: "provider_filter", provider, models: modelIds });
  },

  set_provider_filter: async (reqId, msg) => {
    const provider = String(msg.provider ?? "");
    const checked = new Set(
      Array.isArray(msg.models)
        ? (msg.models as unknown[]).filter(
            (s): s is string => typeof s === "string" && !!s.trim(),
          )
        : [],
    );
    if (checked.size === 0) {
      // 空勾选 = 清除过滤记录（目录恢复全可见）
      await modelsDeleteProvider(provider);
      send({ id: reqId, type: "provider_filter", provider, models: null });
      return;
    }
    // 勾选集写 enabled=1 行（属性覆盖保留）；未勾选的既有行保留属性、enabled=0
    const existing = new Map(
      (await modelsList(provider)).map((r) => [r.modelId, r]),
    );
    const items: ModelReplaceItem[] = [];
    for (const id of checked) {
      const base = existing.get(id);
      items.push({
        modelId: id,
        enabled: true,
        name: base?.name ?? null,
        reasoning: base?.reasoning ?? null,
        contextWindow: base?.contextWindow ?? null,
        maxTokens: base?.maxTokens ?? null,
        input: base?.input ?? null,
        cost: base?.cost ?? null,
      });
    }
    for (const row of existing.values()) {
      if (checked.has(row.modelId)) continue;
      items.push({
        modelId: row.modelId,
        enabled: false,
        name: row.name,
        reasoning: row.reasoning,
        contextWindow: row.contextWindow,
        maxTokens: row.maxTokens,
        input: row.input,
        cost: row.cost,
      });
    }
    await modelsReplace(provider, items);
    // 新勾选的目录外模型（内置厂商手动添加的 modelId）按行挂进目录；既有模型重放覆盖
    for (const item of items) {
      applyRowToCatalogModel({
        provider,
        modelId: item.modelId,
        name: item.name ?? null,
        reasoning: item.reasoning ?? null,
        contextWindow: item.contextWindow ?? null,
        maxTokens: item.maxTokens ?? null,
        input: item.input ?? null,
        cost: item.cost ?? null,
      });
    }
    send({
      id: reqId,
      type: "provider_filter",
      provider,
      models: [...checked],
    });
  },

  set_model: async (reqId, msg) => {
    const provider = String(msg.provider ?? "");
    const modelId = String(msg.modelId ?? "");
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId.trim() : "";
    const model = getModels().getModel(provider, modelId);
    if (!model) throw new Error(`model not found: ${provider}/${modelId}`);
    const auth = await getModels().getAuth(provider).catch(() => undefined);
    if (!auth) throw new Error(`no credentials configured for ${provider}/${modelId}`);
    // 定靶形态先校验会话存在（校验全部前置：被拒命令不得留下任何状态变更）
    if (sessionId && !(await sessionGet(sessionId)))
      throw new Error(`session not found: ${sessionId}`);
    // 全局「最近一次使用」：kv 持久化（重启由 initCurrentModelKey 恢复），
    // 供新会话与从未显式选过模型的会话跟随
    setCurrentModelKey({ provider, modelId });
    void kvSet("pi.model", JSON.stringify({ provider, modelId })).catch(() => {});
    // 模型行是系统提示词环境段的一部分：换模型后整段重排，驻留 run 即时生效
    const restamp = (run: Running): void => {
      run.agent.state.model = model;
      run.agent.state.systemPrompt = composeModeSystemPrompt(
        run.mode,
        run.cwd,
        model,
        run.designTheme,
      );
    };
    if (sessionId) {
      // 会话定靶（对话页选择器）：转录 model_change 行 = 会话模型真值（§6 M4），
      // 只落被点名的会话——盖写所有驻留会话正是「A 切模型、B 跟着变」的根因。
      // 偏好行同步 await（前端紧接的快照回拉必须读到新值，fire-and-forget 会竞态）
      const owner = findRunBySession(sessionId);
      if (owner) restamp(owner.run);
      appendModelChangeRow(sessionId, provider, modelId);
      await sessionPrefsSet(sessionId, { modelProvider: provider, modelId }).catch(() => {});
    } else {
      // 全局默认变更（设置页/启动恢复）：只即时刷「从未显式选过模型」的驻留 run
      // （无偏好行 = 真值跟随全局）；已有自身选择的会话保持原模型，不落行
      for (const run of running.values()) {
        const row = await sessionGet(run.sessionId);
        if (row?.modelProvider && row?.modelId) continue;
        restamp(run);
      }
    }
    send({ id: reqId, type: "model", provider, modelId });
  },

  get_model: async (reqId) => {
    const mk = getCurrentModelKey();
    send({
      id: reqId,
      type: "model",
      provider: mk?.provider ?? "",
      modelId: mk?.modelId ?? "",
    });
  },

  set_thinking: async (reqId, msg) => {
    const level = String(msg.level ?? "");
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
      throw new Error(`unknown thinking level: ${level}`);
    }
    setCurrentThinkingLevel(level as ThinkingLevel);
    // 与 set_model 同款广播：活动 Agent 的 state 赋值对下一轮生效；
    // 逐驻留会话落 thinking_level_change 行（§6 M4：重开该会话按行回放档位）
    for (const run of running.values()) {
      run.agent.state.thinkingLevel = level as ThinkingLevel;
      appendThinkingLevelChangeRow(run.sessionId, level);
    }
    send({ id: reqId, type: "thinking", level });
  },

  set_thinking_maps: async (reqId, msg) => {
    // 模型级思考参数映射整包替换（前端 kv 是事实源，这里是内存副本）：
    // {"provider/modelId": {"off":"none","minimal":null,...}}，见 model-catalog
    const applied = setThinkingMapOverrides(msg.maps);
    send({ id: reqId, type: "thinking_maps", applied });
  },

  lookup_thinking_seed: async (reqId, msg) => {
    // 属性弹窗预填：自定义/目录外模型按 modelId 反查内置目录的属性种子
    //（思考参数 + contextWindow/maxTokens/input/cost 目录真值）
    const modelId = String(msg.modelId ?? "").trim();
    send({
      id: reqId,
      type: "thinking_seed",
      seed: modelId ? (lookupCatalogModelSeed(modelId) ?? null) : null,
    });
  },
};
