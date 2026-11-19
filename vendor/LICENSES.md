# 第三方檔案與授權

## chess.js 1.0.0（vendor/chess.js）

- 來源：https://cdn.jsdelivr.net/npm/chess.js@1.0.0/dist/esm/chess.js
- 專案：https://github.com/jhlywa/chess.js
- 授權：BSD 2-Clause（授權全文在檔案開頭註解）
- Copyright (c) Jeff Hlywa

## 棋子圖（vendor/pieces/*.svg）

- 棋組：cburnett（作者 Colin M.L. Burnett）
- 來源：https://github.com/lichess-org/lila/tree/master/public/piece/cburnett
- 下載網址：https://raw.githubusercontent.com/lichess-org/lila/master/public/piece/cburnett/wN.svg（其餘類推）
- 授權：CC BY-SA 3.0（也可依 GPL v2+ 使用）
- 檔案未修改。若再散布，須保留本註明並以相同授權分享。

## Stockfish.js（vendor/stockfish/）

- 檔案：stockfish-19-lite-single.js、stockfish-19-lite-single.wasm（v19.0.1，2026-10-10 發布）
- 來源：https://github.com/nmrugg/stockfish.js/releases/tag/v19.0.1（Nathan Rugg 的 Stockfish WASM 移植版）
- 原引擎：Stockfish（https://github.com/official-stockfish/Stockfish）
- sha256：js `ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a`；wasm `ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de`
- 授權：GPL-3.0，全文見 vendor/stockfish/Copying.txt。原始碼可在上述 GitHub 取得；檔案未修改。

## 走子／吃子音效（sounds/）

- 來源：JJTaynos，「Chess Pieces Move (Close)」，Freesound #733927（https://freesound.org/people/JJTaynos/sounds/733927/）
- 授權：CC0 1.0（公眾領域）。
- 處理：從原始錄音切出單次落子（約 0.36 秒），150 Hz 高通濾波、音量正規化、結尾淡出。
