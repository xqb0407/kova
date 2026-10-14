# Kova 企业服务端（控制面）设计文档

> 版本：v0.1（设计稿，未实现）
> 定位：**服务端优先** —— 控制面是客户端契约的源头。客户端 `enterprise_*` 命令由本篇契约**反向推导**，不反向定义。
> 技术栈：**Java**，**背压（Backpressure）为一等设计约束**。
> 关系：`docs/enterprise/EKOVA-DESIGN.md` 是总体骨架（席位体系为主线）；本篇是其 **§3 控制面 / §6 计量与埋点 / §8 落点** 的落地契约。
> 范围：仅设计，不含产品代码改动。

---

## 1. 定位与范围

### 1.1 服务端要负责什么

服务端 = **控制面**，承载所有「企业意志」：

| 域 | 职责 |
|---|---|
| 身份 | IdP 连接器（OIDC / LDAP / 飞书·钉钉）、会话换发、设备入网、令牌与撤销 |
| 席位 | 席位发放 / 回收 / 转移 / 冻结、角色映射、能力集（entitlement）生成与版本化 |
| License | 离线签名凭证校验、席位数与有效期门禁、超发拒绝 |
| 模型 | 模型网关：虚拟密钥、路由、**同步计量**、硬配额、允许清单 |
| 技能 | 注册中心：上传、签名、版本、可见范围、强制启停 |
| 知识 | MCP 代理（接企业已有检索）；查询时 ACL 裁剪；后续可选自建 RAG |
| 计量 | telemetry 幂等入库、按用户/团队/模型/席位聚合、报表 |
| 审计 | 登录、席位变更、导出、配额触顶等审计事件留存 |
| 管理台 | 席位/配额/策略/报表的 Web 管理面 |

### 1.2 与客户端的分工（契约为准）

```
服务端（控制面，权威）               客户端（企业模式，消费方）
─────────────────────────           ──────────────────────────
席位 / 角色 / 配额 ─── entitlement ─→ 能力门禁（model.scope / knowledge.scope / skills.allow）
模型网关 + 虚拟密钥 ── 配置下发 ────→ custom_providers（base_url / api_key）
telemetry ingest  ←── 批量上报 ─────  enterprise_telemetry_emit
席位变更 ───────── WS 推送 ───────→  热更新能力集
```

> 原则：**权威在服务端**。客户端只做「消费契约 + 本地降级」，不自行定义能力边界。

### 1.3 边界（本篇不做）

- 不做客户端 UI / 桌面壳改造（见总览文档）。
- 不做模型推理本体（内网 GPU 集群由 vLLM / Ollama 承担；网关只做代理与计量）。
- 不做自建 RAG 的检索引擎实现（P3b 可选，作为模块替换）。

---

## 2. 技术选型

### 2.1 结论

> **架构形态：模块化单体（Modular Monolith）—— 单个可部署 Java 应用，内部按限界上下文分模块。明确不做微服务。** 私有化内网交付要的是低运维、单进程内调用、无分布式复杂度；模块边界靠代码结构（而非网络）约束。

