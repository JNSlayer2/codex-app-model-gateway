---
name: codex-app-model-gateway
description: Use when implementing, diagnosing, or handing off Codex App external model gateway v4. Enforces one provider, GPT subscription passthrough, Claude request-scoped tool bridge, sanitized handoff, and rollback-safe verification.
metadata:
  short-description: Codex App model gateway v4 workflow
---

# Codex App Model Gateway v4

> **免責聲明 / Disclaimer**：本工具讓你在自己付費的 Codex App 內把模型切到 Claude / Grok，並讓 GPT 透過你**自己的** ChatGPT 訂閱 session 繼續運作。它只代理「你自己已登入」的 session，不分發、不竊取任何憑證。但「以本機 proxy 轉發 ChatGPT 訂閱 session」可能牴觸 OpenAI ChatGPT 訂閱條款（訂閱條款對自動化／代理／非官方介面通常比 API 條款更嚴）；Claude CLI / Grok CLI 的包裝亦各受其供應商條款約束。**是否使用、是否合規由你自負**，請先自行確認 OpenAI / Anthropic / xAI 當前條款。本 repo 是 public-safe reference；實際帳號、憑證、tunnel 與本機 state 必須留在使用者自己的機器。工具按「現狀（as-is）」提供，無任何擔保。

目標是讓 Codex App 只使用一個穩定 provider：`model_gateway`。同一條 thread 內只切換 `model`，不切換 provider。GPT 走 Codex ChatGPT subscription passthrough；`chatgpt-pro-consult` 是 **GPT-5.5 Codex fast consult / Pro-account fast consult** route（只把上游 model 改寫成 `gpt-5.5`，保留同 thread / headers / tools），**不可宣稱等同 ChatGPT App Deep Research**；Claude `opus-4-7`、`opus-4-8`、`sonnet-4-6`、`haiku-4-6`、`fable-5` 走 Claude CLI adapter，display name 用 `opus4.7`、`opus4.8`、`sonnet4.6`、`haiku4.6`、`fable5`；所有工具能力都由 Codex App request-scoped tool bridge 掌握。

**穩定交付的 UI 定義**：不只 gateway health、catalog 與 live smoke 要綠，Codex App 左側專案列表也不能因 provider split 顯示「沒有聊天」。若全域 `model_provider` 已切到 `model_gateway`，未封存 `openai` threads 必須經一次性備份後合併到 `model_gateway`，否則 App 可能只顯示 gateway threads，讓舊專案看似消失。

## 一鍵部署 / 維修（每台機器先跑這個）

> **給 AI 安裝代理（照這個跑）**：依序執行下面三步，以 exit code 判成敗（`0`=成功）。
> 1. `bash scripts/install-codex-gateway.sh --preflight` — 只讀，列出本機缺的 CLI / 登入 / `CODEX_HOME` 雷。
> 2. `bash scripts/install-codex-gateway.sh` — 實際安裝（自動偵測 repo 內 `runtime/` → 寫 plist+config → 合併未封存 thread provider → 載入 → 驗收）。
> 3. `bash scripts/post-update-check.sh` — 驗收，**必須 exit 0** 才算成功。
>
> **你（AI）不能代做的只有登入**：若 preflight 顯示需要 `codex login` 或 `grok login --oauth`，停下來請人類在終端機自己跑（互動式 OAuth），完成後再回到第 2/3 步。其餘全自動、idempotent、會備份、不碰 signed app bundle。

新機器拿到本 repo/skill 後，**先跑安裝器**——它會自動找到 repo 內 `runtime/`，偵測本機 `node`/`claude`/`grok`/`codex` 的絕對路徑寫進 launchd plist，避開最常見的部署失敗（`spawn ENOENT`：launchd 的 PATH 沒有該 CLI 的安裝目錄，例如 grok 在 `~/.grok/bin`）。安裝器 idempotent、會先備份、不碰 signed app bundle。

前提：gateway runtime（`runtime/server.js` + `package.json` + `test/`）已隨 public repo 附上；fresh clone 後在 repo root 直接跑安裝器即可，不需設定 `MODEL_GATEWAY_DIR`。只有把 runtime 放在 repo 外時才用 `MODEL_GATEWAY_DIR=<dir>` 覆寫。按量 API 的 fresh install 預設不 allowlist；即使有 Minimax key，`minimax-m3` 也會 fail-closed，除非人類確認是近吃到飽方案後用 `GATEWAY_API_MODEL_ALLOWLIST=minimax-near-unlimited-api` 重跑安裝。維修舊安裝時，安裝器會保留現有 launchd plist 的 allowlist，避免無意關掉已確認的本機低風險 route。

```bash
# 0) dry-run：只讀，列出本機缺什麼（CLI、登入、CODEX_HOME 雷）
bash scripts/install-codex-gateway.sh --preflight

# 1) 安裝／修復：偵測路徑 → 寫 plist + 單一 provider config → 載入 → 驗收（API fan-out 預設關閉）
bash scripts/install-codex-gateway.sh

# 2) 補手動登入（preflight 會列出本機缺哪個；這兩步無法自動代登）
codex login            # GPT passthrough 需要
grok login --oauth     # grok-build 需要（選用）

# 3) 驗收：不花 quota；--full 跑同 thread 真實切換（花 Claude quota）
bash scripts/post-update-check.sh
bash scripts/post-update-check.sh --full
```

> **Codex App 更新後切換失效就用這個修**：先跑步驟 3 定位，再視需要重跑步驟 1。gateway 是 launchd 獨立進程，**App 更新殺不掉它**；更新最常壞的是 config provider 被重設或 CLI 路徑變動，安裝器都會自動處理。腳本相容 macOS 內建 bash 3.2（不依賴 bash 4 的關聯陣列），快速驗收只依賴 `node`/`curl`/macOS 內建工具，不要求使用者另外裝 `jq` 或 `ripgrep`。

## v4：Fable5 route

- Public catalog slug: `fable-5`; display name: `fable5`; Claude CLI candidate order: `claude-fable-5`, `fable-5`, `fable`.
- Treat `fable-5` as a premium Claude-family route, not a new Codex provider. It must use the same request-scoped tool bridge and the same fail-closed backend-notice behavior as Opus/Sonnet/Haiku.
- Default advertised context is `200000` unless the runtime has verified a larger Fable variant; do not over-advertise context from branding or hearsay.
- `fable5` is a compatibility alias only. The catalog slug remains `fable-5` so threads switch model within the single `model_gateway` provider.

