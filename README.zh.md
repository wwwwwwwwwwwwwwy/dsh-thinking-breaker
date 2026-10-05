# dsh-thinking-breaker

DSH 宿主插件：**两个熔断**，一个文件。

- **A. 思考循环熔断** —— 推理流里出现连续 ≥10 次重复时，立刻中止本次请求，并被**强制以"不思考"的方式重新做一次**（重新思考）；重试用尽则让该轮正常终止。
- **B. 工具失败熔断** —— 同一个工具调用在**同一轮内**反复以同类错误失败时，先注入"换做法"的明确指令；再犯就直接**在派发前拒绝**这次相同调用，逼模型换路径（重新一轮处理）。

两者都合并进同一个插件，不再是两个 skill。

## 为什么技能层做不到这件事

技能（`~/.dsh/skills/`）是模型**主动加载**的说明文档。模型已经陷进思考循环时，它读不到技能；而"思考中"没有任何机制能打断它。所以真正的中断必须发生在宿主层——也就是这个插件。技能只负责说明与调参。

## 四个钩子（全部对着实测契约写）

| 钩子 | 作用 |
|---|---|
| `llm/stream`（prepend） | 逐块读 `reasoning-delta` 喂给纯检测器。命中即**静默排空**后续 chunk（让 provider 流干净关闭），然后产出**终态 `finish` chunk**（`kind: 'aborted'`）。 |
| `agent/request-error`（prepend） | 只回收**本插件自己**的循环中止：返回 `{ kind: 'retry' }`，在本轮重试预算内让这一步重做一次。其他失败一律 `next()` 交回宿主。 |
| `agent/request`（prepend） | 记录会话本轮；熔断后把这次重试请求强制成 `reasoningEffort: 'off'` —— **重做时直接作答，不再推理**，这才是真正打断循环的点。 |
| `tools/post-execute`（prepend） | ① 在熔断后的**下一个工具结果**上投递"不要沿那条线继续"的指引；② 工具反复失败时注入换做法指令。 |
| `tools/pre-execute`（prepend） | 参数未变的相同失败调用达到阈值后，**在派发前直接拒绝**。 |

### 三个"为什么这样写"（都是查证结论，不是偏好）

1. **不能从监听器抛出，也不能干净结束流。** dsh-llm 注册了一个 prepend 的 `llm/stream` 校验器：流结束没收到终态 finish chunk 就报 `LLM stream ended without a terminal finish chunk`。而监听器抛错属于 middleware/consumer 失败——文档原话是「remain thrown，直接关闭这一轮」，**不进 `agent/request-error`**。所以必须产出一个合法终态 chunk，才能被第 2 个钩子接管。

2. **终态用 `aborted` 而不是 `error`。** 可重试集合是 `EMPTY_RESPONSE | RATE_LIMIT | SERVER | TIMEOUT | TRANSPORT`，**`ABORTED` 不在其中**。所以默认行为是终态（安全），而重试是**我们在 `agent/request-error` 里显式接管**的——只放行一次，用完即回落到终态。这样既满足"立刻中止"，又不会变成无限重试。

3. **工具门禁的签名只看"工具 + 归一化参数"。** 派发前还没有结果，签名里若掺入错误文本，永远匹配不上 post-execute 记录的东西。所以引导用"参数 + 错误码 + 归一化错误文本"，而**门禁只用"工具 + 参数"**。参数里的数字/十六进制会被折叠，因此"只改了个行号/路径片段"的盲重试同样会被拦下；而结构性换了做法的调用会得到全新签名，正常放行。

## 你说的两条需求，逐条对应

