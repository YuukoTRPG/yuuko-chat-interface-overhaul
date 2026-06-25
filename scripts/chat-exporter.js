/**
 * scripts/chat-exporter.js
 * 負責處理聊天紀錄的導出、圖片 Base64 轉換與 HTML 檔案生成
 */

import { enrichMessageHTML } from "./chat-helpers.js";
import { MODULE_ID } from "./config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * ============================================
 * 1. 導出設定視窗 (Dialog)
 * ============================================
 */
export class ChatExportDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "YCIO-export-dialog",
        tag: "form",
        window: { title: "YCIO.Exporter.Title", icon: "fas fa-file-export", resizable: true },
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
            { id: "ooc", label: game.i18n.localize("YCIO.Exporter.OOCLabel"), checked: true }
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
            ui.notifications.warn(game.i18n.localize("YCIO.Exporter.WarningNoSelection"));
            return;
        }

        // 關閉視窗並開始執行導出
        this.close();
        ui.notifications.info(game.i18n.localize("YCIO.Exporter.InfoPreparing"));

        const exporter = new ChatExporter();
        await exporter.generateAndDownload(selectedTabs);
    }
}

/**
 * ============================================
 * 2. 導出核心邏輯 (Exporter)
 * ============================================
 */

/** 圖片並行轉碼的批次上限 */
const IMAGE_BATCH_SIZE = 10;

class ChatExporter {
    constructor() {
        this.cssContent = "";
    }