| 层 | 选型 | 理由 |
|---|---|---|
| **架构形态** | **模块化单体**：一个 Java 应用（单镜像单进程），内含身份 / 席位 / 网关 / 计量 / 推送 / 管理台各模块 | 单进程内调用，无分布式事务与跨服务路由；运维面最小 |
| 语言 / 运行时 | **Java 21（LTS）**，启用 Virtual Threads | 长期支持、生态成熟；虚拟线程让「阻塞式调用（JDBC / IdP / OIDC）」也能高并发，配合信号量做背压 |
| 主框架 | **Spring Boot 3.x + WebFlux（Project Reactor）** | 原生 **Reactive Streams** 语义，`request(n)` 就是背压的原语 |
| **DDD 结构** | **Spring Modulith + jMolecules** | 模块边界 = 限界上下文；领域事件驱动跨模块协作；`modulith-verification` / ArchUnit 守护边界不被腐蚀 |
| 主库 | **PostgreSQL 16** + **R2DBC**（响应式驱动） | 事务与关系模型适合席位/授权；R2DBC 不阻塞事件循环 |
| 缓存 / 计数 | Redis（**可选**） | 配额与限流的低延迟计数；小客户可**纯 PG**（原子 `UPDATE ... WHERE used < limit`） |
| 计量削峰 | **进程内有界队列 + PG 持久队列**（`FOR UPDATE SKIP LOCKED` + 批量 upsert） | 单体下无需消息中间件；削峰在进程内 + 库表完成。Kafka / Pulsar **仅超大规模时可选**，不进基线 |
| 对象存储 | S3 兼容（MinIO）——**可选** | 技能包 / 制品；单机部署可用本地卷 |
| 管理台 | **同进程模块**（静态 SPA 由同进程托管） | 管理面与数据面**同进程、不同路由前缀 + 鉴权隔离**，不另起进程 |
| 模型网关 | **同进程内 WebFlux 流式代理模块** | 不再独立部署网关；仅**借鉴** ShenYu 的插件化设计思想，不引入其 admin/bootstrap 双进程 |
| 交付 | 容器镜像（Docker）+ Helm（**单镜像**） | 与总览 §7 部署形态对齐 |

### 2.2 为什么是 Java + 响应式（与背压强相关）

- 企业场景的流量特征不是「高 QPS」而是 **「多客户端 + 突发批量上报 + 长连接推送 + 流式推理」**：
  - 客户端 telemetry 批量上报会有**洪峰**（断连后集中补报）；
  - 模型网关要**流式**把上游 token 转发给客户端，慢客户端不能拖垮服务端内存；
  - 控制通道是 **WS 长连接**，客户端消费慢时不能无限积压推送。
- 这些正是 **背压**问题。Java 21 + WebFlux 的组合把背压做成**框架级能力**（Reactive Streams `request(n)`），而不是靠业务代码打补丁。

### 2.3 基座与许可评估（可否直接二开）

**结论：没有单一开源项目同时具备「端到端背压 + DDD」，且多数与「单体」冲突——因此采用「框架组合」，不选单一项目二开。**

| 候选 | 许可 | 背压机制 | DDD 贴合 | 单体适配 / 结论 |
|---|---|---|---|---|
| **Spring Boot + WebFlux/Reactor + Spring Modulith + jMolecules** | Apache-2.0（全部） | Reactive Streams `request(n)` | **高**（模块=限界上下文 + 领域事件 + 边界校验） | ✅ **选为基座**：Modulith 本就是为模块化单体设计 |
| Apache ShenYu | Apache-2.0 | Reactor/WebFlux RS；转发主要靠 Redis 令牌桶 | 中（插件化，无 DDD 原语） | ⚠️ admin + bootstrap **双进程**，与单体冲突 → **仅借鉴插件化设计**，不作基座 |
| COLA（阿里） | **LGPL-2.1** | 无 | 极高（分层契约） | ⚠️ 非 Apache 许可，二开后再分发需法务评估 → **不采用**，以 Modulith/jMolecules 替代 |
| Axon FW / Server | 核心 Apache-2.0，**Server 企业版商业** | 查询 pull 式 + Server gRPC permits（**非 RS 语义**） | 极高（聚合/命令/事件溯源/CQRS/Saga） | ⚠️ 需 Axon Server（事件存储）与 WebFlux 摩擦大 → 单体下不选 |
| Apache Pekko | Apache-2.0 | Akka Streams RS（最强） | 低 | ⚠️ 需自建 DDD 层；**注意 Akka 已转 BSL**，如需 Actor/Streams 用 Pekko |
| RSocket-Java | Apache-2.0 | 协议级 `request-n` / Leasing | 无关 | ◐ 半休眠；可作**客户端传输**可选（协议级背压），不作应用基座 |
| Spring Cloud Gateway | Apache-2.0 | Reactor RS | 低 | ◐ 独立网关进程 → 与单体冲突，仅取 Filter 思路 |

