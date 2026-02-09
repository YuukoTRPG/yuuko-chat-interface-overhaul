/**
 * scripts/chat-exporter.js
 * 負責處理聊天紀錄的導出、圖片 Base64 轉換與 HTML 檔案生成
 */

import { enrichMessageHTML } from "./chat-helpers.js";
import { MODULE_ID } from "./config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// --- 1. 導出設定視窗 (Dialog) ---
export class ChatExportDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "YCIO-export-dialog",
        tag: "form",
        window: { title: "導出聊天紀錄", icon: "fas fa-file-export", resizable: false },
        position: { width: 400, height: "auto" },
        actions: {
            doExport: ChatExportDialog.onDoExport
        }
    };

    static PARTS = {
        form: { template: "modules/yuuko-chat-interface-overhaul/templates/export-dialog.hbs" }
    };

    async _prepareContext(_options) {
        // 準備場景列表供 GM 勾選
        // 包含 OOC 與所有場景 (不管權限，因為是 GM)
        const tabs = [
            { id: "ooc", label: "OOC (通用頻道)", checked: true }
        ];

        game.scenes.forEach(s => {
            tabs.push({ 
                id: s.id, 
                label: s.navName || s.name, 
                checked: true // 預設全選
            });
        });

        return { tabs };
    }

    static async onDoExport(event, target) {
        // 取得表單資料
        const formData = new FormData(event.target.closest("form"));
        const selectedTabs = [];
        
        // 解析勾選的項目
        for (const [key, value] of formData.entries()) {
            if (value === "on") selectedTabs.push(key);
        }

        if (selectedTabs.length === 0) {
            ui.notifications.warn("請至少選擇一個要導出的分頁");
            return;
        }

        // 關閉視窗並開始執行導出
        this.close();
        ui.notifications.info("正在準備導出，包含圖片轉換可能需要一些時間，請稍候...");
        
        const exporter = new ChatExporter();
        await exporter.generateAndDownload(selectedTabs);
    }
}

// --- 2. 導出核心邏輯 (Exporter) ---
class ChatExporter {
    constructor() {
        this.cssContent = "";
    }