    /**
     * 主流程：生成並下載
     */
    async generateAndDownload(selectedTabs) {
        // 1. 讀取 CSS 內容
        try {
            ui.notifications.info(game.i18n.localize("YCIO.Exporter.InfoDownloadingCSS"));

            // Step A: 先抓全域所有 CSS (包含 Core, System 和其他模組)
            const globalCSS = await this._fetchGlobalCSS();

            // Step B: 強制單獨再抓一次 module.css，確保它的權重贏過前面抓到的任何東西
            let moduleCSS = "";
            try {
                const moduleCSSUrl = new URL(`modules/${MODULE_ID}/styles/module.css`, window.location.origin).href;
                const response = await fetch(moduleCSSUrl);
                if (response.ok) {
                    moduleCSS = this._resolveRelativeUrls(await response.text(), moduleCSSUrl);
                }
            } catch (err) {
                console.warn("[YCIO] 無法單獨讀取 module.css", err);
            }

            // Step C: 組合 (將 module.css 放在最後面)
            this.cssContent = globalCSS + "\n/* --- YCIO Module CSS Priority Override --- */\n" + moduleCSS;

        } catch (e) {
            console.error("無法讀取 CSS", e);
            this.cssContent = "";
        }

        // 2. 捕獲主題狀態與 CSS 變數快照
        const themeState = this._captureThemeState();
        const rootVarsCSS = this._captureRootCSSVariables();
        const chatVarsInline = this._captureChatCSSVariables();

        // 3. 離線化 CSS 中的外部資源 (字型、背景圖等)
        ui.notifications.info(game.i18n.localize("YCIO.Exporter.InfoPreparing"));
        this.cssContent = await this._inlineCSSResources(this.cssContent);

        // 4. 準備 HTML 結構
        const dateStr = new Date().toISOString().split("T")[0];
        let fullHtml = `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <title>${game.i18n.localize("YCIO.Exporter.HtmlTitle")} - ${dateStr}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Signika:wght@300;400;600;700&display=swap" rel="stylesheet">
    <style>
        /* :root CSS 變數快照 (從 FVTT 運行時環境捕獲) */
        ${rootVarsCSS}

        /* 重置基礎樣式，模擬 FVTT 環境 */
        body { margin: 0; padding: 0; font-family: "Signika", sans-serif; height: 100vh; overflow: hidden; }

        /* 嵌入抓取到的所有 CSS */
        ${this.cssContent}
        
        /* 導出專用樣式調整 */
        .YCIO-floating-chat-window { position: relative; height: 100%; width: 100%; top: 0; left: 0; border: none; display: flex; flex-direction: column; }
        .export-nav { background: #222; padding: 10px; border-bottom: 1px solid #555; display: flex; gap: 5px; flex-shrink: 0; flex-wrap: wrap; }
        .export-nav button { background: #444; color: #ccc; border: 1px solid #555; padding: 5px 10px; cursor: pointer; border-radius: 4px; }
        .export-nav button.active { background: #eee; color: #111; font-weight: bold; }
        .tab-content { display: none; flex: 1; overflow: hidden; height: 100%; }
        .tab-content.active { display: flex; flex-direction: column; }
        .tab-content .YCIO-css-mirror { flex: 1; display: flex; flex-direction: column; min-height: 0; height: 100%; }
        .tab-content .chat-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; }
        .tab-content .chat-log { list-style: none; padding: 10px; margin: 0; }
    </style>
</head>
<body>
    <div class="YCIO-floating-chat-window">
        <div class="export-nav" id="nav-container">
            ${selectedTabs.map(tabId => {
            const label = tabId === "ooc" ? game.i18n.localize("YCIO.Exporter.OOCButton") : (game.scenes.get(tabId)?.navName || game.scenes.get(tabId)?.name || tabId);
            return `<button onclick="switchTab('${tabId}')" data-tab="${tabId}">${label}</button>`;
        }).join("")}
        </div>

        <div class="chat-content">
`;

        // 5. 遍歷分頁，生成訊息內容
        for (const tabId of selectedTabs) {
            const messagesHtml = await this._processMessagesForTab(tabId);
            // 每個分頁都包含完整的 CSS 鏡像結構，確保系統 CSS 選擇器能正確命中
            fullHtml += `
            <div id="tab-${tabId}" class="tab-content">
                <div class="YCIO-css-mirror tab sidebar-tab chat-sidebar" style="${chatVarsInline}">
                    <div class="chat-scroll">
                        <ol class="chat-log ${themeState.chatLogClasses}">
                            ${messagesHtml}
                        </ol>
                    </div>
                </div>
            </div>`;
        }

        // 6. 結尾與腳本
        fullHtml += `
        </div>
    </div>
    <script>
        // A. 簡單的分頁切換邏輯
        function switchTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.export-nav button').forEach(el => el.classList.remove('active'));
            
            const target = document.getElementById('tab-' + tabId);
            if (target) target.classList.add('active');
            
            const btn = document.querySelector('.export-nav button[data-tab="' + tabId + '"]');
            if (btn) btn.classList.add('active');
        }

        // B. 通用擲骰展開互動 (Event Delegation)
        // 監聽整個頁面的點擊事件，不用對每個骰子綁定
        document.addEventListener('click', function(e) {
            // 1. 找到被點擊的骰子區塊
            const diceRoll = e.target.closest('.dice-roll');
            if (!diceRoll) return;

            // 2. 標準動作：切換 expanded class (適用於標準系統)
            diceRoll.classList.toggle('expanded');

            // 3. 強制動作：處理像 CoC 這種用 style="display:none" 的北爛系統
            // 搜尋該區塊內常見的隱藏容器 class
            const tooltips = diceRoll.querySelectorAll('.dice-tooltip');
            
            tooltips.forEach(tp => {
                // 如果當前是隱藏的 (檢查行內樣式)
                if (tp.style.display === 'none') {
                    // 清空 display 屬性，讓它回歸 CSS 控制 (通常就會顯示了)
                    tp.style.display = ''; 
                } 
                // 如果當前是顯示的 (且外層已經移除 expanded，手動把它藏回去)
                else if (!diceRoll.classList.contains('expanded')) {
                    tp.style.display = 'none';
                }
            });
        });
        
        // 預設開啟第一個分頁
        const firstTab = "${selectedTabs[0]}";
        if (firstTab) switchTab(firstTab);
    </script>
</body>
</html>`;

        // 7. 觸發下載
        const blob = new Blob([fullHtml], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `chat-log-${dateStr}.html`;
        a.click();
        URL.revokeObjectURL(url);

        ui.notifications.info(game.i18n.localize("YCIO.Exporter.InfoComplete"));
    }

    /**
     * 處理單一分頁的訊息：撈取 -> 渲染 -> 圖片轉碼
     */
    async _processMessagesForTab(tabId) {
        // 1. 撈取訊息 (複製 floating-chat.js 的過濾邏輯，但不限制數量)
        const allMessages = game.messages.contents;
        const targetMessages = allMessages.filter(msg => {
            // GM 導出時，通常希望能看到所有訊息，但也可以加上 msg.visible 判斷，未來再說
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

        // 3. 將容器內的所有圖片轉為 Base64，分批處理以避免記憶體爆炸
        const images = Array.from(container.querySelectorAll("img"));
        await this._convertImagesInBatches(images);

        return container.innerHTML;
    }

    /**
     * 分批將圖片轉為 Base64，避免同時載入過多圖片導致記憶體溢出
     * @param {HTMLImageElement[]} images - 所有需要轉碼的圖片元素
     */
    async _convertImagesInBatches(images) {
        for (let i = 0; i < images.length; i += IMAGE_BATCH_SIZE) {
            const batch = images.slice(i, i + IMAGE_BATCH_SIZE);
            await Promise.all(batch.map(img => this._convertImageToBase64(img)));
        }
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

    /**
     * 抓取當前網頁所有載入的 CSS 內容
     * 同時將 CSS 中的 url() 相對路徑轉為絕對路徑，確保嵌入後資源路徑仍然有效
     */
    async _fetchGlobalCSS() {
        // 1. 抓取所有 <link rel="stylesheet"> 標籤
        const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));

        // 2. 異步並行下載所有 CSS 檔案內容
        const cssPromises = links.map(async (link) => {
            try {
                // 忽略非同源 (CORS) 的外部樣式，避免報錯 (通常 Google Fonts 等會擋)
                // 但 FVTT 本地的樣式 (系統、核心、模組) 都能抓到
                const response = await fetch(link.href);
                if (response.ok) {
                    const cssText = await response.text();
                    // 將 CSS 中的 url() 相對路徑轉為絕對路徑
                    return this._resolveRelativeUrls(cssText, link.href);
                }
            } catch (e) {
                console.warn(`[YCIO] 導出略過無法讀取的 CSS: ${link.href}`);
            }
            return "";
        });

        // 3. 等待全部下載完成並合併成一個大字串
        const allCss = await Promise.all(cssPromises);
        return allCss.join("\n");
    }

    /**
     * 將 CSS 文字中的 url() 相對路徑轉換為絕對路徑
     * @param {string} cssText - 原始 CSS 文字
     * @param {string} baseUrl - 此 CSS 檔案的來源 URL (用作基準路徑)
     * @returns {string} 路徑已被替換為絕對路徑的 CSS 文字
     */
    _resolveRelativeUrls(cssText, baseUrl) {
        // 匹配 url(...) 中的路徑，排除 data: URI 和已是絕對路徑的情況
        // 支援 url("path"), url('path'), url(path) 三種寫法
        return cssText.replace(/url\(\s*(["']?)(?!data:|https?:|\/\/)(.*?)\1\s*\)/gi, (match, quote, rawPath) => {
            try {
                const absoluteUrl = new URL(rawPath, baseUrl).href;
                return `url(${quote}${absoluteUrl}${quote})`;
            } catch {
                // 路徑解析失敗，保持原樣
                return match;
            }
        });
    }

    /**
     * 捕獲當前 FVTT 的主題狀態
     * 鏡像 floating-chat.js 的 _syncTheme() 邏輯
     * @returns {{ chatLogClasses: string }}
     */
    _captureThemeState() {
        const nativeLog = document.querySelector("#chat .chat-log");
        if (nativeLog) {
            return { chatLogClasses: nativeLog.className };
        }
        // 後備方案：根據 FVTT 設定推斷
        const uiConfig = game.settings.get("core", "uiConfig") || {};
        const colorScheme = uiConfig.colorScheme || {};
        const theme = colorScheme.interface || "light";
        return { chatLogClasses: `chat-log plain themed theme-${theme}` };
    }

    /**
     * 捕獲 :root 級別的 CSS 自定義變數快照
     * 掃描所有 stylesheet 中的 :root 規則，收集變數名稱，
     * 然後用 getComputedStyle 取得運算後的值
     * @returns {string} 可直接嵌入 <style> 的 :root { } CSS 字串
     */
    _captureRootCSSVariables() {
        const varNames = new Set();

        // 1. 掃描所有可讀取的 stylesheet，收集 :root 規則中的變數名稱
        for (const sheet of document.styleSheets) {
            try {
                if (!sheet.cssRules) continue;
                for (const rule of sheet.cssRules) {
                    if (rule.selectorText && rule.selectorText.includes(":root")) {
                        for (const prop of rule.style) {
                            if (prop.startsWith("--")) {
                                varNames.add(prop);
                            }
                        }
                    }
                }
            } catch {
                // 跨網域 (CORS) 樣式表讀取限制，跳過
            }
        }

        if (varNames.size === 0) return "";

        // 2. 用 computed style 取得變數的最終計算值
        const rootStyle = getComputedStyle(document.documentElement);
        const declarations = [];
        for (const name of varNames) {
            const value = rootStyle.getPropertyValue(name).trim();
            if (value) {
                declarations.push(`    ${name}: ${value};`);
            }
        }

        if (declarations.length === 0) return "";
        return `:root {\n${declarations.join("\n")}\n}`;
    }

    /**
     * 捕獲 #chat 元素上的 CSS 變數，用於注入到 CSS 鏡像容器的 inline style
     * 鏡像 floating-chat.js 的 _bridgeCSSVariables() 邏輯
     * @returns {string} 可直接嵌入 HTML 元素的 style 屬性字串
     */
    _captureChatCSSVariables() {
        const nativeChat = document.getElementById("chat");
        if (!nativeChat) return "";

        const nativeStyle = getComputedStyle(nativeChat);

        // 1. 基底預定義變數列表 (與 floating-chat.js 的 _bridgeCSSVariables 保持同步)
        const variablesToBridge = new Set([
            "--font-h1", "--font-h1-size",
            "--font-h2", "--font-h2-size",
            "--font-h3", "--font-h3-size",
            "--font-h4", "--font-h4-size",
            "--font-h5", "--font-h5-size",
            "--font-h6", "--font-h6-size",
            "--font-mono",
            "--font-primary",
            "--chat-message-spacing",
            "--chat-message-background",
            "--chat-message-border-color",
            "--color-bg",
            "--color-border",
            "--color-text",
            "--color-text-light",
            "--color-text-dark"
        ]);

        // 2. 動態掃描樣式表，尋找針對 #chat 定義的自訂變數
        for (const sheet of document.styleSheets) {
            try {
                if (!sheet.cssRules) continue;
                for (const rule of sheet.cssRules) {
                    if (rule.selectorText && (rule.selectorText.includes("#chat") || rule.selectorText.includes(".chat-sidebar"))) {
                        for (const prop of rule.style) {
                            if (prop.startsWith("--")) {
                                variablesToBridge.add(prop);
                            }
                        }
                    }
                }
            } catch {
                // 跨網域 (CORS) 樣式表讀取限制，跳過
            }
        }

        // 3. 收集所有變數值，生成 inline style 字串
        const declarations = [];
        for (const varName of variablesToBridge) {
            const value = nativeStyle.getPropertyValue(varName).trim();
            if (value) {
                declarations.push(`${varName}: ${value}`);
            }
        }

        return declarations.join("; ");
    }

    /**
     * 將 CSS 中引用的外部資源 (字型檔案、背景圖片等) 轉為 Base64 Data URI，
     * 實現完全離線閱覽。
     * @param {string} cssText - 已經路徑修正過的 CSS 文字
     * @returns {Promise<string>} 資源已內嵌的 CSS 文字
     */
    async _inlineCSSResources(cssText) {
        // 匹配所有 url() 中的絕對路徑 (排除已經是 data: URI 的)
        const urlRegex = /url\(\s*(["']?)(?!data:)(https?:\/\/[^\s"')]+|\/[^\s"')]+)\1\s*\)/gi;
        const matches = [...cssText.matchAll(urlRegex)];

        if (matches.length === 0) return cssText;

        // 收集所有需要轉碼的 URL (去重)
        const urlMap = new Map(); // url -> base64 data URI
        const uniqueUrls = [...new Set(matches.map(m => m[2]))];

        // 分批下載與轉碼
        for (let i = 0; i < uniqueUrls.length; i += IMAGE_BATCH_SIZE) {
            const batch = uniqueUrls.slice(i, i + IMAGE_BATCH_SIZE);
            await Promise.all(batch.map(async (resourceUrl) => {
                try {
                    const absoluteUrl = resourceUrl.startsWith("http")
                        ? resourceUrl
                        : new URL(resourceUrl, window.location.origin).href;

                    const response = await fetch(absoluteUrl);
                    if (!response.ok) return;

                    const blob = await response.blob();
                    const dataUri = await this._blobToDataUri(blob);
                    urlMap.set(resourceUrl, dataUri);
                } catch {
                    // 下載失敗 (CORS 等)，保持原 URL
                }
            }));
        }

        // 替換 CSS 中的 URL
        let result = cssText;
        for (const [originalUrl, dataUri] of urlMap) {
            // 使用 replaceAll 替換所有出現的位置 (同一資源可能被多個規則引用)
            // 需要轉義正則特殊字元
            const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            result = result.replace(new RegExp(escaped, "g"), dataUri);
        }

        return result;
    }

    /**
     * 將 Blob 轉為 Data URI 字串
     * @param {Blob} blob
     * @returns {Promise<string>}
     */
    _blobToDataUri(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
}