> 许可红线（私有化交付前必须确认）：**Akka → BSL**（用 Pekko 替代）；**COLA → LGPL-2.1**（非 Apache）；**Axon Server 企业版 → 商业授权**。

---

## 3. 背压设计（核心章）

### 3.1 为什么必须显式做背压

| 场景 | 无背压的后果 |
|---|---|
| telemetry 批量上报 | 洪峰打满线程/内存 → OOM；或阻塞主库 → 控制面整体不可用 |
| 模型网关流式转发 | 慢客户端导致服务端缓冲无限增长 → 内存爆炸 |
| WS 控制通道推送 | 客户端消费慢 → 出站队列无界 → 单连接拖垮进程 |
| 配额计数 | 计数成为热点 → 延迟抖动，反压到网关 |

### 3.2 四类背压场景与策略

| # | 场景 | 背压机制 | 溢出策略 |
|---|---|---|---|
| B1 | **telemetry 批量上报**（客户端 → 服务端） | **credit-based pull**：客户端按服务端下发的 credit（可上报条数/并发）拉式上报；服务端用**进程内有界队列 + 水位阈值**，落库走 **PG 持久队列**（`FOR UPDATE SKIP LOCKED` + 批量 upsert） | 水位超限返回 `429 + Retry-After`；客户端本地缓冲继续累积（见总览 §6.4） |
| B2 | **模型网关流式转发**（上游 → 网关 → 客户端） | `Flux<DataBuffer>` + `request(n)` **逐块拉取**；`limitRate` 控制批大小 | 客户端断开即向上游 `cancel()`；上游慢则反压上游（不本地无界缓冲） |
| B3 | **WS 控制通道推送**（服务端 → 客户端） | 每连接**有界出站队列**；`onBackpressureBuffer(limit, onOverflow)` | **合并丢弃旧值**：能力集/清单类推送只保留最新（幂等覆盖），并标记 `coalesced` |
| B4 | **配额计数**（网关切点） | **进程内**原子计数（`AtomicLong` / Caffeine）+ 本地预聚合（按用户/时间窗口）；PG 原子 `UPDATE ... WHERE used < limit` 兜底；仅在**多实例**部署时可选引入 Redis | 计数不可用时 **fail-closed**（拒调用）或 fail-open（放行并记账）——策略可配，默认 fail-closed |

### 3.3 机制清单（Java / WebFlux 语境）

| 机制 | 用法 |
|---|---|
| Reactive Streams `request(n)` | 背压原语：消费者按需拉取，生产者不超发 |
| `limitRate(n)` / `onBackpressureBuffer(limit, onOverflow, ...)` | 控制批大小与缓冲上界 |
| 有界队列 + 水位（low/high watermark） | 明确「何时开始拒/何时恢复」 |
| 令牌桶 / 漏桶限流 | 按席位档（受限席更严）与按用户维度限流 |
| `429 + Retry-After` | 标准背压反馈，配合客户端**指数退避** |
| Resilience4j：RateLimiter / Bulkhead / CircuitBreaker | 舱壁隔离与熔断，防单租户/单端点拖垮全局 |
| Java 21 虚拟线程 + `Semaphore` | 阻塞式调用（JDBC / OIDC / LDAP）的**并发上限即背压** |
| 连接池上限（R2DBC / Reactor Netty） | 池满即排队，天然反压到上游 |
| **PG 持久队列**（`SELECT ... FOR UPDATE SKIP LOCKED`） | 计量削峰：入库消费端按能力取批，生产端快则表内堆积（有 table-level 上限与监控） |
| 信号量 / 舱壁（`Semaphore` + Resilience4j Bulkhead） | 单体下**同进程资源隔离**：telemetry 洪峰不得挤占网关与管理面 |
| gRPC `FlowControl` | **单体内部不需要**；若未来走 RSocket 客户端传输，可用协议级流控窗口 |

### 3.4 端到端流控链路

