---
name: codex-app-model-gateway
description: Use when implementing, diagnosing, or handing off Codex App external model gateway v3. Enforces one provider, GPT subscription passthrough, Claude request-scoped tool bridge, sanitized handoff, and rollback-safe verification.
metadata:
  short-description: Codex App model gateway v3 workflow
---

# Codex App Model Gateway v3

> **免責聲明 / Disclaimer**：本工具讓你在自己付費的 Codex App 內把模型切到 Claude / Grok，並讓 GPT 透過你**自己的** ChatGPT 訂閱 session 繼續運作。它只代理「你自己已登入」的 session，不分發、不竊取任何憑證。但「以本機 proxy 轉發 ChatGPT 訂閱 session」可能牴觸 OpenAI ChatGPT 訂閱條款（訂閱條款對自動化／代理／非官方介面通常比 API 條款更嚴）；Claude CLI / Grok CLI 的包裝亦各受其供應商條款約束。**是否使用、是否合規由你自負**，請先自行確認 OpenAI / Anthropic / xAI 當前條款。本 repo private-first，公開散布前自行評估帳號風險。工具按「現狀（as-is）」提供，無任何擔保。

目標是讓 Codex App 只使用一個穩定 provider：`model_gateway`。同一條 thread 內只切換 `model`，不切換 provider。GPT 走 Codex ChatGPT subscription passthrough；Claude `opus-4-7`、`opus-4-8`、`sonnet-4-6`、`haiku-4-6` 走 Claude CLI adapter，display name 用 `opus4.7`、`opus4.8`、`sonnet4.6`、`haiku4.6`；所有工具能力都由 Codex App request-scoped tool bridge 掌握。

**穩定交付的 UI 定義**：不只 gateway health、catalog 與 live smoke 要綠，Codex App 左側專案列表也不能因 provider split 顯示「沒有聊天」。若全域 `model_provider` 已切到 `model_gateway`，未封存 `openai` threads 必須經一次性備份後合併到 `model_gateway`，否則 App 可能只顯示 gateway threads，讓舊專案看似消失。

## 一鍵部署 / 維修（每台機器先跑這個）

> **給 AI 安裝代理（照這個跑）**：依序執行下面三步，以 exit code 判成敗（`0`=成功）。
> 1. `bash scripts/install-codex-gateway.sh --preflight` — 只讀，列出本機缺的 CLI / 登入 / `CODEX_HOME` 雷。
> 2. `MODEL_GATEWAY_DIR=<gateway-dir> bash scripts/install-codex-gateway.sh` — 實際安裝（偵測路徑→寫 plist+config→合併未封存 thread provider→載入→驗收）。
> 3. `bash scripts/post-update-check.sh` — 驗收，**必須 exit 0** 才算成功。
>
> **你（AI）不能代做的只有登入**：若 preflight 顯示需要 `codex login` 或 `grok login --oauth`，停下來請人類在終端機自己跑（互動式 OAuth），完成後再回到第 2/3 步。其餘全自動、idempotent、會備份、不碰 signed app bundle。

新機器拿到本 skill 後，**先跑安裝器**——它會偵測本機 `node`/`claude`/`grok`/`codex` 的絕對路徑寫進 launchd plist，避開最常見的部署失敗（`spawn ENOENT`：launchd 的 PATH 沒有該 CLI 的安裝目錄，例如 grok 在 `~/.grok/bin`）。安裝器 idempotent、會先備份、不碰 signed app bundle。

前提：gateway runtime（`server.js` + `package.json` + `test/`）要先在機器上；放哪都行，用 `MODEL_GATEWAY_DIR` 指它（安裝器也會自動找 `../model-gateway`、`~/model-gateway`）。

```bash
# 0) dry-run：只讀，列出本機缺什麼（CLI、登入、CODEX_HOME 雷）
bash scripts/install-codex-gateway.sh --preflight

# 1) 安裝／修復：偵測路徑 → 寫 plist + 單一 provider config → 載入 → 驗收
MODEL_GATEWAY_DIR=<gateway-dir> bash scripts/install-codex-gateway.sh

# 2) 補手動登入（preflight 會列出本機缺哪個；這兩步無法自動代登）
codex login            # GPT passthrough 需要
grok login --oauth     # grok-build 需要（選用）

# 3) 驗收：不花 quota；--full 跑同 thread 真實切換（花 Claude quota）
bash scripts/post-update-check.sh
bash scripts/post-update-check.sh --full
```