## v4：模型主導權與執行宿主契約

每個 catalog entry 與 `/healthz.routes` 必須把「誰在思考／寫 patch」和「誰在執行工具」分開標示：

- `author_model`：實際產生方案、代碼、patch intent 或 reviewer judgment 的模型，例如 `opus-4-8`、`grok-build`、`minimax-m3`、`gpt-5.5`。
- `decision_model`：該 artifact 的決策來源；預設等於 `author_model`。若日後有 committee / judge 才能不同。
- `executor_host`：真正跑 shell、apply_patch、MCP、browser、computer-use 的宿主，例如 `codex-app`。這不是作者。
- `authority_mode`：
  - `brain_only`：只可回建議／批評／研究。
  - `patch_proposal`：可輸出 unified diff / patch intent，由主控審核套用。
  - `tool_intent_bridge`：可輸出工具意圖，Codex App 依當次 request tool schema 執行。
  - `sandbox_executor`：只限隔離 worktree / allowlisted command。
  - `native_peer_executor`：未來原生 peer runtime 才能用；本 gateway 不預設宣稱。
- `patch_proposal`：是否可產生 patch proposal / tool intent。Claude/Grok/Minimax 預設可產生，但不代表它們直接寫入工作區。
- `tool_execution`：外部模型 route 應為 `codex_app_request_scoped_prompt_bridge`；GPT passthrough 應為 `codex_native_passthrough`。

重要語義：切到 Opus/Grok/Minimax/Fable 時，`author_model` 必須是該模型；Codex App 只是 `executor_host`。Codex 可以拒絕、驗證、套用或回滾外部模型的 patch/tool intent，但不得把 artifact 改標成 GPT 寫的，也不得把外部模型降格成「只能聊天」。

## v4：ChatGPT Pro / Codex MCP RPO bridge

`RPO` 在本 skill 中指 **Research / Plan / Operate**。v4 要同時支援兩條互補路線，避免 ChatGPT Pro、Codex App 與外部 reviewer 之間出現資訊斷層：

1. **GPT-5.5 Codex fast consult / Pro-account fast consult（Codex → ChatGPT subscription，日常主線）**
   - Catalog slug：`chatgpt-pro-consult`；display name：`ChatGPT Pro Consult`；compat alias：`chatgpt-pro`。
   - 這不是新 provider、不是 ChatGPT Web 自動化，也不是 API key route；gateway 只把 request body 的 `model` 改成上游 `gpt-5.5`，其餘 Codex session headers、thread/tool context、MCP tool results 原封 passthrough。
   - 用途是 Codex 主控下的 bounded consultant / critique / plan / risk lane；`pro_research_equivalence=false`，不得宣稱等同 ChatGPT App Deep Research。
   - App 起手式：普通實作、測試、修 bug 預設留在 Codex executor；需要研究級規劃、架構裁決、claim/evidence/rebuttal 或高風險決策時切到 `ChatGPT Pro Consult`；方案定案後切回 executor 落地。
2. **Codex-native GPT route（Codex → ChatGPT Pro subscription）**
   - `gpt-*` / official OpenAI-family text slugs 仍走 Codex App 的 ChatGPT subscription passthrough。
   - `requires_openai_auth = true` 必須保留，讓 Codex App 自己帶 session；這不是 OpenAI API key，也不是把 ChatGPT token 交給外部模型。
   - 同一條 Codex thread 只切 `model`，不切 provider；這是工具狀態、MCP tool results、plan/goal mode 與 auto-compaction 不斷層的主路線。
3. **ChatGPT Pro frontdoor（ChatGPT Pro → Codex MCP Hub）**
   - ChatGPT Pro connector 先讀 `collab_guide`。
   - read/fetch-only 表面用 `codex_handoff_draft` 產生不改 DB 的 handoff packet。
   - full MCP 表面用 `codex_handoff_create` 建立精簡 handoff；public connector 僅允許 safe / dry-run lane，real `codex` lane 必須在 localhost 端取回 `collab_pack_get(plan_id)` 後由 Codex 確認。
   - `collab_pack_get(plan_id)` 是跨模型 continuity source of truth：後續 Pro / Codex / reviewer 都以它恢復共享狀態，而不是靠重貼完整聊天。
4. **Pro Research lane（人工訂閱研究 lane）**
   - Codex / open-ultrawork 產生 `ProResearchJobV1` packet；`sync_responses_model=false`。
   - 使用者在 ChatGPT Pro / Deep Research 手動執行，回傳 Markdown/PDF/source links。
   - Codex 匯入後建立 source verification、claim ledger、next tests；未驗證 claims 只能當假設，不得進 router、部署或交易 hot path。
   - 未來可做 browser 半自動，但 V4 預設不把 Deep Research 偽裝成同步 `/v1/responses` model。

### No-gap handoff contract

每個 Pro/Codex bridge packet 必須包含：`plan_id`、objective、constraints、repo/path refs、source links、decisions、open questions、next Codex action、Done condition、verification commands、artifact refs、content hash。任何模型若沒有 tool trace / `function_call_output` / test output，就只能提出 intent 或 critique，不能宣稱 side effect 已完成。

安全邊界：public MCP 不暴露 `run_command`、write/patch、approval resolve、worker claim/result、artifact/decision 直寫或 real `codex` execution；不記錄 secrets、tokens、auth state、SQLite、完整 logs、private thread ids、私有 tunnel URL 或本機絕對路徑。

## 完成定義

完成時必須同時滿足：