```
客户端埋点 buffer
   │  (credit 拉取 / 4096 条上限)
   ▼
[服务端 ingest 入口] ──限流(令牌桶)──► [进程内有界队列 + 水位] ──背压(429/Retry-After)──► 客户端退避
                                          │
                                          ▼
                              [PG 持久队列表] ──SKIP LOCKED 批量取──► [聚合 upsert PG]
                              （进程内削峰；Kafka 仅超大规模可选）
```

模型网关链路：

```
客户端 ◄──request(n)── 网关 ◄──request(n)── 上游/内网集群
        (慢客户端只影响本连接，不拖垮进程)
```

### 3.5 阈值与参数（可配，示意）

| 参数 | 默认（示意） | 说明 |
|---|---|---|
| ingest 并发上限 | 每租户 32 | 舱壁隔离，防单客户打满 |
| ingest 有界队列 | 10k 条 / 32 MB | 超限即 429 |
| WS 每连接出站缓冲 | 256 条 | 超限合并丢弃旧值 |
| WS 推送合并窗口 | 500 ms | 能力集变更合并 |
| 客户端上报 credit | 512 条 / 次 | 拉式上报批大小 |
| 配额计数窗口 | 日 / 分钟双窗 | 日配额 + 每分钟速率 |
| 限流（受限席位） | 标准席位的 1/5 | 按席位档缩放 |
| 熔断阈值 | 错误率 50% / 10s | 打开后快速失败 |

---

## 4. 服务端 API 面（五个面 = 同一进程内的五个模块）

> **这五个「面」是同一个模块化单体进程内的五个 Spring Modulith 模块（各自包边界与 API 契约），不是五个可独立部署的服务。** 模块之间只通过 Spring Modulith 允许的**具名接口 / 领域事件**协作，禁止直接跨模块访问内部类型（由 `modulith-verification` + ArchUnit 守护）。

| 面 | 模块（限界上下文） | 挂载路由前缀 |
|---|---|---|
| ① | `admin`（管理台，静态 SPA 由同进程托管） | `/admin/*` |
| ② | `identity` + `seat` + `catalog`（客户端面） | `/auth/*`、`/entitlement`、`/catalog/*`、`/telemetry/*`、`/usage/*` |
| ③ | `gateway`（模型网关，同进程 WebFlux 流式代理） | `/v1/*` |
| ④ | `control`（控制通道 WS 推送） | `WS /control` |
| ⑤ | `integration`（集成 API，服务账号） | `/oauth/token`、`/v1/*`（服务标签）、`/knowledge/*` |

### 4.1 面 ① 管理台 REST（仅管理员席位）

| 端点 | 方法 | 作用 |
|---|---|---|
| `/admin/seats` | GET/POST | 席位列表 / 发放 |
| `/admin/seats/{id}` | PATCH/DELETE | 变更档位/角色 / 回收 |
| `/admin/seats/{id}/transfer` | POST | 席位转移（回收后复用） |
| `/admin/quota` | GET/PUT | 配额策略 |
| `/admin/policy` | GET/PUT | 企业策略（外网出口/导出/技能强制） |
| `/admin/license` | GET/POST | License 查看 / 续期导入 |
| `/admin/reports/usage` | GET | 用量报表（用户/团队/模型/席位下钻） |
| `/admin/audit` | GET | 审计查询与导出 |

### 4.2 面 ② 客户端 API

| 端点 | 方法 | 作用 |
|---|---|---|
| `/auth/oidc/callback` | GET | IdP 回调换取企业会话 |
| `/auth/device/enroll` | POST | 设备入网（指纹 + device.limit 校验） |
| `/auth/token/refresh` | POST | 刷新短期令牌 |
| `/entitlement` | GET | 拉取能力集（含 `revision`） |
| `/catalog/models` · `/catalog/skills` · `/catalog/knowledge` | GET | 清单下发 |
| `/telemetry/credit` | GET | **申请上报 credit**（背压入口） |
| `/telemetry/batch` | POST | **批量上报**（幂等 `eid` upsert；可 429 背压） |
| `/usage/me` | GET | 本人用量（标准/受限） |

### 4.3 面 ③ 模型网关（OpenAI 兼容）