| 你的要求 | 实际实现 | 诚实说明 |
|---|---|---|
| 连续 10 次以上重复 → 立刻停止本轮思考 | `noveltyStreak: 10`（10 个连续块 × 128 码元 = 1280 码元确认重复），`llm/stream` 立即中止 | 检测有最小延迟：必须读完一个完整重复块才可见 |
| → 并且重新思考 | `agent/request-error` 强制重试一次 + `agent/request` 把该次重试设为 `reasoningEffort: 'off'` | **不能回退上下文**（插件无法编辑消息）。"重新思考"= 同一步、干净地重做一次，且不再走推理路径 |
| → 防止它回到同一条线 | 熔断后的**下一个工具结果**上注入明确指引：那段推理已被判定为原地打转，不要继续、不要复述 | 这是"防止污染"在架构上唯一可行的一层：历史改不了，只能让它别回到那条线。成功或失败的结果都会投递（否则常常没机会投递） |
| 工具调用问题（如字符串处理）→ 停止处理 | **一轮内**失败总数达 2 次即注入换做法指令；达 3 次起相同参数调用在派发前被 `deny` | 按**一轮的失败总数**计数，而不是按失败类型——否则模型换着花样犯错时永远拿不到指令（这是我实测抓到的 bug） |
| → 并且重新一轮处理 | 门禁阻断后模型必须换路径（否则拿到的只有拒绝理由） | **没有"清空重来"的原语**。要真正的"全新一轮"，用 `maxLoopRetriesPerTurn: 0` 让中止变终态，把新开始交给你的下一次输入 |

## 阈值：量出来的，不是拍的

`tools/calibrate.mjs` 在 6 种循环形态 × 3 种干净语料上扫描。`blockChars` 在 96/128/192/256 里**只有 128** 让所有形态都留足余量。

`noveltyStreak: 10` + `noveltyOverlap: 0.7` 实测：

| 语料 | 结果 |
|---|---|
| 逐字复读（英/中）、近似复读（带计数/从句）、乒乓复读 | 在第 **12–18** 块触发 `low-novelty` |
| 干净：无重复散文 / 变体英文推理 / 变体中文推理 | **不触发** |

余量约 2.8 倍。要更早触发就把 `noveltyStreak` 降到 6–8；调完务必重跑标定与测试。

### 触发延迟实测（这决定了每次熔断浪费多少）

在 `noveltyStreak: 10` 下逐个量过"从开始循环到被中止，烧掉多少码元"：

| 循环形态 | 触发前烧掉 |
|---|---|
| 极短块硬循环（如"让我再想想。"） | **533 码元**（走 `exact-repeat`） |
| 乒乓式两块复读 | 1 681 码元 |
| 中文段落逐字复读（~35 字单元） | 1 681 码元 |
| 英文段落逐字复读（~137 字单元） | 1 927 码元 |
| 近似复读（段落 + 递增计数） | 2 952 码元 |
| 中文段落 + 递增计数 | 6 027 码元 |

也就是**每次熔断大约浪费几百到三千个 token 量级**，取决于循环单元的长度：复读单元越长，需要越长的确认窗口。想更省就降 `noveltyStreak`，代价是误触发概率上升。

## 完整配置

```yaml
- id: dsh-thinking-breaker
  name: dsh-thinking-breaker
  config:
    enabled: true

    # A. 思考循环
    maxReasoningChars: 120000      # 单次响应推理字符硬上限（0 = 不设）
    retryWithoutThinking: true     # 熔断后带 off 重试一次（即"重新思考"）
    maxLoopRetriesPerTurn: 1       # 每轮允许的重试次数；0 = 中止即终态
    postTripHint: true             # 熔断后在下一个工具结果上投递"别回到那条线"的指引
    maxTokens: 0                   # 硬输出上限，0 = 不动；只在比现有值小时下调
    skipAuxCalls: true             # 跳过标题生成等辅助调用

    # B. 工具失败
    toolFailureGuard: true
    toolFailureSteerAfter: 2       # 一轮内失败达 N 次起注入换做法指令
    toolFailureDenyAfter: 3        # 同一调用失败达 N 次起拒绝派发
    toolFailureHistory: 64         # 每轮最多记住多少条失败
    toolFailureSignatures: text    # text = 参数+错误码+归一化错误文本；code = 只到错误码

    # 检测器
    blockChars: 128
    historyBlocks: 32
    minRepeatGap: 3
    noveltyOverlap: 0.7
    noveltyStreak: 10
```