- `model_gateway` 的 `/v1/models` 與 `codex debug models -c model_provider='"'"'"model_gateway"'"'"'` 同時列出 `gpt-5.5`、`chatgpt-pro-consult`、`opus-4-7`、`opus-4-8`、`sonnet-4-6`、`haiku-4-6`、`fable-5`、`grok-build`、`minimax-m3`，且 Claude display name 不帶 `claude-` 前綴。
- `/v1/models` 的每個 route capability 暴露 `author_model`、`decision_model`、`executor_host`、`authority_mode`、`patch_proposal`；外部模型 route 的 `decision_model` 不得被誤標為 GPT。
- `/healthz` 標明 OpenAI/GPT 是 `passthrough`，Claude 是 `prompt_bridge_experimental`，不能把 Claude 說成官方等級 passthrough；`/healthz.capabilities` 與 `/healthz.routes` 也要暴露 authority metadata。
- `chatgpt-pro-consult` 明確標示 `pro_research_equivalence=false`；`/healthz.pro_research_lane.kind` 是 `ProResearchJobV1` 且 `sync_responses_model=false`。
- 五個 Claude slug 都至少跑一次 `/v1/responses` 極短 smoke test，看到 `response.completed`。Grok CLI 可用時，`grok-build` 也要跑一次同等 smoke。
- Claude 文字回覆必須送出 assistant message 的 `response.output_item.done`，不能只有 `response.output_item.added` 或 `response.output_text.done`；否則 Codex App 可能完成 turn 但不落盤可見回覆。
- app-server 層建立 thread 時 `modelProvider` 是 `model_gateway`；後續 `turn/start` 只改 `model`，能在同一 thread 內先跑 `chatgpt-pro-consult` / GPT 再跑 Claude，最後切回 `chatgpt-pro-consult`。
- Codex App 左側專案列表不因 provider split 遺失既有未封存 threads；`post-update-check.sh` 的 sidebar provider coherence 必須通過。
- Gateway 對大型 context request 不得 reset socket 造成 Codex App `stream disconnected before completion` retry storm；超過上限時要回乾淨的 `413`。預設 body 上限是 `64MB`，可用 `GATEWAY_MAX_BODY_BYTES` 覆寫。
- Claude/Grok backend 的登入、OAuth、quota、session limit 這類使用者可處理狀態，不得用 streaming `response.failed` 回給 Codex App；要轉成可見的 completed assistant message，避免 App 誤判為 stream 斷線並重試。
- 多模型協作不得默默走按量 API。Gateway 預設 `deny_metered_api_fanout`；只有 `local-openai-compatible`、`minimax-near-unlimited-api`、或 `user-approved-api:<provider>/<model>` 這類白名單模型/端點，且人類明確確認 provider、endpoint、計費型態、預算/停止條件後，才能啟用 API route。
- request-scoped tool bridge 測試通過：Claude 只能輸出工具意圖，gateway 轉成 Responses `function_call`，Codex App 執行工具後的 `function_call_output` 能回灌下一輪 prompt。
- ChatGPT Pro bridge 健康：Codex MCP Hub 的 connector-safe tool list 至少有 `collab_guide`、`codex_handoff_draft`、`codex_handoff_create`、`collab_pack_get`；public connector 不暴露 `run_command` / write / patch，也不能直接排 real `codex` lane；`collab_pack_get(plan_id)` 可恢復同一個 handoff 狀態。
- 使用者自己的 Codex config 已備份後設定 `model_provider = "model_gateway"`；如需遷移既有未封存 `openai` threads，必須一次性備份 SQLite 與 rollout metadata 後合併 provider，避免 sidebar 失去舊聊天。不做 watcher。
- GitHub/交接版本不得包含 auth、token、state database、完整 logs、rollout 全文、私人 thread id、本機絕對路徑、私有截圖、renderer reverse-engineering 細節或可被當成攻擊 playbook 的內容。

## 不可破壞邊界

- 不建立 per-model provider，例如 `opus-*`、`sonnet-*`、`haiku-*`、`grok-*`、`minimax-*` 都不能成為 Codex provider。
- 不修改 signed Codex App bundle，不 patch renderer，不記錄 renderer 內部檔名、hash、minified code 或繞過簽章/repair 的方法。
- 不用 watcher 反覆改寫 config、model cache、thread provider、rollout metadata、sidebar roots 或 app bundle。
- 不修改 `~/.claude`、Claude Code project state、Claude MCP config 或其他模型原生工具設定。
- 不把 Codex tools 寫入外部模型的全域環境；外部模型原生 app 回到自己的 runtime 時不能看到 Codex App 的 MCP、computer use、plan/goal tools。
- 不把 `models_cache.json` 當主要真相來源。它可以作為 cache/diagnostic，但穩定真相是 gateway `/v1/models`、Codex config provider 與 app-server thread provider。
- 不把 Claude text response 誤標成完整 Codex agent 相容；工具橋未測的功能必須標成 experimental 或 not implemented。
- 不因環境存在 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`XAI_API_KEY`、`MINIMAX_API_KEY` 或相容 key 就自動開 API subagent fan-out；未白名單 API route 必須停用。

## 全模型預設 fast（reasoning 預設）

Codex App 原生的「fast」切換鍵是 **renderer 寫死綁在原生 `openai` provider** 上的；切到自訂 `model_gateway` provider 後，**任何 catalog 欄位都無法讓那顆鍵出現**（已實測：原生與 gateway 的 gpt-5.5 catalog 逐欄位相同、`service_tiers`/`additional_speed_tiers` 連原生都是空的，差別只在 provider 身分）。要那顆鍵就只能 patch 簽名 App（禁止）或切回原生 provider（失去 dropdown 多模型）。

gateway 端的等效做法：**讓每個模型在選單裡預設停在 fast（低）那一檔**。`buildModelEntry` 的 `default_reasoning_level` 由 `DEFAULT_REASONING_LEVEL`（env `GATEWAY_DEFAULT_REASONING_LEVEL`，預設 `low`）統一供給所有模型。效果：

- GPT passthrough：`low` 透傳 ChatGPT，**實際變快**。
- Claude / MiniMax / Grok：經 gateway **不消費 reasoning_effort**，但本來就快；`low` 讓 App 預設停在快檔、UI 一致（要深度推理就在該 thread 把選單調高，或開 plan mode）。

搭配 `~/.codex/config.toml` 的 `model_reasoning_effort = "low"` + `service_tier = "fast"`（兩個 config home 都要），即「全模型日常預設 fast」。改完需**完全重開 Codex App**，舊 thread 仍記舊檔。`post-update-check.sh` 已納入此檢查項（全模型 `default_reasoning_level=low`）。

## 自動壓縮（auto-compaction）在自訂 provider 下的修法

症狀：Codex App 用 `model_gateway` provider 時長 thread **不自動壓縮、直接撞窗口上限 OOM**（`ran out of room in the model's context window`）。

關鍵成因（非 provider 硬擋，是 config 的 scope 算錯）：`model_auto_compact_token_limit_scope` 預設是 `body_after_prefix`，**只計「carried prefix 之後的新增」**；在高快取（cached prefix 很大）情況下，被計入的 token 永遠到不了門檻 → 壓縮永不觸發，但 total context 一路長到撞牆。

修法（純原生設定，不是 gateway hack）— `~/.codex/config.toml`：

```toml
model_auto_compact_token_limit = 200000
model_auto_compact_token_limit_scope = "total"   # 整個 active context 計入門檻（關鍵）
```