| 端点 | 方法 | 作用 |
|---|---|---|
| `/v1/models` | GET | 按席位可见范围返回模型清单 |
| `/v1/chat/completions` | POST | **流式/非流式**代理；虚拟密钥鉴权；**同步计量 + 硬配额**；`request(n)` 背压转发 |
| `/v1/embeddings` | POST | 向量（若接自建 RAG） |

> 网关是**路径 A 的权威计量点**：调用完成即写计量，配额超限直接 `429`（见总览 §6.1）。

### 4.4 面 ④ 控制通道 WS 推送

| 通道 | 作用 |
|---|---|
| `WS /control` | 推送 `entitlement_changed` / `session_revoked` / `models_updated` / `skills_updated` / `license_notice` / `quota_notice` |

- 复用客户端侧 `remote.ts` 的 token / 撤销 / 踢线模式，**服务端为其收端**。
- 推送**有界 + 合并**（§3.2 B3）：能力集类消息幂等，旧值可丢。

### 4.5 面 ⑤ 集成 API（服务账号）

| 端点 | 方法 | 作用 |
|---|---|---|
| `/oauth/token` | POST | Client Credentials 换 token |
| `/v1/chat/completions` 等 | POST | 与面 ③ 同入口，按服务标签计量与限流 |
| `/knowledge/query` | POST | 服务级知识检索 |

---

## 5. 服务端数据模型

```sql
-- 组织与人员
org            (id, name, edition, created_at)
team           (id, org_id, parent_id, name)
user           (id, org_id, external_id, idp_subject, status)
-- 席位与授权
seat           (id, org_id, user_id, tier /*admin|standard|restricted|api*/, role_id,
                state /*active|frozen|revoked|transferred*/, issued_at, revoked_at)
entitlement    (id, seat_id, revision, capability_json, quota_json, updated_at)
license        (id, org_id, edition, seat_limits_json, expiry, signature, imported_at)
-- 设备与凭证
device         (id, seat_id, fingerprint, enrolled_at, last_seen, state)
credential     (id, owner_id /*user|service*/, kind, secret_ref, rotated_at, revoked)
-- 清单
skill          (id, scope /*enterprise|team*/, team_id, version, signature, acl_json, enabled_forced)
knowledge      (id, scope, team_id, kind /*mcp|rag*/, endpoint, acl_json)
provider       (id, org_id, base_url, api, allow_models_json)   -- 上游 / 内网集群
-- 计量与审计
telemetry      (eid PRIMARY KEY, ts, kind, org_id, user_id, team_id, seat_tier,
                session_id, model, input, output, cache_read, cache_write, tokens,
                cost, result, latency_ms, src /*gateway|client|server*/)
audit          (id, ts, org_id, actor, action, target, meta_json)
-- 配额计数（热点，走 Redis，PG 仅留对账快照）
quota_counter  (date, scope /*user|team|org*/, ref_id, dimension, used, limit)
```

- **`telemetry.eid` 唯一**：幂等 upsert，天然去重（客户端重试 / 补报安全）。
- **分区**：`telemetry` 按月分区 + `(org_id, ts)` / `(user_id, ts)` 索引，支撑按用户下钻。
- **配额计数**：以 Redis 原子计数为准，PG 存窗口快照便于对账与报表。
- **与客户端一致性**：客户端 `enterprise_telemetry` 表字段是本表子集（见总览 §8.3）。

---

## 6. 关键流程

### 6.1 IdP 登录与会话换发

```
客户端 → 服务端 /auth/oidc/callback （IdP 授权码）
      → 服务端校验 IdP 断言、解析 subject/组
      → 匹配 user + seat（无席位 → 拒绝或分配默认受限席位）
      → 设备入网校验（device.limit）
      → 签发 access（短）+ refresh（可刷新，存客户端钥匙串）
      → 返回 entitlement（含 revision）
```

### 6.2 席位变更 → 能力集版本化推送

