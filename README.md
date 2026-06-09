# Codex App Model Gateway (v4)

讓 Codex App 只用**單一 provider** `model_gateway`，在**同一條 thread 內自由切換 GPT / Claude（含 Fable5）/ Grok / MiniMax**——只切 `model`，不切 provider。不修改 signed Codex App bundle。

Use a **single provider** `model_gateway` for Codex App, and switch between **GPT / Claude (including Fable5) / Grok / MiniMax** inside the same thread by changing only the `model`, not the provider. No patching of the signed Codex App bundle.

## v4 highlights

- Adds `fable-5` / `fable5` as a Claude-family premium route backed by the Claude CLI candidate `claude-fable-5`.
- Keeps the one-provider design: select `model_gateway` once, then switch `model` inside a thread.
- Carries long-turn hardening for heavy multi-model work: semantic `response.in_progress` heartbeats, clean `413` for oversized bodies, and safe GPT passthrough cancellation.

## Companion project / 搭配專案

This repo is designed to pair with **[open-ultrawork](https://github.com/JNSlayer2/open-ultrawork)**.

- **`codex-app-model-gateway`** is the **connection layer**: it helps an AI agent take Codex App and accurately turn it into a runtime that can route into other AI brands and models.
- **`open-ultrawork`** is the **workflow layer**: it defines how to use those connected models for cross-vendor Dynamic Workflows, adversarial validation, and cost-optimized heavy-project execution.

In short:

> `codex-app-model-gateway` makes Codex App **able to connect to other AI models**.  
> `open-ultrawork` tells you **how to use those models together well**.

本 repo 是跟 **[open-ultrawork](https://github.com/JNSlayer2/open-ultrawork)** 搭配使用的一組 skill。

- **`codex-app-model-gateway`** 是**接入層**：讓你的 AI 拿到之後，可以比較準確地把 Codex App 改良成能接入他牌 AI 模型的環境。
- **`open-ultrawork`** 是**工作流層**：定義怎麼把這些接進來的模型拿來做多品牌 Dynamic Workflows、對抗驗證，以及重專案下的省錢分工。

簡單講：

> `codex-app-model-gateway` 讓 Codex App **接得到其他模型**。  
> `open-ultrawork` 告訴你 **接進來之後怎麼一起協作才對**。

例如，如果未來某個模型或 adapter 被接進 gateway，像 Minimax 這類外部模型就有機會在 Codex App 這個工作流裡使用到同一套 request-scoped tools、computer use 與多模型分工邏輯，形成真正可落地的跨品牌協作。

> **免責聲明 / Disclaimer**：本工具讓你在自己付費的 Codex App 內把模型切到 Claude / Grok / MiniMax，並讓 GPT 透過你**自己的** ChatGPT 訂閱 session 繼續運作。它只代理「你自己已登入」的 session，不分發、不竊取任何憑證。但「以本機 proxy 轉發 ChatGPT 訂閱 session」可能牴觸 OpenAI ChatGPT 訂閱條款（訂閱條款對自動化／代理／非官方介面通常比 API 條款更嚴）；Claude CLI / Grok CLI 的包裝亦各受其供應商條款約束。**是否使用、是否合規由你自負**，請先自行確認 OpenAI / Anthropic / xAI 當前條款。private-first，公開散布前自評帳號風險。工具按「現狀（as-is）」提供，無任何擔保。

## 一鍵安裝（拿到就能裝）

## Quick install

The runtime is already included in `runtime/`, and the installer auto-detects it. **No manual path setup is required.**

runtime 已隨 skill 附在 `runtime/`，安裝器會自動找到，**不需手動指定路徑**。

```bash
# 0) dry-run：只讀，列出本機缺的 CLI / 登入 / CODEX_HOME 雷（不改任何東西）
bash scripts/install-codex-gateway.sh --preflight

# 1) 安裝／修復：偵測本機 node/claude/grok/codex 絕對路徑 → 寫 plist + 單一 provider config
#    → 備份並合併未封存 thread provider，避免左側專案列表顯示「沒有聊天」→ 載入 → 驗收
bash scripts/install-codex-gateway.sh

# 2) 補登入（只有這兩步是人類互動，AI 代理不能代登；preflight 會告訴你缺哪個）
codex login            # GPT passthrough 需要
grok login --oauth     # grok-build 需要（選用）

# 3) 驗收（exit 0 = 成功）；--full 跑同 thread 真實切換（花 Claude quota）
bash scripts/post-update-check.sh
bash scripts/post-update-check.sh --full
```

需要 `claude` / `grok` 路由就先各自安裝 Claude Code CLI / Grok CLI or the configured MiniMax endpoint；沒裝也能只跑 GPT + 已裝的部分。安裝器相容 macOS 內建 bash 3.2、idempotent、會備份、不碰 signed app bundle。安裝器會在切到 `model_gateway` 後，備份並合併未封存 `openai` threads；這是為了避免 Codex App sidebar 只列目前 provider，讓舊專案看似沒有聊天。

If you want Claude, Grok, or MiniMax routes, install Claude Code CLI or Grok CLI first. If they are not installed, you can still run GPT and whichever routes are available. The installer is idempotent, macOS bash 3.2 compatible, makes backups first, and does not touch the signed app bundle.

**Codex App 更新後切換失效**：先跑步驟 3 定位，再視需要重跑步驟 1。gateway 是 launchd 獨立進程，App 更新殺不掉它。

If model switching breaks after a Codex App update, run step 3 first to diagnose, then rerun step 1 if needed. The gateway runs as its own launchd process, so normal app updates do not kill it.

## 快速更新 / Quick update

已 clone 的 checkout（AI agent 友善,exit 0 = 成功）:

```bash
# 安全模式:pull + 離線自檢(不碰 auth / config / launchd / 運行中 gateway)
bash scripts/update-skill.sh

# 套用模式:再跑 idempotent 安裝器(備份後重寫 plist/config)+ 驗收
bash scripts/update-skill.sh --apply
```

For AI install agents: run the safe mode first; only pass `--apply` when the
human wants the running gateway/config refreshed. Judge success by exit code.

## API spend policy

多模型協作預設不得使用按量 API fan-out。內建 GPT 路由是 ChatGPT subscription passthrough，Claude/Grok 走 CLI/OAuth；未來新增 Minimax、本地 OpenAI-compatible 或其他 API adapter 時，必須先進白名單並取得人類確認。

Allowed API classes are:

- `local-openai-compatible` — local/LAN Ollama, LM Studio, vLLM, llama.cpp server, or equivalent non-metered local endpoint.
- `minimax-near-unlimited-api` — Minimax or equivalent near-unlimited/low-risk quota plan confirmed by the human user.
- `user-approved-api:<provider>/<model>` — explicitly approved for this task, with endpoint/runtime, billing model, budget cap, and stop condition.

The gateway exposes this via `/healthz.api_spend_policy`. `GATEWAY_API_MODEL_ALLOWLIST` may list approved classes for diagnostics; it does not automatically enable any API adapter.

## 內容

## Contents

- `SKILL.md`：完整架構、一鍵部署/維修、完成定義、不可破壞邊界、失敗處理、回滾、迭代紀錄。
- `runtime/`：gateway 本體（`server.js` + `package.json` + `test/`，零外部相依，`npm test` 走 node 內建）。
- `scripts/install-codex-gateway.sh`：偵測路徑的一鍵安裝/修復器（`--preflight` 為只讀 dry-run）。
- `scripts/post-update-check.sh`：更新後/維修驗收（read-only；`--full` 跑同 thread；含 sidebar provider coherence）。
- `scripts/readonly-diagnose-codex-gateway.sh`：只讀診斷摘要。
- `scripts/migrate-sidebar-threads-to-gateway.sh`：一次性備份並合併未封存 `openai` threads 到 `model_gateway`，修復專案列表「沒有聊天」。
- `scripts/live-verify-codex-gateway.sh` + `scripts/app-server-same-thread-smoke.js`：完整 live 驗收（同 thread `gpt → 5×Claude → gpt` 上下文接續）。
- `reports/`、`references/`：回報模板與**抽象化**事故教訓（不含本機 state / logs / 逆向細節）。

- `SKILL.md`: full architecture, deployment/repair flow, definition of done, non-destructive boundaries, failure handling, rollback, and iteration notes.
- `runtime/`: the gateway runtime (`server.js` + `package.json` + `test/`), with zero external runtime dependencies and tests runnable via built-in Node.
- `scripts/install-codex-gateway.sh`: one-shot installer/repair script with path detection (`--preflight` is read-only).
- `scripts/post-update-check.sh`: post-update or post-repair verification (`--full` runs same-thread live switching; includes sidebar provider coherence).
- `scripts/readonly-diagnose-codex-gateway.sh`: read-only diagnostic summary.
- `scripts/migrate-sidebar-threads-to-gateway.sh`: one-time backed-up merge of unarchived `openai` threads into `model_gateway`, fixing sidebar "no chats" after provider switch.
- `scripts/live-verify-codex-gateway.sh` + `scripts/app-server-same-thread-smoke.js`: full live verification for same-thread `gpt → 5×Claude → gpt` continuity.
- `reports/`, `references/`: report templates and **abstracted** incident lessons only, without local state, logs, or reverse-engineering details.

## 資訊安全規則

## Security / handoff hygiene

不得提交 token、auth、SQLite、models cache、完整 rollout/logs、私有 thread id、私有截圖、本機絕對路徑、signed app bundle patch、renderer asset names、minified snippets、signature/repair bypass。交接只給抽象流程、驗收命令、capability matrix、可重現測試與 redacted summary；本機 state 只留本機備份。

Do not commit tokens, auth files, SQLite databases, model caches, full rollouts/logs, private thread IDs, private screenshots, local absolute paths, signed app bundle patches, renderer asset names, minified snippets, or signature/repair bypass details. Handoffs should contain only abstract workflow, verification commands, capability matrix, reproducible tests, and redacted summaries. Local state stays local.