- 壓縮本身是 **Codex App + 上游模型原生功能**（codex 內建 `remote compaction`、`context_compacted` 事件）。
- **GPT 路徑完全原生**：gateway 對 OpenAI-family slug 是逐位元 verbatim 轉發（body + headers），App 的原生壓縮請求/回應**原封穿透到 ChatGPT**，gateway 不參與壓縮。
- catalog 另以 `auto_compact_token_limit`（per-model，約 window 60%）做 advisory；但**決定性的是上面 config 的 scope=total**。
- 改完需**完全重開 Codex App**；舊 thread 不回溯。
- 非 passthrough backend（claude/minimax/grok）要原生壓縮需 gateway 回 compaction-shaped output（未實作；GPT 已 native-complete，優先）。
- 驗證：跑到門檻後讀 rollout 找 `context_compacted` / `compaction` 事件。

## 架構

Codex config 只需要一個 provider：

```toml
model = "gpt-5.5"
model_provider = "model_gateway"

[model_providers.model_gateway]
name = "Model Gateway"
base_url = "http://127.0.0.1:4177/v1"
wire_api = "responses"
requires_openai_auth = true
```

`requires_openai_auth = true` 是必要條件。它讓 Codex App 保持 ChatGPT account session，GPT request 才能帶著 Codex session 的 Authorization、account、session、thread 相關 header 交給 gateway 轉發到 ChatGPT Codex subscription endpoint。這不是 OpenAI API key 路線。

Gateway 依 `request.model` 分流：

- `chatgpt-pro-consult` / `chatgpt-pro`：Codex-native 顧問 route；gateway 只把上游 model 改寫成 `gpt-5.5`，保留官方 Codex tools、MCP、computer use、plan/goal mode 與同 thread continuity。
- `gpt-*` 與 `codex-auto-review`：原封不動 proxy 到 Codex ChatGPT subscription Responses endpoint，保留官方 Codex tools、MCP、computer use、plan/goal mode 與未來 Codex App 功能。
- `opus-4-7`、`opus-4-8`、`sonnet-4-6`、`haiku-4-6`、`fable-5`：呼叫 Claude CLI，使用 `--no-session-persistence`、空 MCP config、停用 slash commands、禁止 Claude 原生工具執行。`opus4.7`、`opus4.8`、`sonnet4.6`、`haiku4.6`、`fable5` 可作為相容 alias，但 catalog slug 保留 Codex 已驗證可解析的 hyphen form。
- Grok `grok-build`：呼叫 Grok CLI，保留 Grok CLI 自己的模型命名，gateway request 內停用 plan/memory/web search/native tools；Codex tools 仍只走 request-scoped prompt bridge。
- 未來模型：只新增 catalog entry 與 backend adapter，不新增 Codex provider；先補 capability matrix，再補 tests。

### API 白名單模型政策

目前內建路由不是按量 API key fan-out：GPT 是 ChatGPT subscription passthrough，Claude/Grok 是已登入 CLI/OAuth。未來新增 Minimax、本地模型或其他 API backend 時，必須先填 `/healthz.api_spend_policy` 與 model `capabilities.api_spend`：

- 預設：`deny_metered_api_fanout`。
- 可用 API 白名單：`local-openai-compatible`、`minimax-near-unlimited-api`、`user-approved-api:<provider>/<model>`。
- 啟用條件：人類明確確認 provider/model、endpoint/runtime、計費或額度型態、最大可接受花費/用量與停止條件。
- 若發現多模型協作走了未白名單 API，立即停用該 adapter/key path，保存 checkpoint，改走訂閱 CLI、本地模型或白名單 API。

可用 `GATEWAY_API_MODEL_ALLOWLIST=local-openai-compatible,minimax-near-unlimited-api` 讓 `/healthz` 顯示本機允許的 API 類型；這只是聲明與診斷，不代表自動啟用任何 API adapter。

## Request-Scoped Tool Bridge

Claude/Grok/Minimax 等外部模型只能透過 request-scoped bridge 使用 Codex App 功能：

- 當次 Responses request 內提供的 `tools` schema 是外部模型可見的工具來源；未在 schema 中出現就不可假裝可用。
- Gateway 把當次 `tools` schema 轉成 prompt bridge 說明，外部模型只能回工具意圖 JSON。
- Gateway 驗證工具名稱必須存在於當次 request；不存在就回明確錯誤，不臆造工具。
- Gateway 把工具意圖轉成 Responses `function_call` event；當次授權的 `executor_host`（通常是 Codex App）才可執行工具並留下 trace。
- 下一輪 request 的 `function_call_output`、`tool_search_call_output` 或同類結果再回灌給外部模型。
- Computer use、plan mode、goal mode、MCP、future app tools 都走同一條規則：只有 Codex App 在 request schema 中暴露時才可用。

最小 function call event 形狀：

```json
{
  "type": "response.output_item.done",
  "item": {
    "type": "function_call",
    "call_id": "call_xxx",
    "name": "exec_command",
    "arguments": "{\"cmd\":\"pwd\"}"
  }
}
```

Namespace tool 要保留 `namespace`：

```json
{
  "type": "response.output_item.done",
  "item": {
    "type": "function_call",
    "call_id": "call_xxx",
    "namespace": "codex_app",
    "name": "update_plan",
    "arguments": "{\"plan\":[]}"
  }
}
```

## 導入流程

1. 先跑只讀診斷：

```bash
bash scripts/readonly-diagnose-codex-gateway.sh
```

2. 備份 Codex 狀態，只保存到本機，不提交：

```bash
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$HOME/.codex/backups/model-gateway-v4-$TS"
cp "$HOME/.codex/config.toml" "$HOME/.codex/backups/model-gateway-v4-$TS/config.toml"
cp "$HOME/.codex/state_5.sqlite" "$HOME/.codex/backups/model-gateway-v4-$TS/state_5.sqlite"
cp "$HOME/.codex/models_cache.json" "$HOME/.codex/backups/model-gateway-v4-$TS/models_cache.json" 2>/dev/null || true
```

3. 部署 gateway runtime，確認 `package.json` 有 `npm test`，server 有 `/healthz`、`/v1/models`、`/v1/responses`。

4. 寫入單一 provider config。若 `model_provider` 已存在，改成 `model_gateway`；若不存在，新增在 `model` 後方。

5. 啟動或重啟 gateway。LaunchAgent 可以存在，但只能管理 gateway process，不可修改 Codex App bundle 或 Codex state。

