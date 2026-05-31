# Codex App Model Gateway 部署卡關回報模板

請房間 Codex 只回報以下資訊，不要貼 token、auth.json、SQLite dump、完整 log、截圖、私有 thread id、個人帳號或 signed app bundle 內容。

## 目標

- 這台機器要接入哪些模型：
- 是否要求同一條 thread 內切 GPT/Claude/Grok/Minimax：
- 是否必須使用訂閱登入：

## 目前症狀

- Codex App 是否能開啟：
- 模型選單看到什麼：
- 左側專案/thread 是否正常：
- 帳號/登出/外掛入口是否正常：
- 送出訊息時的錯誤文字：

## 只讀診斷輸出

請先跑：

```bash
bash scripts/readonly-diagnose-codex-gateway.sh
```

把輸出貼在這裡。

## 已嘗試動作

- 是否改過 Codex config：
- 是否改過 model cache：
- 是否改過 signed app bundle 或 renderer：
- 是否啟動過 watcher 或 repair script：
- 是否重開過 Codex App：

## 停止條件

若出現以下任一情況，停止修改並回報：

- `requires_openai_auth=true` 不存在。
- 出現 per-model provider block。
- left sidebar/thread 消失。
- 帳號/登出/外掛入口消失。
- gateway health unavailable。
- Claude/Grok/Minimax 請求無限思考或沒有 `response.completed` / `response.failed`。
