[English](./README.md) | [繁體中文](./README-zh-tw.md) 

---

# 悠子的文字聊天翻修

為提升純文字跑團遊戲體驗而製作的 Foundry VTT 模組。主要功能包含以場景為基礎的對話分頁、發言頭像管理、簡易的文字訊息格式與編輯、文字訊息紀錄導出等。

這是個太過思念凍豆腐（どどんとふ/DodontoF）文字對話功能的跑團玩家而寫出來的東西。

https://github.com/user-attachments/assets/663b184d-619a-4c9f-a43c-83436fde18b1

## 特色

* **對話分頁**: 基於場景的對話分頁，讓玩家清楚的知道目前在進行哪一個場景的對話。
    * **推薦搭配**: 推薦搭配 [Monk's Scene Navigation](https://foundryvtt.com/packages/monks-scene-navigation) 進行個別玩家的場景可見權限管理，以達到更好的分頁權限區分。（我們可以有限定某幾位玩家的秘密小房間了！）
* **發言頭像管理**: 上傳圖片後，可在模組的頭像選擇器選擇發言頭像的備選，提供快速切換頭像與作為行內表符插入的功能
* **新文字訊息提醒**: 包含可自訂的音效提示與分頁上的紅點視覺提示。
* **訊息記錄導出**: 能導出便於閱讀與保存的文字訊息紀錄檔案。
* **打字中提示**: 即時顯示誰正在打字中。
* **「請等一下」按鈕**: 讓打字搶話不再成為問題，按按鈕讓大家知道該等你。
* **一鍵馬賽克發言者**: 文字團玩家都很愛擷圖，一個按鈕讓你不用一一遮擋發言者。


## 安裝

您可以使用 FVTT 中提供的 Manifest 網址安裝本模組。

1. 打開 Foundry VTT 的設定畫面。
2. 點擊「附加模組」分頁。
3. 點擊「安裝模組」按鈕。
4. 將下方的網址貼入「Manifest 網址」欄位：
   ```text
   https://github.com/YuukoTRPG/yuuko-chat-interface-overhaul/releases/latest/download/module.json
   ```
5. 點擊「安裝」。

## 相容性

本模組僅在 `Foundry VTT Version 13` 版本中進行測試，不保證其他版本相容性。

對於一些修改訊息樣式的系統與模組，可能會有畫面顯示的問題。

## 問題回報

如果您在使用本模組中發現了任何問題，您可以在本倉庫發送 issue，並盡量提供以下資訊。
1. 您的 FVTT 與模組版本。
2. 問題的詳細情況，有擷圖或影片更好。
3. 復現問題的流程。
4. 瀏覽器開發者工具主控台(F12)的任何錯誤訊息。

悠子是以業餘時間製作這個模組，所以不見得會馬上處理。若您真的很有迫切需求，可以透過信箱(yuukotrpg@gmail.com)或以下方式聯繫悠子。

### 已知問題
- 與`Dice So Nice`並用時，必須開啟`Dice So Nice`設定中的「立即顯示聊天訊息」，否則擲骰結果不會顯示。

## 聯繫方式
<a href="https://www.facebook.com/YuukoTRPG" target="_blank" rel="noopener noreferrer">
    <img src="https://cdn.simpleicons.org/facebook" alt="Facebook" width="32" height="32" 
         style="background-color: silver; padding: 4px; border-radius: 8px;">
</a>
<a href="https://x.com/YuukoTrpg" target="_blank" rel="noopener noreferrer">
    <img src="https://cdn.simpleicons.org/x" alt="X" width="32" height="32" 
         style="background-color: silver; padding: 4px; border-radius: 8px;">
</a>
<a href="https://www.threads.com/@yuuko_trpg" target="_blank" rel="noopener noreferrer">
    <img src="https://cdn.simpleicons.org/threads" alt="Threads" width="32" height="32" 
         style="background-color: silver; padding: 4px; border-radius: 8px;">
</a>
<a href="https://www.plurk.com/victor324" target="_blank" rel="noopener noreferrer">
    <img src="https://cdn.simpleicons.org/plurk" alt="Plurk" width="32" height="32" 
         style="background-color: silver; padding: 4px; border-radius: 8px;">
</a>
<a href="https://linktr.ee/yuuko_trpg" target="_blank" rel="noopener noreferrer">
    <img src="https://cdn.simpleicons.org/linktree" alt="Linktree" width="32" height="32" 
         style="background-color: silver; padding: 4px; border-radius: 8px;">
</a>

- <img src="https://cdn.simpleicons.org/discord" alt="Discord" width="16" height="16"> Discord：`yuuko_trpg`
- 信箱：`yuukotrpg@gmail.com`

悠子的母語是繁體中文，也能夠緩慢的閱讀英文與日文，但無法閱讀其他語言。

## 贊助
雖然並非必要，但如果您喜歡這個模組、對您的跑團體驗有幫助，您可以從以下管道贊助悠子，悠子會誠心感謝您。

<table>
  <tr>
    <td align="center" style="border: none;">
      <a href="https://www.patreon.com/YuukoTRPG" target="_blank">
        <img src="https://cdn.simpleicons.org/Patreon/FFFFFF" alt="Patreon" width="48" height="48">
      </a>
    </td>
    <td style="border: none;">
      <a href="https://www.patreon.com/YuukoTRPG" target="_blank" style="text-decoration: none; color: inherit;">
        <h2>Patreon</h2>
      </a>
    </td>
  </tr>
</table>

## AI 使用聲明

本模組在以下部分使用 AI 生成輔助。
* **程式碼**：部分程式碼由 AI 輔助生成。
* **在地化**：除繁體中文以外，目前的語系檔案皆由 AI 翻譯。

## 授權條款

本模組依據 [MIT License](./LICENSE) 授權條款發佈。

### 第三方素材
   * 本模組內建的提示音效檔案（位於 `./sounds/page.mp3`）源自已停止開發的日本 TRPG 跑團軟體凍豆腐（DodontoF/どどんとふ）。該素材適用其原始專案的 Modified BSD License。
   * 來源網址：http://www.dodontof.com | [授權條款來源](http://www.dodontof.com/DodontoF/README.html#aboutLicense)
---