6. 驗證 model catalog。若 `codex debug models` 缺 Claude，但 gateway `/v1/models` 正常，先檢查 provider parse error。常見原因：model catalog 的必填欄位型別錯，例如 `base_instructions` 不能是 `null`。

7. 驗證 sidebar provider coherence。若 `state_5.sqlite` 仍有未封存 `openai` threads，而全域 provider 是 `model_gateway`，左側專案列表可能顯示「沒有聊天」。執行：

```bash
bash scripts/migrate-sidebar-threads-to-gateway.sh
```

這個腳本會先備份 SQLite 與受影響 rollout，再把未封存 `openai` threads 合併到 `model_gateway`。不要用 watcher 反覆修。

8. 驗證 app-server same-thread。不要用 `send-message-v2 -c model_provider=...` 當 provider 驗收；該 helper 可能仍用既有 `openai` thread。必須建立或恢復 `model_gateway` thread，再用 `turn/start` 切不同 `model`。

9. 遷移既有 thread 時的原則：若只是修單條 thread 的模型選單，可只處理指定 thread；若全域 provider 已改成 `model_gateway` 且 sidebar 隱藏舊聊天，必須處理所有未封存 `openai` threads，否則 UI 交付不穩。兩種情境都必須先備份，不得批量處理已封存歷史 thread，除非使用者明確要求。

## 驗收命令

Gateway runtime：

```bash
npm test
node --check server.js
curl -fsS http://127.0.0.1:4177/healthz | jq '{ok,provider,chatgpt_subscription_passthrough,capabilities}'
```

一次性 live verifier：

```bash
MODEL_GATEWAY_DIR=<gateway-dir> bash scripts/live-verify-codex-gateway.sh
```

Claude quota 尚未 reset 時，只驗證非 Claude live 項目：

```bash
MODEL_GATEWAY_DIR=<gateway-dir> RUN_CLAUDE_SMOKE=0 bash scripts/live-verify-codex-gateway.sh
```

`scripts/live-verify-codex-gateway.sh` 會呼叫 `scripts/app-server-same-thread-smoke.js` 驗證同一條 app-server thread 可依序跑 `chatgpt-pro-consult -> opus-4-7 -> opus-4-8 -> sonnet-4-6 -> haiku-4-6 -> chatgpt-pro-consult`，且核心 Claude slug 都能讀到 ChatGPT Pro Consult 前一輪放入的驗收碼。`fable-5` 另由 live smoke 驗證；若上游回「目前不可用」，gateway 必須用可見 completed notice 表達，不能用 `response.failed` 造成 retry loop。可用 `SAME_THREAD_CLAUDE_MODELS=opus-4-7,opus-4-8,sonnet-4-6,haiku-4-6,fable-5` 在 Fable 可用時把它納入 same-thread 驗收。
完整驗收不得設定 `RUN_CLAUDE_SMOKE=0` 或 `RUN_SAME_THREAD_SMOKE=0`；跳過模式只用於 quota reset 前確認非 Claude 路徑沒有退化。

Catalog：

```bash
curl -fsS http://127.0.0.1:4177/v1/models \
  | jq -r '.models[]? | select(.slug|test("^(gpt-5.5|chatgpt-pro-consult|opus-4-7|opus-4-8|sonnet-4-6|haiku-4-6|fable-5|grok-build|minimax-m3)$")) | [.slug,.display_name,.capabilities.backend,.capabilities.codex_tools] | @tsv'

codex debug models -c model_provider='"model_gateway"' \
  | jq -r '.models[]?.slug' \
  | rg '^(gpt-5\.5|chatgpt-pro-consult|opus-4-7|opus-4-8|sonnet-4-6|haiku-4-6|fable-5|grok-build|minimax-m3)$'
```

Claude slug smoke：

```bash
for model in opus-4-7 opus-4-8 sonnet-4-6 haiku-4-6 fable-5; do
  curl --max-time 90 -sS -N http://127.0.0.1:4177/v1/responses \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$model\",\"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"只回 OK_$model。\"}]}],\"stream\":true}" \
    | rg "OK_$model|response.completed|response.failed|error"
done
```

GPT passthrough 必須用 Codex app-server 或帶有 Codex session Authorization 的 request 驗證。沒有 Authorization 時，gateway 應清楚回 401，而不是假裝成功。

Tool bridge tests：

```bash
npm test -- --test-name-pattern 'Claude prompt bridge'
npm test -- --test-name-pattern 'Claude text responses'
```

app-server same-thread 驗收要檢查這三件事：

- `thread/start` response 的 `modelProvider` 是 `model_gateway`。
- 第一個 `turn/start` 用 `model: "chatgpt-pro-consult"` 成功。
- 同一個 `threadId` 後續 `turn/start` 分別用 `opus-4-7`、`opus-4-8`、`sonnet-4-6`、`haiku-4-6` 成功讀到前文，最後再切回 `chatgpt-pro-consult` 成功。

## 失敗處理

