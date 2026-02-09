/**
 * scripts/chat-exporter.js
 * 負責處理聊天紀錄的導出、圖片 Base64 轉換與 HTML 檔案生成
 */

import { enrichMessageHTML } from "./chat-helpers.js";
import { MODULE_ID } from "./config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// --- 1. 導出設定視窗 (Dialog) ---
// (這部分保持不變，與之前相同)
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
        const tabs = [
            { id: "ooc", label: "OOC (通用頻道)", checked: true }
        ];

        game.scenes.forEach(s => {
            tabs.push({ 
                id: s.id, 
                label: s.navName || s.name, 
                checked: true 
            });
        });

        return { tabs };
    }

    static async onDoExport(event, target) {
        const formData = new FormData(event.target.closest("form"));
        const selectedTabs = [];
        
        for (const [key, value] of formData.entries()) {
            if (value === "on") selectedTabs.push(key);
        }

        if (selectedTabs.length === 0) {
            ui.notifications.warn("請至少選擇一個要導出的分頁");
            return;
        }

        this.close();
        ui.notifications.info("正在準備導出，包含 CSS 樣式與圖片轉換，請稍候...");
        
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
     * [新增] 抓取並合併關鍵 CSS 檔案
     */
    async _getCombinedCSS() {
        // 定義我們要抓取的 CSS 清單
        const cssFiles = [
            "css/style.css",                                      // 1. FVTT 核心樣式 (V13 通常是 style.css)
            "fonts/fontawesome/css/all.min.css",                  // 2. FontAwesome 圖示
            `systems/${game.system.id}/${game.system.id}.css`,    // 3. 遊戲系統樣式 (例如 dnd5e.css)
            `modules/${MODULE_ID}/styles/module.css`              // 4. 本模組樣式
        ];

        let combinedCSS = "";

        // 使用 Promise.all 並行下載所有 CSS
        const responses = await Promise.all(cssFiles.map(async (path) => {
            try {
                const res = await fetch(path);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                let text = await res.text();
                
                // [小優化] 加上註解方便除錯
                return `\n/* --- Source: ${path} --- */\n` + text;
            } catch (err) {
                console.warn(`[YCIO] 無法讀取 CSS: ${path}`, err);
                return ""; // 讀取失敗就回傳空字串，不讓程式崩潰
            }
        }));

        return responses.join("\n");
    }

    /**
     * 主流程：生成並下載
     */
    async generateAndDownload(selectedTabs) {
        // 1. 讀取並合併所有 CSS
        this.cssContent = await this._getCombinedCSS();

        // 2. 準備 HTML 結構
        const dateStr = new Date().toISOString().split('T')[0];
        
        // 這裡我們加上 .vtt.game class 到 body，模擬 FVTT 環境
        let fullHtml = `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <title>聊天紀錄導出 - ${dateStr}</title>
    <style>
        /* 嵌入合併後的 CSS */
        ${this.cssContent}
        
        /* --- 導出檔案的修正樣式 (Override) --- */
        
        /* 強制重置 body 背景與高度 */
        body { 
            margin: 0; 
            padding: 0; 
            background-color: #303030; /* FVTT 經典深灰底 */
            background-image: url("ui/denim075.png"); /* 嘗試引用 FVTT 材質，離線可能失效，但有背景色當備案 */
            font-family: "Signika", sans-serif; 
            height: 100vh; 
            overflow: hidden; 
        }

        /* 讓外框適應全螢幕 */
        .YCIO-floating-chat-window { 
            position: relative; 
            height: 100%; 
            width: 100%; 
            top: 0; 
            left: 0; 
            border: none; 
            background: rgba(0, 0, 0, 0.5); /* 稍微調暗背景 */
        }

        /* 導航列樣式微調 */
        .export-nav { 
            background: url("ui/denim075.png") repeat; /* 模擬視窗標題列材質 */
            background-color: #222;
            padding: 8px; 
            border-bottom: 2px solid #000; 
            display: flex; 
            gap: 5px; 
            flex-shrink: 0;
            box-shadow: 0 0 10px #000;
        }

        .export-nav button { 
            background: #444; 
            color: #ccc; 
            border: 1px solid #111; 
            padding: 6px 12px; 
            cursor: pointer; 
            border-radius: 4px; 
            font-family: "Signika", sans-serif;
            font-size: 14px;
        }

        .export-nav button:hover {
            background: #555;
            color: #fff;
            border-color: #888;
        }

        .export-nav button.active { 
            background: #f0f0e0; 
            color: #111; 
            font-weight: bold; 
            border: 1px solid #fff;
            box-shadow: 0 0 5px #ffd700;
        }

        .tab-content { display: none; flex: 1; overflow: hidden; height: 100%; }
        .tab-content.active { display: flex; flex-direction: column; }
        
        /* 調整 Log 內距，讓它不要貼邊 */
        #custom-chat-log { flex: 1; overflow-y: auto; padding: 10px 20px; }
    </style>
</head>
<body class="vtt game system-${game.system.id}"> 
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
        function switchTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.export-nav button').forEach(el => el.classList.remove('active'));
            
            const target = document.getElementById('tab-' + tabId);
            if (target) target.classList.add('active');
            
            const btn = document.querySelector('.export-nav button[data-tab="' + tabId + '"]');
            if (btn) btn.classList.add('active');
        }
        
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
        // (此段邏輯保持不變，負責撈取訊息、enrichMessageHTML 和轉 Base64)
        // 為了節省篇幅，這裡省略重複代碼，請保留你原本的 _processMessagesForTab 和 _convertImageToBase64
        // ...
        
        // 只是為了確保上下文，將原本的邏輯貼在下面:
        const allMessages = game.messages.contents;
        const targetMessages = allMessages.filter(msg => {
            const msgSceneId = msg.speaker.scene;
            const msgTokenId = msg.speaker.token;
            if (tabId === "ooc") return !msgTokenId;
            return msgSceneId === tabId && !!msgTokenId;
        });

        const container = document.createElement("div");

        for (const msg of targetMessages) {
            const html = await msg.renderHTML();
            enrichMessageHTML(msg, html); 
            container.appendChild(html);
        }

        const images = Array.from(container.querySelectorAll("img"));
        await Promise.all(images.map(img => this._convertImageToBase64(img)));

        return container.innerHTML;
    }

    async _convertImageToBase64(imgElement) {
        // (此段邏輯保持不變)
        const src = imgElement.src;
        if (src.startsWith("data:")) return;

        try {
            const image = new Image();
            image.crossOrigin = "Anonymous"; 
            image.src = src;

            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = reject;
            });

            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);

            imgElement.src = canvas.toDataURL("image/png");
            imgElement.removeAttribute("srcset");
            
        } catch (err) {
            console.warn(`[YCIO] 圖片轉碼失敗: ${src}`, err);
        }
    }
}