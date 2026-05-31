# Codex App Model Gateway (v3)

讓 Codex App 只用**單一 provider** `model_gateway`，在**同一條 thread 內自由切換 GPT / Claude / Grok**——只切 `model`，不切 provider。不修改 signed Codex App bundle。

Use a **single provider** `model_gateway` for Codex App, and switch between **GPT / Claude / Grok inside the same thread** by changing only the `model`, not the provider. No patching of the signed Codex App bundle.

> **免責聲明 / Disclaimer**：本工具讓你在自己付費的 Codex App 內把模型切到 Claude / Grok，並讓 GPT 透過你**自己的** ChatGPT 訂閱 session 繼續運作。它只代理「你自己已登入」的 session，不分發、不竊取任何憑證。但「以本機 proxy 轉發 ChatGPT 訂閱 session」可能牴觸 OpenAI ChatGPT 訂閱條款（訂閱條款對自動化／代理／非官方介面通常比 API 條款更嚴）；Claude CLI / Grok CLI 的包裝亦各受其供應商條款約束。**是否使用、是否合規由你自負**，請先自行確認 OpenAI / Anthropic / xAI 當前條款。private-first，公開散布前自評帳號風險。工具按「現狀（as-is）」提供，無任何擔保。

## 一鍵安裝（拿到就能裝）

## Quick install

The runtime is already included in `runtime/`, and the installer auto-detects it. **No manual path setup is required.**

runtime 已隨 skill 附在 `runtime/`，安裝器會自動找到，**不需手動指定路徑**。

```bash
# 0) dry-run：只讀，列出本機缺的 CLI / 登入 / CODEX_HOME 雷（不改任何東西）
bash scripts/install-codex-gateway.sh --preflight

# 1) 安裝／修復：偵測本機 node/claude/grok/codex 絕對路徑 → 寫 plist + 單一 provider config → 載入 → 驗收
bash scripts/install-codex-gateway.sh

# 2) 補登入（只有這兩步是人類互動，AI 代理不能代登；preflight 會告訴你缺哪個）
codex login            # GPT passthrough 需要
grok login --oauth     # grok-build 需要（選用）

# 3) 驗收（exit 0 = 成功）；--full 跑同 thread 真實切換（花 Claude quota）
bash scripts/post-update-check.sh
bash scripts/post-update-check.sh --full
```

需要 `claude` / `grok` 路由就先各自安裝 Claude Code CLI / Grok CLI；沒裝也能只跑 GPT + 已裝的部分。安裝器相容 macOS 內建 bash 3.2、idempotent、會備份、不碰 signed app bundle。

If you want Claude or Grok routes, install Claude Code CLI or Grok CLI first. If they are not installed, you can still run GPT and whichever routes are available. The installer is idempotent, macOS bash 3.2 compatible, makes backups first, and does not touch the signed app bundle.

**Codex App 更新後切換失效**：先跑步驟 3 定位，再視需要重跑步驟 1。gateway 是 launchd 獨立進程，App 更新殺不掉它。

If model switching breaks after a Codex App update, run step 3 first to diagnose, then rerun step 1 if needed. The gateway runs as its own launchd process, so normal app updates do not kill it.

## 內容

## Contents

- `SKILL.md`：完整架構、一鍵部署/維修、完成定義、不可破壞邊界、失敗處理、回滾、迭代紀錄。
- `runtime/`：gateway 本體（`server.js` + `package.json` + `test/`，零外部相依，`npm test` 走 node 內建）。
- `scripts/install-codex-gateway.sh`：偵測路徑的一鍵安裝/修復器（`--preflight` 為只讀 dry-run）。
- `scripts/post-update-check.sh`：更新後/維修驗收（read-only；`--full` 跑同 thread）。
- `scripts/readonly-diagnose-codex-gateway.sh`：只讀診斷摘要。
- `scripts/live-verify-codex-gateway.sh` + `scripts/app-server-same-thread-smoke.js`：完整 live 驗收（同 thread `gpt → 4×Claude → gpt` 上下文接續）。
- `reports/`、`references/`：回報模板與**抽象化**事故教訓（不含本機 state / logs / 逆向細節）。

- `SKILL.md`: full architecture, deployment/repair flow, definition of done, non-destructive boundaries, failure handling, rollback, and iteration notes.
- `runtime/`: the gateway runtime (`server.js` + `package.json` + `test/`), with zero external runtime dependencies and tests runnable via built-in Node.
- `scripts/install-codex-gateway.sh`: one-shot installer/repair script with path detection (`--preflight` is read-only).
- `scripts/post-update-check.sh`: post-update or post-repair verification (`--full` runs same-thread live switching).
- `scripts/readonly-diagnose-codex-gateway.sh`: read-only diagnostic summary.
- `scripts/live-verify-codex-gateway.sh` + `scripts/app-server-same-thread-smoke.js`: full live verification for same-thread `gpt → 4×Claude → gpt` continuity.
- `reports/`, `references/`: report templates and **abstracted** incident lessons only, without local state, logs, or reverse-engineering details.

## 資訊安全規則

## Security / handoff hygiene

不得提交 token、auth、SQLite、models cache、完整 rollout/logs、私有 thread id、私有截圖、本機絕對路徑、signed app bundle patch、renderer asset names、minified snippets、signature/repair bypass。交接只給抽象流程、驗收命令、capability matrix、可重現測試與 redacted summary；本機 state 只留本機備份。

Do not commit tokens, auth files, SQLite databases, model caches, full rollouts/logs, private thread IDs, private screenshots, local absolute paths, signed app bundle patches, renderer asset names, minified snippets, or signature/repair bypass details. Handoffs should contain only abstract workflow, verification commands, capability matrix, reproducible tests, and redacted summaries. Local state stays local.