- `Model Gateway received gpt-5.5, but GPT subscription passthrough is not implemented`：gateway 還在舊版，必須補 GPT proxy，不可把預設 provider 切回 per-model/provider 分派系。
- `codex debug models` 只剩 GPT：先看 gateway `/v1/models` 是否正確，再看 catalog JSON 欄位型別是否讓 Codex parse fallback。
- Claude 只回文字不能用工具：看 `/healthz` 的 Claude `codex_tools` 是否仍是 `not_implemented`，或 request 是否真的帶 `tools` schema。
- Codex App 對 `127.0.0.1:4177/v1/responses` 顯示 `stream disconnected before completion` 並反覆 `Reconnecting... 1/5→5/5`：先看 gateway 是否仍在舊 2MB body cap。修：更新 runtime 到含 `GATEWAY_MAX_BODY_BYTES` 的版本，預設 64MB；超限要回 `413 request body too large`，不可 `req.destroy()` reset socket。重啟：`launchctl kickstart -k gui/$(id -u)/com.$(id -un).codex-model-gateway`。
- Claude/Grok session limit 或未登入時出現同樣 reconnect loop：gateway 把 backend limit/auth 當 `response.failed` 送出，Codex App 會 retry。修：更新 runtime 到「backend notice completes visibly」版本；此時 UI 應收到一則 assistant 訊息說明 limit/auth，而不是 `response.failed`。
- 重 turn（ultrawork + 1M-context Claude）跑幾分鐘後 `stream disconnected` / `Reconnecting`，但 body 沒超 cap、gateway 也沒崩：成因是 buffered backend（`sse_after_backend_completion`）在 `await runClaude` 期間沒有 data-bearing Responses 事件，Codex App idle timeout 先斷線；且 `CLAUDE_TIMEOUT_MS` 預設 2 分鐘會把長 turn SIGKILL。修：runtime 在 stream 開始立即送 `response.created`，等待期間每 `GATEWAY_HEARTBEAT_MS`（預設 15s）送語義型 `response.in_progress` SSE（不要只送註解 keepalive，部分 App/reconnect path 不算活動），完成時用同一 response id 送 `response.output_item.done` + `response.completed`；plist 把 `CLAUDE_TIMEOUT_MS` 拉到 600000、`GROK_TIMEOUT_MS` 300000。安裝器已內建這些預設並可用同名 env 覆寫。
- 重度 thread 撞 `ran out of room in the model's context window`：catalog 把 Claude context_window 報成 200K 而 Codex App 依此擋。修：對 1M-capable slug（如 opus-4-8）在 `claudeRoutes` 加 `context_window: 1000000` 並把 `[1m]` 變體放 candidates 第一個（advertise 與後端必須一致）；既有 thread 已固化上限，要開新 thread 才生效。
- Codex App 工作中反覆斷線，App log 大量 `initialize handshake timed out` / `reconnect_failed` / `transport_closed`，且可見 `unsupported feature enablement auth_elicitation`：優先檢查外部 `codex app-server --listen unix://` 與 `codex app-server proxy` 是否由 PATH 上的舊 CLI 啟動，而非 App bundle 內建 binary。App 與 app-server 版本即使只差 prerelease suffix，也可能導致 remote-control handshake mismatch。修：不要 patch signed App；殺掉 stale app-server/proxy，讓 `codex app-server*` 一律走 `/Applications/Codex.app/Contents/Resources/codex`（可用 `$HOME/.local/bin/codex` wrapper 只攔 `app-server` 子命令，普通 CLI 仍走 Homebrew/系統 CLI），再重開 App 或讓 App 重啟 app-server。驗證：新 app-server/proxy command path 來自 Codex.app bundle，且新時間窗內 handshake/reconnect/transport counter 為 0。
- GPT passthrough 時使用者取消 turn、App 重連或 client socket 提前關閉後，gateway launchd 反覆重啟，stderr 出現 `DOMException [AbortError]` / `ServerResponse.onClientGone`：這是 client cancellation 被當成未處理例外冒泡，不是上游 GPT 壞掉。修：runtime 的 `proxyChatgpt()` 必須追蹤 `clientGone` / `timedOut`，client gone 時 abort upstream 並吞掉 `AbortError`，只有 timeout 回乾淨 `504`；reader loop 與 top-level `handleResponses()` 也要 catch，避免整個 gateway 崩潰。補 regression test：GPT passthrough client disconnect aborts upstream without crashing gateway。
- 多模型協作開始消耗 API 額度或看到未知 API key 被使用：立即停用該 API route / adapter / key path；只有 `local-openai-compatible`、`minimax-near-unlimited-api` 或人類針對本次任務明確批准的 `user-approved-api:<provider>/<model>` 可以恢復。恢復前必須記錄 provider、endpoint、計費/額度型態、預算上限與停止條件。
- Claude turn 顯示完成但 App 沒有可見 assistant message：檢查 gateway SSE 是否對文字回覆送出 `response.output_item.done`，並跑 `Claude text responses emit completed assistant message items for Codex App persistence` 測試。
- Claude 要求不存在的 tool：gateway 必須拒絕，不能交給 Claude 原生 runtime 嘗試執行。
- UI dropdown 看不到模型但 CLI/gateway 正常：記為 Codex App UI/cache/upstream issue，不 patch signed app，不提交 reverse-engineering notes。
- 模型下拉已出現外部模型，但左側專案列表或專案內舊 thread 顯示「沒有聊天」：不是刪除，是 provider split。全域 provider 已切到 `model_gateway`，但舊未封存 threads 還是 `openai`，App 只列目前 provider。修：`bash scripts/migrate-sidebar-threads-to-gateway.sh`，再 `Cmd+R` 或重開 Codex App。
- 單條既有 thread 仍走 `openai`：thread provider 已固化。可遷移指定 thread 的 SQLite + rollout 首行，或新建 `model_gateway` thread。

實機部署常見失敗（多台機器跑不起來，幾乎都是這幾個；安裝器會自動處理前三個）：