> **Codex App 更新後切換失效就用這個修**：先跑步驟 3 定位，再視需要重跑步驟 1。gateway 是 launchd 獨立進程，**App 更新殺不掉它**；更新最常壞的是 config provider 被重設或 CLI 路徑變動，安裝器都會自動處理。腳本相容 macOS 內建 bash 3.2（不依賴 bash 4 的關聯陣列）。

## 完成定義

完成時必須同時滿足：

- `model_gateway` 的 `/v1/models` 與 `codex debug models -c model_provider='"model_gateway"'` 同時列出 `gpt-5.5`、`opus-4-7`、`opus-4-8`、`sonnet-4-6`、`haiku-4-6`、`grok-build`，且 Claude display name 不帶 `claude-` 前綴。
- `/healthz` 標明 OpenAI/GPT 是 `passthrough`，Claude 是 `prompt_bridge_experimental`，不能把 Claude 說成官方等級 passthrough。
- 四個 Claude slug 都至少跑一次 `/v1/responses` 極短 smoke test，看到 `response.completed`。Grok CLI 可用時，`grok-build` 也要跑一次同等 smoke。
- Claude 文字回覆必須送出 assistant message 的 `response.output_item.done`，不能只有 `response.output_item.added` 或 `response.output_text.done`；否則 Codex App 可能完成 turn 但不落盤可見回覆。
- app-server 層建立 thread 時 `modelProvider` 是 `model_gateway`；後續 `turn/start` 只改 `model`，能在同一 thread 內先跑 GPT 再跑 Claude。
- Codex App 左側專案列表不因 provider split 遺失既有未封存 threads；`post-update-check.sh` 的 sidebar provider coherence 必須通過。
- Gateway 對大型 context request 不得 reset socket 造成 Codex App `stream disconnected before completion` retry storm；超過上限時要回乾淨的 `413`。預設 body 上限是 `64MB`，可用 `GATEWAY_MAX_BODY_BYTES` 覆寫。
- Claude/Grok backend 的登入、OAuth、quota、session limit 這類使用者可處理狀態，不得用 streaming `response.failed` 回給 Codex App；要轉成可見的 completed assistant message，避免 App 誤判為 stream 斷線並重試。
- 多模型協作不得默默走按量 API。Gateway 預設 `deny_metered_api_fanout`；只有 `local-openai-compatible`、`minimax-near-unlimited-api`、或 `user-approved-api:<provider>/<model>` 這類白名單模型/端點，且人類明確確認 provider、endpoint、計費型態、預算/停止條件後，才能啟用 API route。
- request-scoped tool bridge 測試通過：Claude 只能輸出工具意圖，gateway 轉成 Responses `function_call`，Codex App 執行工具後的 `function_call_output` 能回灌下一輪 prompt。
- 本機 default config 已備份後設定 `model_provider = "model_gateway"`；同時一次性備份並合併未封存 `openai` threads 的 SQLite `threads.model_provider` 與 rollout 首行 `session_meta.payload.model_provider`，避免 sidebar 失去舊聊天。不做 watcher。
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

- `gpt-*` 與 `codex-auto-review`：原封不動 proxy 到 Codex ChatGPT subscription Responses endpoint，保留官方 Codex tools、MCP、computer use、plan/goal mode 與未來 Codex App 功能。
- `opus-4-7`、`opus-4-8`、`sonnet-4-6`、`haiku-4-6`：呼叫 Claude CLI，使用 `--no-session-persistence`、空 MCP config、停用 slash commands、禁止 Claude 原生工具執行。`opus4.7`、`opus4.8`、`sonnet4.6`、`haiku4.6` 可作為相容 alias，但 catalog slug 保留 Codex 已驗證可解析的 hyphen form。
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

- Codex App 在 Responses request 內提供的 `tools` schema 是唯一工具來源。
- Gateway 把當次 `tools` schema 轉成 prompt bridge 說明，外部模型只能回工具意圖 JSON。
- Gateway 驗證工具名稱必須存在於當次 request；不存在就回明確錯誤，不臆造工具。
- Gateway 把工具意圖轉成 Responses `function_call` event；Codex App 才是唯一工具執行者。
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
mkdir -p "$HOME/.codex/backups/model-gateway-v3-$TS"
cp "$HOME/.codex/config.toml" "$HOME/.codex/backups/model-gateway-v3-$TS/config.toml"
cp "$HOME/.codex/state_5.sqlite" "$HOME/.codex/backups/model-gateway-v3-$TS/state_5.sqlite"
cp "$HOME/.codex/models_cache.json" "$HOME/.codex/backups/model-gateway-v3-$TS/models_cache.json" 2>/dev/null || true
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