    /**
     * 主流程：生成並下載
     */
    async generateAndDownload(selectedTabs) {
        // 1. 讀取模組的 CSS 檔案內容
        try {
            const cssResponse = await fetch(`modules/${MODULE_ID}/styles/module.css`);
            this.cssContent = await cssResponse.text();
        } catch (e) {
            console.error("無法讀取 CSS", e);
            this.cssContent = "";
        }

        // 2. 準備 HTML 結構
        const dateStr = new Date().toISOString().split('T')[0];
        let fullHtml = `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <title>聊天紀錄導出 - ${dateStr}</title>
    <style>
        /* 重置基礎樣式，模擬 FVTT 環境 */
        body { margin: 0; padding: 0; background-color: #303030; font-family: "Signika", sans-serif; height: 100vh; overflow: hidden; }
        /* 嵌入模組 CSS */
        ${this.cssContent}
        
        /* 導出專用樣式調整 */
        .YCIO-floating-chat-window { position: relative; height: 100%; width: 100%; top: 0; left: 0; border: none; }
        .export-nav { background: #222; padding: 10px; border-bottom: 1px solid #555; display: flex; gap: 5px; flex-shrink: 0;}
        .export-nav button { background: #444; color: #ccc; border: 1px solid #555; padding: 5px 10px; cursor: pointer; border-radius: 4px; }
        .export-nav button.active { background: #eee; color: #111; font-weight: bold; }
        .tab-content { display: none; flex: 1; overflow: hidden; height: 100%; }
        .tab-content.active { display: flex; flex-direction: column; }
        #custom-chat-log { flex: 1; overflow-y: auto; padding: 10px; }
    </style>
</head>
<body>
    <div class="YCIO-floating-chat-window">
        <div class="export-nav" id="nav-container">
            ${selectedTabs.map(tabId => {
                const label = tabId === "ooc" ? "OOC" : (game.scenes.get(tabId)?.navName || game.scenes.get(tabId)?.name || tabId);
                return `<button onclick="switchTab('${tabId}')" data-tab="${tabId}">${label}</button>`;
            }).join("")}
        </div>

        <div class="chat-content">
`;

        // 3. 遍歷分頁，生成訊息內容
        for (const tabId of selectedTabs) {
            const messagesHtml = await this._processMessagesForTab(tabId);
            fullHtml += `
            <div id="tab-${tabId}" class="tab-content">
                <ol id="custom-chat-log" class="chat-log">
                    ${messagesHtml}
                </ol>
            </div>`;
        }

        // 4. 結尾與腳本
        fullHtml += `
        </div>
    </div>
    <script>
        // 簡單的分頁切換邏輯
        function switchTab(tabId) {
            // 隱藏所有分頁
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.export-nav button').forEach(el => el.classList.remove('active'));
            
            // 顯示目標分頁
            const target = document.getElementById('tab-' + tabId);
            if (target) target.classList.add('active');
            
            const btn = document.querySelector('.export-nav button[data-tab="' + tabId + '"]');
            if (btn) btn.classList.add('active');
        }
        
        // 預設開啟第一個分頁
        const firstTab = "${selectedTabs[0]}";
        if (firstTab) switchTab(firstTab);
    </script>
</body>
</html>`;

        // 5. 觸發下載
        const blob = new Blob([fullHtml], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `chat-log-${dateStr}.html`;
        a.click();
        URL.revokeObjectURL(url);
        
        ui.notifications.info("導出完成！");
    }

    /**
     * 處理單一分頁的訊息：撈取 -> 渲染 -> 圖片轉碼
     */
    async _processMessagesForTab(tabId) {
        // 1. 撈取訊息 (複製 floating-chat.js 的過濾邏輯，但不限制數量)
        const allMessages = game.messages.contents;
        const targetMessages = allMessages.filter(msg => {
            // GM 導出時，通常希望能看到所有訊息，但也可以加上 msg.visible 判斷
            // 這裡我們假設 GM 想備份所有看得到的
            const msgSceneId = msg.speaker.scene;
            const msgTokenId = msg.speaker.token;

            if (tabId === "ooc") return !msgTokenId;
            return msgSceneId === tabId && !!msgTokenId;
        });

        // 2. 建立一個暫存的容器來處理 DOM
        const container = document.createElement("div");

        for (const msg of targetMessages) {
            // 渲染原始 HTML
            const html = await msg.renderHTML();
            // 注入頭像與 YCIO 結構 (重複利用既有函式)
            enrichMessageHTML(msg, html); // 此時 html 已經變成 <li class="message ...">...</li>

            container.appendChild(html);
        }

        // 3. 【關鍵】將容器內的所有圖片轉為 Base64
        // 這一步最花時間，我們使用 Promise.all 並行處理
        const images = Array.from(container.querySelectorAll("img"));
        await Promise.all(images.map(img => this._convertImageToBase64(img)));

        return container.innerHTML;
    }

    /**
     * 將 img 標籤的 src 替換為 Base64
     */
    async _convertImageToBase64(imgElement) {
        const src = imgElement.src;
        // 略過已經是 base64 的圖片
        if (src.startsWith("data:")) return;

        try {
            // 建立一個 Image 物件來載入圖片
            const image = new Image();
            image.crossOrigin = "Anonymous"; // 嘗試處理跨域問題
            image.src = src;

            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = reject;
            });

            // 使用 Canvas 繪製並轉碼
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);

            // 替換原本 DOM 的 src
            imgElement.src = canvas.toDataURL("image/png");
            // 移除 srcset 避免瀏覽器優先使用舊連結
            imgElement.removeAttribute("srcset");
            
        } catch (err) {
            console.warn(`[YCIO] 圖片轉碼失敗 (可能因跨域限制): ${src}`, err);
            // 失敗時保持原連結，不中斷流程
        }
    }
}