- `grok-build` 回 `502 failed to start grok CLI (grok): spawn grok ENOENT`：launchd 的 PATH 沒有 grok 安裝目錄（常在 `~/.grok/bin`）。修：重跑 `install-codex-gateway.sh`（它把 `GROK_COMMAND` 設成 `command -v grok` 的絕對路徑、PATH-independent），或手動在 plist 的 `EnvironmentVariables` 加 `GROK_COMMAND=<grok 絕對路徑>`。`claude` 路徑變動同理（`CLAUDE_COMMAND`）。
- grok 回 `not authenticated`：跑 `grok login --oauth`（互動式，無法自動代登）。
- `codex` / app-server 在某些機器 crash 或讓 Claude Code 失去某卷存取：`CODEX_HOME` 指向 noowners 外接卷（`/Volumes/...`）會觸發 codex 強制 chmod 0600 / TCC 撤權。修：`export CODEX_HOME=$HOME/.codex`（本機 SSD）再跑；跑 `codex exec` 一律帶 SSD 的 CODEX_HOME。
- gateway 整個進程反覆崩潰（launchd 一直重啟）：舊版 runtime 的 `runClaudeOnce` 缺 `child.on('error')`，claude binary 一移動就讓進程崩。修：更新 server.js（close handler 改 settled-guard、補 `child.on('error')`、子程序 stdout 加上限）。
- 子程序輸出撐爆記憶體（OOM 拖垮所有路由含 GPT passthrough）：claude/grok stdout 無上限。修：server.js 加 `MAX_CHILD_STDOUT` 上限。
- 未來非 `gpt-` 前綴的 OpenAI 模型（如 `o4-mini`）出現後在 dropdown 選了卻 404：`isOfficialOpenAiSlug` 只認 `^gpt-`。修：放寬為 `^(gpt-|o[1-9]\d?(-|$)|chatgpt-|codex(-|$))`，未知 OpenAI slug 走 passthrough 由上游回真錯。
- 切換在某台機器完全沒接上（codex debug models 看不到 gateway）：config 沒設 provider 或 node 路徑錯。修：重跑 `install-codex-gateway.sh`（會寫 provider 區塊並用偵測到的 node 絕對路徑）。
- Codex App / CLI 對 Pro 帳號狂跳 `usage limit reached` / `Upgrade to Plus` / `try again <一個月後>`，但帳號選單顯示 Pro、剩餘用量還很多：**先別當成真的撞限額或帳號沒付費**。直接打後端會看到 `plan_type: free`，但本機 token claim 是 `pro` ── 這是 **OAuth refresh-token 輪換競爭**造成的壞 session：refresh token 是一次性，gateway + 多個 `codex app-server` + CLI 同時讀同一份 `auth.json` 各自刷新，一個刷新就作廢其餘，連鎖出 `refresh_token_reused` / `token_invalidated` / `refresh token was revoked`，後端對壞 session 退化成 free 限額。修：**先靜默所有 auth.json 消費者**（quit App → `pkill codex app-server` → `launchctl bootout` gateway），再乾淨 `codex logout && codex login`，最後**逐一**把 gateway → App 開回來，避免重登後又被搶刷。驗證：乾淨重登後 `codex exec -m gpt-5.5` 跑通即代表帳號本身正常、先前 free 是壞 token 假象。**診斷時不要手刻 request 連打 `chatgpt.com/backend-api/codex`**（固定 session_id 的重放會觸發濫用偵測、加重 session 失效）；用正規 client（CLI / App）測。
- 多模下拉只剩 GPT 系、claude/grok/minimax 不見，但 gateway `/v1/models` 回傳完整：**stale `models_cache.json`**。成因：在 gateway 重啟/抓取窗口內 Codex 去 refresh catalog，只有 GPT passthrough 那條即時可回，Codex 把「只剩原生認得的 OpenAI slug」的 fallback 清單寫進 cache。修：備份後刪 `models_cache.json`，跑 `codex debug models`（或重開 App）強制重抓完整 catalog。與 sidebar provider-split（thread 被藏）是**不同**問題，後者用 `migrate-sidebar-threads-to-gateway.sh`。
- 影像生成（`gpt-image-2` 等）反覆回 `The model '...' does not exist`：`isOfficialOpenAiSlug` 把 `gpt-image-*` 當官方 slug → 走 `proxyChatgpt` 轉發到 `/backend-api/codex/responses`，但該 endpoint 不服務影像模型 → 上游回不存在；gateway 也沒有 `/v1/images` 路由。**已知限制：訂閱 `/responses` passthrough 不支援影像生成**（文字模型 gpt/claude/minimax 正常）。常為**暫態**：底層壞 turn（token/cache 問題）修好後該 thread 重跑就不再觸發。要根治只有兩條，且都需取捨：(a) gateway 對 image slug 回一則乾淨可見的「不支援影像」completed message（不再洗 8 次 raw error，不花錢、不逆向）；(b) 人類明確授權後走 `user-approved-api:openai/gpt-image-*` 的按量 images API（花錢、與訂閱分開）。**不得逆向 OpenAI 影像後端路徑**。

## GitHub / Handoff Hygiene

提交 v4 到 GitHub 前必須檢查：

- 不提交 `auth.json`、token、SQLite、models cache、logs、rollout、screenshots、private thread ids。
- 不提交本機絕對路徑；文件只使用 `$HOME`、`$CODEX_HOME`、`127.0.0.1`、`<repo>`、`<gateway-dir>`。
- 不提交 signed app bundle patch、renderer asset names、minified snippets、signature bypass、repair bypass 或 UI allowlist 逆向細節。
- Incident 復盤若要保留，必須抽象化成 failure mode，不包含可重放的本機 state 或攻擊路徑。
- README 要說明 repo 是 private-first；公開前需另做 redaction review。

## 回滾

1. 停止新的 gateway/config/thread 修改。
2. 還原備份的 `config.toml`、`state_5.sqlite`、`models_cache.json`。
3. 若只遷移過指定 thread，還原該 rollout 首行或直接還原備份。
4. 重啟 gateway 或停用 gateway LaunchAgent。
5. 驗證 `codex debug models` 與 app-server thread 行為回到預期狀態。

## 迭代紀錄（越用越補）

本 skill 設計成「越用越準」：每次在新機器部署或維修時，若遇到上面沒涵蓋的 failure mode，**把它抽象成一條 `症狀 → 成因 → 修法` 補進「失敗處理」，並在這裡記一行日期 + 一句教訓**。只記可泛化的 failure mode，不貼可重放的本機 state、token、thread id 或攻擊路徑（見 GitHub Hygiene）。

維護慣例：
- 新失敗先想「能不能讓 `install-codex-gateway.sh` 自動處理」；能就改安裝器（最有價值），改不動才留成手動步驟。
- 任何「每台機器都會踩」的雷，優先做成偵測（`--preflight`）或自動修，而不是只寫進文件。
- 驗收一律用 `post-update-check.sh`，新增的保證就加一個檢查項。