`scripts/live-verify-codex-gateway.sh` 會呼叫 `scripts/app-server-same-thread-smoke.js` 驗證同一條 app-server thread 可依序跑 `gpt-5.5 -> opus-4-7 -> opus-4-8 -> sonnet-4-6 -> haiku-4-6 -> gpt-5.5`，且四個 Claude slug 都能讀到 GPT 前一輪放入的驗收碼。
完整驗收不得設定 `RUN_CLAUDE_SMOKE=0` 或 `RUN_SAME_THREAD_SMOKE=0`；跳過模式只用於 quota reset 前確認非 Claude 路徑沒有退化。

Catalog：

```bash
curl -fsS http://127.0.0.1:4177/v1/models \
  | jq -r '.models[]? | select(.slug|test("^(gpt-5.5|opus-4-7|opus-4-8|sonnet-4-6|haiku-4-6|grok-build)$")) | [.slug,.display_name,.capabilities.backend,.capabilities.codex_tools] | @tsv'

codex debug models -c model_provider='"model_gateway"' \
  | jq -r '.models[]?.slug' \
  | rg '^(gpt-5\.5|opus-4-7|opus-4-8|sonnet-4-6|haiku-4-6)$'
```

Claude slug smoke：

```bash
for model in opus-4-7 opus-4-8 sonnet-4-6 haiku-4-6; do
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
- 第一個 `turn/start` 用 `model: "gpt-5.5"` 成功。
- 同一個 `threadId` 後續 `turn/start` 分別用 `opus-4-7`、`opus-4-8`、`sonnet-4-6`、`haiku-4-6` 成功讀到前文，最後再切回 `gpt-5.5` 成功。

## 失敗處理

- `Model Gateway received gpt-5.5, but GPT subscription passthrough is not implemented`：gateway 還在舊版，必須補 GPT proxy，不可把預設 provider 切回 per-model/provider 分派系。
- `codex debug models` 只剩 GPT：先看 gateway `/v1/models` 是否正確，再看 catalog JSON 欄位型別是否讓 Codex parse fallback。
- Claude 只回文字不能用工具：看 `/healthz` 的 Claude `codex_tools` 是否仍是 `not_implemented`，或 request 是否真的帶 `tools` schema。
- Codex App 對 `127.0.0.1:4177/v1/responses` 顯示 `stream disconnected before completion` 並反覆 `Reconnecting... 1/5→5/5`：先看 gateway 是否仍在舊 2MB body cap。修：更新 runtime 到含 `GATEWAY_MAX_BODY_BYTES` 的版本，預設 64MB；超限要回 `413 request body too large`，不可 `req.destroy()` reset socket。重啟：`launchctl kickstart -k gui/$(id -u)/com.$(id -un).codex-model-gateway`。
- Claude/Grok session limit 或未登入時出現同樣 reconnect loop：gateway 把 backend limit/auth 當 `response.failed` 送出，Codex App 會 retry。修：更新 runtime 到「backend notice completes visibly」版本；此時 UI 應收到一則 assistant 訊息說明 limit/auth，而不是 `response.failed`。
- 重 turn（ultrawork + 1M-context Claude）跑幾分鐘後 `stream disconnected` / `Reconnecting`，但 body 沒超 cap、gateway 也沒崩：成因是 buffered backend（`sse_after_backend_completion`）在 `await runClaude` 期間零 byte 送出，Codex App idle timeout 先斷線；且 `CLAUDE_TIMEOUT_MS` 預設 2 分鐘會把長 turn SIGKILL。修：runtime 在 stream await 期間每 `GATEWAY_HEARTBEAT_MS`（預設 15s）送 SSE 註解 keepalive 保活（`finally` 清 interval）；plist 把 `CLAUDE_TIMEOUT_MS` 拉到 600000、`GROK_TIMEOUT_MS` 300000。安裝器已內建這些預設並可用同名 env 覆寫。
- 重度 thread 撞 `ran out of room in the model's context window`：catalog 把 Claude context_window 報成 200K 而 Codex App 依此擋。修：對 1M-capable slug（如 opus-4-8）在 `claudeRoutes` 加 `context_window: 1000000` 並把 `[1m]` 變體放 candidates 第一個（advertise 與後端必須一致）；既有 thread 已固化上限，要開新 thread 才生效。
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

## GitHub / Handoff Hygiene

提交 v3 到 GitHub 前必須檢查：

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