```
管理台改席位/配额/策略
  → entitlement.revision += 1
  → WS /control 推送 enterprise_entitlement_changed（有界 + 合并）
  → 客户端热更新能力集；断连客户端下次拉取时对账（revision 比较）
```

### 6.3 telemetry 上报（幂等 + 背压）

```
客户端 GET /telemetry/credit   → 服务端按水位下发 credit（或 429 + Retry-After）
客户端 POST /telemetry/batch   → 服务端限流 → 有界队列 → Kafka → 聚合写 PG（按 eid upsert）
服务端 429                    → 客户端指数退避，本地缓冲继续累积（不丢、不静默）
```

### 6.4 License 席位校验（在线 + 离线）

- **在线**：每次发放席位前校验 `已用席位 + 1 ≤ license.seat_limits[tier]` 且未过期；超发拒发。
- **离线（空气隔离）**：`license` 为服务端签名凭证（本服务端即校验方，信任根随离线包提供）；导入 `.lic` 即续期。
- 客户端**不校验** License（避免多端密钥扩散）。

### 6.5 模型调用（鉴权 → 配额 → 路由 → 流式计量 → 审计）

```
1) 虚拟密钥鉴权 → 解析 user/seat/service
2) Redis 原子预扣配额（日窗 + 分钟窗）；超限 429
3) 路由：路径 A 上游 provider / 路径 B 内网集群
4) 流式转发（request(n) 背压，见 §3.2 B2）
5) 完成计数：input/output/cache tokens → telemetry（src = gateway）
6) 审计：调用级事件（可选抽样）
```

---

## 7. 与客户端契约的映射

| 客户端命令（总览 §8.1） | 服务端端点 |
|---|---|
| `enterprise_login` / `enterprise_logout` | 面 ② `/auth/oidc/callback`、`/auth/token/refresh` |
| `enterprise_session` / `enterprise_refresh` | 面 ② `/entitlement` |
| `enterprise_enroll_device` | 面 ② `/auth/device/enroll` |
| `enterprise_models` / `enterprise_skills` / `enterprise_knowledge` | 面 ② `/catalog/*` |
| `enterprise_telemetry_emit` | 面 ② `/telemetry/credit` + `/telemetry/batch` |
| `enterprise_usage` / `enterprise_usage_flush` | 面 ② `/usage/me`（+ flush 即 batch 上报） |
| （客户端 WS 收端） | 面 ④ `WS /control` |
| —（管理台独占） | 面 ① `/admin/*` |
| —（服务账号独占） | 面 ⑤ `/oauth/token` 等 |

> 客户端事件 `enterprise_*`（总览 §8.2）由面 ④ 推送触发。

---

## 8. 部署与非功能

### 8.1 部署形态与伸缩

| 组件 | 伸缩 | 备注 |
|---|---|---|
| API（面 ①②③⑤） | 无状态，水平扩 | 会话用 JWT，不依赖本地状态 |
| 控制通道（面 ④ WS） | 有状态，需**共享状态**（Redis pub/sub 或 Sticky + 路由） | 席位变更须触达所有实例 |
| 网关流式 | 无状态 | 背压随连接，不跨实例 |
| 计量消费者 | 消费者组水平扩 | Kafka 分区按 `org_id` |

### 8.2 可观测性

- 指标：ingest 队列水位、429 比例、WS 连接数与积压、网关 P99 延迟、配额拒率。
- 日志 / 追踪：OpenTelemetry，trace 贯穿「客户端上报 → ingest → 聚合」与「网关 → 上游」。
- 计量自监控：**上报成功率与 lossy 计数**本身作为指标，防止静默丢数。

### 8.3 安全

- 传输：mTLS（客户端 ↔ 服务端内网）或 TLS + 令牌；管理员双因子。
- 密钥：虚拟密钥/服务账号密钥只存 `secret_ref`（HashiCorp Vault / KMS），不落明文。
- 租户隔离：所有表 `org_id` 过滤；行级安全（RLS）可选。
- 审计留存：等保要求独立留存策略（可长于计量，见总览 §6.7）。
- 国密：SM2/SM3/SM4 可选套件（密评路径，与总览 §7.3 对齐）。