紀錄：
- 2026-06-01：多台機器部署失敗的根因 80% 是「launchd PATH 缺 CLI 目錄」(`spawn ENOENT`) 與「per-machine 登入狀態」。對策：安裝器偵測 `command -v` 絕對路徑寫進 `CLAUDE_COMMAND`/`GROK_COMMAND`，preflight 列出待登入項。
- 2026-06-01：`CODEX_HOME` 預設指 noowners 外接卷會讓 codex crash／撤卷存取。對策：安裝器與 post-update-check 都偵測並警告，跑 codex 一律帶 `CODEX_HOME=$HOME/.codex`。
- 2026-06-01：腳本若用 bash 4 關聯陣列會在 macOS 內建 bash 3.2 直接失敗。對策：所有腳本維持 3.2 相容（用 `case` 去重，不用 `declare -A`）。
- 2026-06-01：runtime 韌性補強——`runClaudeOnce` 補 `child.on('error')`（避免 binary 移動崩整個 gateway）、子程序 stdout 加上限（避免 OOM）、`/healthz` 不再洩 `last_error` 內文、OpenAI slug regex 放寬（未來模型不 404）。npm test 9→12 綠。
- 2026-06-01：UI 可見性補強——只把目前 thread 遷到 `model_gateway` 會讓其他未封存 `openai` threads 在左側專案列表看似消失。對策：安裝器預設跑 backed-up sidebar provider merge；`post-update-check.sh` 新增 coherence gate。
- 2026-06-01：大型 ultrawork prompt 會超過舊 2MB body cap，gateway reset socket 導致 Codex App 無限 `stream disconnected` + retry。對策：預設 body cap 調到 64MB，可用 `GATEWAY_MAX_BODY_BYTES` 覆寫；超限回 413，不 reset socket。
- 2026-06-01：Claude session limit 也會因 `response.failed` 被 Codex App 當斷線重試。對策：backend quota/auth/login 類錯誤改成 completed assistant message，保留可見錯誤但停止 retry storm。
- 2026-06-01：多模型協作必須防止未授權 API fan-out 燒額度。對策：skill 與 `/healthz` 加入 deny-by-default API spend policy；白名單只允許本地無上限、Minimax 近吃到飽或人類逐案批准的 API。
- 2026-06-01：把 Codex App 環境調到能穩定承載「gateway + ultrawork-claude」重載。三個真兇都不是 gateway 崩潰：(1) launchd job 沒 bootstrap → 4177 無 listener；(2) Claude catalog 報 200K context，重 thread 被擋 → opus-4-8 改走 `[1m]` 變體並 advertise 1M；(3) buffered SSE 在長 turn 期間零 byte + 2 分鐘 timeout → 加 15s SSE keepalive + `CLAUDE_TIMEOUT_MS` 600000。教訓：多接模型的「不穩」幾乎全在外掛 CLI 那層（context/timeout/idle-disconnect/launchd），GPT passthrough 本身穩；對症調 timeout/keepalive/context 比精簡或回滾更符合使用者要保留全模型的需求。調校已寫進 installer 預設（同名 env 可覆寫），server.js 不被 installer 覆寫故 heartbeat 改動 durable。
- 2026-06-01：Codex App app-server 必須與 App bundle binary 同源；PATH 上的穩定版 CLI 啟動 app-server/proxy，可能和 App 內 alpha/prerelease binary handshake 不相容，造成 initialize handshake timeout / reconnect storm。對策：只把 `codex app-server*` 路由到 App bundle binary，普通 CLI 可保留 Homebrew 版。
- 2026-06-01：GPT passthrough 的 client cancellation 不能讓 gateway 崩潰。對策：client-gone/AbortError 是正常控制流，runtime 要 abort upstream、清理 reader、吞掉 AbortError；只有真正 timeout 才回 504，並用 regression test 固定。
- 2026-06-03：Pro 帳號的「假撞限額」事故鏈，三個獨立 failure mode 連環登場，逐一誤判浪費多輪。教訓：(1) **OAuth refresh-token 輪換競爭**最會偽裝成「帳號沒付費/撞限額」── token claim=pro 但後端=free 就是壞 session 的指紋，正解是靜默全部 auth.json 消費者後乾淨重登再逐一開回，而不是去查 billing 或重啟 App；診斷時手刻後端請求會加重 session 失效，要用正規 client。(2) gateway 重啟窗口會讓 Codex 把 **fallback catalog 寫進 `models_cache.json`**，多模下拉只剩 GPT；清 cache 重抓即解，別跟 sidebar provider-split 搞混。(3) **影像模型 `gpt-image-*` 走 `/responses` passthrough 必失敗**（endpoint 不服務影像、gateway 無 image route），是已知限制非新 bug，常隨底層壞 turn 修好而消失。三者全非 gateway 程式崩潰 ── 對症（重登/清cache/標記限制）比重啟或回滾準。**待辦**：可考慮對 image slug 在 server.js 回乾淨 completed message（目前仍是 raw upstream error）。
- 2026-06-08：切到 Opus 後長工具/長上下文回合仍會 `idle timeout waiting for SSE`，即使 gateway 已有註解式 keepalive。教訓：新版 Codex App / reconnect path 需要 data-bearing Responses 事件，SSE comment 可能不算活動。對策：external-model streaming 一開始就送 `response.created`，等待期間送 `response.in_progress`，完成時沿用同一 response id；補 regression test `Claude long buffered streams emit semantic in-progress heartbeats before completion`；同時把 `post-update-check.sh` 納入 `model_reasoning_effort=low`、`service_tier=fast`、auto-compact scope、catalog low 檢查，避免 Opus 日常預設跑太重。
- 2026-06-10：auth 輪換競爭**復發**，真兇是第二個 CODEX_HOME（subagent 專用 home）裡的孤兒 `auth.json` 副本——主 session 重登後它仍持舊 token，永遠 401 且搶刷會再弄壞主 session。對策三件：(1) 子 home 的 auth.json 一律 symlink 指向主 `auth.json`，不留獨立副本；(2) `post-update-check.sh` 新增 `[5b]` auth 單一真相源檢查（多副本 inode 分歧即 warn + 給修復指令），6/3 待辦完成；(3) 新教訓：**`codex login` 會重寫 `config.toml` 並丟掉 `service_tier` 等自訂鍵**，重登後必跑一次 post-update-check（[1] 區塊抓得到）。另：安裝器 `MINIMAX_TIMEOUT_MS` 預設 120s→480s（M3 長上下文首包會超 120s 被誤判網路錯誤）；server.js 對 `GATEWAY_MAX_BODY_BYTES` 加 NaN/負值守衛（負值原本會讓所有請求恆 413）。
- 2026-06-10（第二輪）：三項適配性升級落地並 24/24 test 綠。(1) **Claude 真 streaming**：text-only turn 改走 `claude -p --output-format stream-json --include-partial-messages`，gateway 逐行轉成 `response.output_text.delta` 增量事件（added→part.added→delta*→done→part.done→item.done→completed，id 全程一致；thinking_delta 永不外流）；工具橋 turn 維持 buffered（工具意圖 JSON 不能以可見文字流出）；`CLAUDE_STREAMING=0` 退回 buffered；首 delta 前失敗可換 candidate，之後 commit、失敗以標記清楚的 gateway notice 完結（不發 response.failed 避免 retry storm）。實測 11 個增量 delta。(2) **usage 記帳**：claude/minimax/grok 結果的 usage 正規化進 `response.completed`（cache tokens 計入 input、cached_tokens 明細），這是 Codex App 對 custom provider 做 token accounting / auto-compact 的必要前置——只宣稱補齊記帳，端到端自動壓縮需長 thread 實測。(3) **error_kind 觀測**：/healthz route state 新增 `error_kind`（auth/quota/timeout/spawn/output_cap/model/network/parse/unknown）、`last_error_at`、`candidate_hits`（重啟歸零），不洩 error 原文。注意：streaming 上線後「completed assistant item」測試的選擇器要選 `output_item.done`，因為 `output_item.added` 也是 message item。