**设置表单**：`link:` 安装方式下拿不到。pnpm 的 `link:` **不会为插件安装它自己的依赖**，所以插件目录没有 `node_modules`，解析不到 `@deepseek-ai/schemastery`，模块就不导出 `Config`——条目按"无 schema"激活，**所有配置照常生效**，只是没有宿主校验和设置表单。

**绝不能拿假 schema 顶替**：cordis 会自己对条目调 `schema.validate`，给一个没有该方法的替身会让宿主崩溃（实测：`TypeError: Cannot read properties of undefined (reading 'validate')`）。要设置表单就得让插件能解析到真实 schemastery（用 `file:` 打包安装而非 `link:`）。`tools/verify-cordis-contract.mjs` 钉死了这条约束。

## 中断与回滚

- **关 A 只留 B**：`retryWithoutThinking: false`（熔断仍中止，但不重做）。
- **关 B 只留 A**：`toolFailureGuard: false`。
- **全关**：`enabled: false`。
- **回滚**：从 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`）移除 `dsh-thinking-breaker`，跑 `pnpm install`，重启。也可把该行改成 `disabled: true`。
- 插件不写文件、不发网络请求、不改历史。

## 已知局限（不粉饰）

- **不能回退上下文。** 这是本方案最本质的局限：因循环而膨胀的推理块留在上下文里，所以"重新思考"是"同一步干净重做"，不是"历史清空重来"。
- **没有轮数预算。** DSH 原生无 `maxSteps`/`maxTurns`（全 app.asar 零命中）。跨步的循环（反复失败但每次参数都不同）需要别的手段。
- **循环单元短于一块且总被变化内容拖着走时抓不到。** 实测 6 字短句后紧贴递增数字时重叠率仅 0.22。
- **语义绕圈抓不到**（意思全新、字面不同）——检测基于字符重复。
- **工具失败判定依赖 `result.isError`。** 工具主动把"失败"标成成功时不会进入本熔断（有意为之：那是工具的语义，不该由插件改写）。
- **每次熔断仍有成本**：至少几百到上千 token 才会被判定。

## 测试

```bash
node --test test/detector.test.mjs test/plugin.test.mjs   # 59 个测试
node tools/verify-cordis-contract.mjs                     # 宿主契约回归
node tools/calibrate.mjs                                  # 重新标定阈值
```

## 上线前 bug 排查记录（找到并修掉的真问题）

这些不是"顺手改改"，每一个都有对应的回归测试：

1. **引导阈值按签名计，等于永不触发。** 失败计数原本按"失败类型"分开累积，所以模型每次换个错误文本时永远停在 1 次，而 1 < 阈值 → **恰恰在最需要引导的"换着花样犯错"场景下，从来不触发**。改成按**一轮内失败总数**驱动引导；按签名的计数只留给派发门禁。
2. **`deny` 只有标记、没有清计数，导致"修好了"不生效。** 原先成功时只清 `toolDenied`，但 `toolCalls` 的计数仍在阈值之上 → 门禁立刻再次拒绝。现在成功会把这个调用的**标记与计数一并归零**。
3. **`stableJson` 遇到 BigInt 会抛。** `JSON.stringify(1n)` 抛 `TypeError`，而这个函数就跑在 `pre-execute` 门禁里——抛了会连累它本该保护的派发。现在序列化失败降级为占位符，永不抛。
4. **死状态 `tripTurn`。** 三处写入、零处读取，且顶部注释还在描述一个已不存在的机制。已删除并改正注释（保留死状态是未来 bug 的温床）。
5. **非拉丁字符的指纹退化。** 原本用 `charCodeAt(i) & 0xffffffff` 折叠，低代理项会与 BMP 码位混同；中文/emoji 思考文本下可能削弱检测。改为按**码点**折叠，并加了"块边界切开代理对"的专门测试。
6. **非 `accept` 决策下不得吞掉指引。** 若下游把结果拦成非 `accept`，指引必须保持待投递而不是丢失——有测试钉住。