### 8.4 性能目标（示意，待压测确认）

| 指标 | 目标 |
|---|---|
| 网关非流式 P99 | < 200 ms（不含上游推理） |
| 网关首字延迟（流式） | 与上游差值 < 50 ms |
| telemetry ingest 吞吐 | ≥ 20k 事件/秒（单实例，批量） |
| ingest 429 比例（稳态） | < 0.1% |
| WS 推送延迟 | P99 < 1 s |
| 席位变更生效 | < 2 s（在线端） |

---

## 9. 分期映射（服务端视角）

| 期 | 服务端交付 | 与总览对齐 |
|---|---|---|
| **S0**（对应 P0） | 身份（面 ②）+ 席位/授权 + License 骨架 + **telemetry ingest（背压）** + 审计骨架 | 总览 P0 |
| **S1**（对应 P1） | **模型网关（面 ③，含同步计量 + 硬配额 + 流式背压）** + 报表（面 ①） | 总览 P1 |
| **S2**（对应 P2） | 技能注册中心（面 ① + `/catalog/skills`）+ 签名校验 + 强制启停下发 | 总览 P2 |
| **S3**（对应 P3） | MCP 代理 + 查询时 ACL（面 ②）+（可选）RAG | 总览 P3 |
| **S4**（对应 P4） | 离线 License、Helm/Compose、信创/国密套件、管理台 | 总览 P4 |

> **服务端先行**：S0 + S1 是客户端全部 `enterprise_*` 契约的来源，应最先落地并冻结契约版本。

---

## 10. 风险与开放问题

### 10.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 响应式编程门槛 | 团队学习成本、误用阻塞调用 | 阻塞调用统一走虚拟线程 + 信号量舱壁；代码评审强制 |
| WS 有状态与水平扩冲突 | 推送漏达 | Redis pub/sub 广播 + 客户端 revision 对账兜底 |
| 背压策略选错（fail-open vs fail-closed） | 成本失控 / 可用性下降 | 策略可配；配额默认 fail-closed，计数类可 fail-open |
| 计量洪峰集中于断连恢复 | ingest 打满 | credit 拉式 + 429 退避 + Kafka 削峰 |
| 单租户内多团队数据隔离 | 越权风险 | 全表 org_id + RLS；查询强制带 scope |
| Java 服务端与 Bun/TS 客户端技术栈割裂 | 契约漂移 | 以 OpenAPI/proto 冻结契约，双端生成校验 |

### 10.2 开放问题（待确认）

1. 网关上游协议：只做 OpenAI 兼容，还是兼容 Anthropic 等多家？
2. telemetry 上报走 HTTP 批量，还是走控制通道 WS 复用连接？（影响背压实现位置）
3. Kafka 是否必装（小客户内网成本）？还是先用库内队列 + 单机 PG？
4. 配额计数 fail-open / fail-closed 的默认策略由谁定（客户可配？）。
5. WS 控制通道是否与现有客户端 `remote.ts` 网关复用同一端口与鉴权模型？
6. 管理台与 API 是否分进程（隔离管理面）？
7. 国密套件是可选插件还是基线（影响密钥与 TLS 实现）。
8. 是否引入 gRPC（内部服务间）以利用其流控窗口。

---

## 附录 · 与总览文档的交叉引用

| 本篇 | 总览 |
|---|---|
| §1 定位 | `EKOVA-DESIGN.md` §1 概述、§3 总体架构 |
| §4 面 ②③④ | 总览 §5 能力域、§8 落点 |
| §5 数据模型 | 总览 §8.3 新增表 |
| §6.3 telemetry | 总览 §6 计量与埋点体系 |
| §8.3 安全 / 国密 | 总览 §7.3 合规 |
| §9 分期 | 总览 §9 分期路线 |

- 源文件：`docs/enterprise/EKOVA-SERVER-DESIGN.md`
- 阅读版：`docs/enterprise/EKOVA-SERVER-DESIGN.html`
- 状态：设计稿，未实现，不含代码改动
