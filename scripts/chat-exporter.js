/**
 * scripts/chat-exporter.js
 * 負責處理聊天紀錄的導出、圖片 Base64 轉換與 HTML 檔案生成
 */

import { applyMessageTimestampDisplay, enrichMessageHTML, getMessageRouteId } from "./chat-helpers.js";
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
        event.preventDefault();
        if (!game.user?.isGM) return;
        const form = target.closest("form");
        if (!form) return;
        const formData = new FormData(form);
        const validTabs = new Set(["ooc", ...game.scenes.map(scene => scene.id)]);
        const selectedTabs = [...new Set(
            formData.getAll("tabs").filter(tabId => validTabs.has(tabId))
        )];
        const includePrivate = formData.get("includePrivate") === "on";

        if (selectedTabs.length === 0) {
            ui.notifications.warn(game.i18n.localize("YCIO.Exporter.WarningNoSelection"));
            return;
        }

        // 關閉視窗並開始執行導出
        await this.close();
        ui.notifications.info(game.i18n.localize("YCIO.Exporter.InfoPreparing"));

        try {
            const exporter = new ChatExporter();
            await exporter.generateAndDownload(selectedTabs, { includePrivate });
        } catch (error) {
            console.error("[YCIO] 聊天紀錄導出失敗", error);
            ui.notifications.error(game.i18n.format("YCIO.Exporter.ErrorFailed", {
                error: error?.message || String(error)
            }));
        }
    }
}

/**
 * ============================================
 * 2. 導出核心邏輯 (Exporter)
 * ============================================
 */

/** 圖片並行轉碼的批次上限 */
const IMAGE_BATCH_SIZE = 10;
/** 網路資源下載逾時（毫秒） */
const RESOURCE_TIMEOUT_MS = 15000;

class ChatExporter {
    constructor() {
        this.cssContent = "";
        this.resourceFailures = [];
        this.imageSourceCache = new Map(); // src -> Promise<short asset ID>
        this.imageAssetIds = new Map(); // data URI -> short asset ID
        this.imageAssets = new Map(); // short asset ID -> data URI
    }

    /**
     * 主流程：生成並下載
     */
    async generateAndDownload(selectedTabs, { includePrivate = false } = {}) {
        // 1. 讀取 CSS 內容
        try {
            ui.notifications.info(game.i18n.localize("YCIO.Exporter.InfoDownloadingCSS"));

            // Step A: 先抓全域所有 CSS (包含 Core, System 和其他模組)
            const globalCSS = await this._fetchGlobalCSS();

            // Step B: 強制單獨再抓一次 module.css，確保它的權重贏過前面抓到的任何東西
            let moduleCSS = "";
            try {
                const moduleCSSUrl = new URL(
                    foundry.utils.getRoute(`modules/${MODULE_ID}/styles/module.css`),
                    window.location.origin
                ).href;
                const response = await this._fetchWithTimeout(moduleCSSUrl);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                moduleCSS = this._resolveRelativeUrls(await response.text(), moduleCSSUrl);
            } catch (err) {
                this._recordResourceFailure("CSS", `modules/${MODULE_ID}/styles/module.css`, err);
            }

            // Step C: 組合 (將 module.css 放在最後面)
            this.cssContent = globalCSS + "\n/* --- YCIO Module CSS Priority Override --- */\n" + moduleCSS;

        } catch (e) {
            console.error("無法讀取 CSS", e);
            this.cssContent = "";
        }

        // 2. 捕獲主題狀態與 CSS 變數快照
        const themeState = this._captureThemeState();
        let rootVarsCSS = this._captureRootCSSVariables();
        let chatVarsInline = this._captureChatCSSVariables();

        // 3. 離線化 CSS 中的外部資源 (字型、背景圖等)
        ui.notifications.info(game.i18n.localize("YCIO.Exporter.InfoPreparing"));
        [this.cssContent, rootVarsCSS, chatVarsInline] = await Promise.all([
            this._inlineCSSResources(this.cssContent),
            this._inlineCSSResources(rootVarsCSS),
            this._inlineCSSResources(chatVarsInline)
        ]);
        const cssAssetResult = this._deduplicateCSSDataUris([
            this.cssContent,
            rootVarsCSS,
            chatVarsInline
        ]);
        [this.cssContent, rootVarsCSS, chatVarsInline] = cssAssetResult.sections;
        if (cssAssetResult.registry) rootVarsCSS = cssAssetResult.registry + rootVarsCSS;

        // 4. 準備 HTML 結構
        const dateStr = new Date().toISOString().split("T")[0];
        const exportTabs = selectedTabs.map((sourceId, index) => ({
            sourceId,
            navId: "export-tab-button-" + index,
            domId: `export-tab-${index}`,
            label: sourceId === "ooc"
                ? game.i18n.localize("YCIO.Exporter.OOCButton")
                : (game.scenes.get(sourceId)?.navName || game.scenes.get(sourceId)?.name || sourceId)
        }));
        const htmlTitle = foundry.utils.escapeHTML(game.i18n.localize("YCIO.Exporter.HtmlTitle"));
        const htmlLang = foundry.utils.escapeHTML(game.i18n.lang || "en");
        const safeChatVars = foundry.utils.escapeHTML(chatVarsInline);
        const safeChatLogClasses = foundry.utils.escapeHTML(themeState.chatLogClasses);
        const scriptNonce = foundry.utils.randomID(32);
        let fullHtml = `
<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline' data:; script-src 'nonce-${scriptNonce}'">
    <title>${htmlTitle} - ${dateStr}</title>
    <style>
        /* :root CSS 變數快照 (從 FVTT 運行時環境捕獲) */
        ${rootVarsCSS}

        /* 重置基礎樣式，模擬 FVTT 環境 */
        body { margin: 0; padding: 0; font-family: system-ui, sans-serif; height: 100vh; overflow: hidden; }

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
        <div class="export-nav" id="nav-container" role="tablist" aria-label="${htmlTitle}">
            ${exportTabs.map(tab => `<button id="${tab.navId}" type="button" role="tab" aria-selected="false" aria-controls="${tab.domId}" data-target="${tab.domId}">${foundry.utils.escapeHTML(tab.label)}</button>`).join("")}
        </div>

        <div class="chat-content">
`;

        // 5. 遍歷分頁，生成訊息內容
        for (const tab of exportTabs) {
            const messagesHtml = await this._processMessagesForTab(tab.sourceId, includePrivate);
            // 每個分頁都包含完整的 CSS 鏡像結構，確保系統 CSS 選擇器能正確命中
            fullHtml += `
            <div id="${tab.domId}" class="tab-content" role="tabpanel" aria-labelledby="${tab.navId}">
                <div class="YCIO-css-mirror tab sidebar-tab chat-sidebar" style="${safeChatVars}">
                    <div class="chat-scroll">
                        <ol class="chat-log ${safeChatLogClasses}">
                            ${messagesHtml}
                        </ol>
                    </div>
                </div>
            </div>`;
        }

        const imageAssetsJson = JSON.stringify(Object.fromEntries(this.imageAssets))
            .replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

        // 6. 結尾與腳本
        fullHtml += `
        </div>
    </div>
    <script nonce="${scriptNonce}">
        // A. 回填離線圖片資源
        const imageAssets = ${imageAssetsJson};
        document.querySelectorAll("img[data-ycio-asset]").forEach(image => {
            const assetId = image.dataset.ycioAsset;
            if (Object.prototype.hasOwnProperty.call(imageAssets, assetId)) {
                image.setAttribute("src", imageAssets[assetId]);
            }
        });

        // B. 簡單的分頁切換邏輯
        function switchTab(targetId) {
            document.querySelectorAll(".tab-content").forEach(element => {
                const active = element.id === targetId;
                element.classList.toggle("active", active);
                element.hidden = !active;
            });

            document.querySelectorAll(".export-nav button").forEach(button => {
                const active = button.dataset.target === targetId;
                button.classList.toggle("active", active);
                button.setAttribute("aria-selected", String(active));
            });
        }

        document.querySelector('.export-nav').addEventListener('click', function(e) {
            const button = e.target.closest('button[data-target]');
            if (button) switchTab(button.dataset.target);
        });

        // C. 通用擲骰展開互動 (Event Delegation)
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
        document.querySelector('.export-nav button[data-target]')?.click();
    </script>
</body>
</html>`;

        // 7. 觸發下載
        foundry.utils.saveDataToFile(
            fullHtml,
            "text/html;charset=utf-8",
            `chat-log-${dateStr}.html`
        );

        ui.notifications.info(game.i18n.localize("YCIO.Exporter.InfoComplete"));
        if (this.resourceFailures.length > 0) {
            ui.notifications.warn(game.i18n.format("YCIO.Exporter.WarningResourceFailures", {
                count: this.resourceFailures.length
            }));
        }
    }

    /**
     * 處理單一分頁的訊息：撈取 -> 渲染 -> 圖片轉碼
     */
    async _processMessagesForTab(tabId, includePrivate = false) {
        // 1. 撈取訊息 (複製 floating-chat.js 的過濾邏輯，但不限制數量)
        const allMessages = game.messages.contents;
        const targetMessages = allMessages.filter(msg => {
            if (!msg.visible) return false;

            const isPrivate = msg.blind || msg.whisper?.length > 0 || !msg.isContentVisible;
            if (!includePrivate && isPrivate) return false;

            return getMessageRouteId(msg) === tabId;
        });

        // 2. 建立一個暫存的容器來處理 DOM
        const container = document.createElement("div");

        for (const msg of targetMessages) {
            // 渲染原始 HTML
            const html = await msg.renderHTML();
            // 注入頭像與 YCIO 結構 (重複利用既有函式)
            enrichMessageHTML(msg, html, { includeAvatarPreview: false }); // 此時 html 已經變成 <li class="message ...">...</li>
            applyMessageTimestampDisplay(msg, html, { exportMode: true });

            container.appendChild(html);
        }

        // 3. 將容器內的圖片登錄為共用離線資源，分批處理以避免記憶體爆炸
        const images = Array.from(container.querySelectorAll("img"));
        await this._convertImagesInBatches(images);

        return container.innerHTML;
    }

    /**
     * 分批將圖片轉為共用離線資源，避免同時載入過多圖片導致記憶體溢出
     * @param {HTMLImageElement[]} images - 所有需要轉碼的圖片元素
     */
    async _convertImagesInBatches(images) {
        for (let i = 0; i < images.length; i += IMAGE_BATCH_SIZE) {
            const batch = images.slice(i, i + IMAGE_BATCH_SIZE);
            await Promise.all(batch.map(img => this._convertImageToOfflineAsset(img)));
        }
    }

    /**
     * 將 img 標籤改為離線資源 ID
     */
    async _convertImageToOfflineAsset(imgElement) {
        const src = imgElement.currentSrc || imgElement.src;
        // srcset 可能讓瀏覽器略過已內嵌的 src。
        imgElement.removeAttribute("srcset");
        // 不信任訊息原本帶入的內部屬性，只接受本次匯出產生的資源 ID。
        imgElement.removeAttribute("data-ycio-asset");
        if (!src) return;

        try {
            const assetId = await this._getImageAssetId(src);
            imgElement.removeAttribute("src");
            imgElement.setAttribute("data-ycio-asset", assetId);
        } catch (err) {
            this._recordResourceFailure("image", src, err);
            // 不留下會在離線檔案開啟時自動連線的遠端 URL。
            imgElement.removeAttribute("src");
            imgElement.removeAttribute("data-ycio-asset");
        }
    }

    /**
     * 取得離線圖片資源 ID；同一來源在所有分頁共用同一個 Promise。
     */
    _getImageAssetId(src) {
        const cached = this.imageSourceCache.get(src);
        if (cached) return cached;

        const assetIdPromise = (/^data:/i.test(src) ? Promise.resolve(src) : (async () => {
            const response = await this._fetchWithTimeout(src);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const blob = await response.blob();
            if (blob.type && !blob.type.startsWith("image/")) {
                throw new Error(`Unexpected MIME type: ${blob.type}`);
            }

            // 直接內嵌原始 Blob，保留 JPEG/WebP/GIF 等原格式與動畫。
            return this._blobToDataUri(blob);
        })()).then(dataUri => this._registerImageAsset(dataUri)).catch(error => {
            // 短暫性失敗不永久污染快取，讓後續批次仍可重試。
            this.imageSourceCache.delete(src);
            throw error;
        });

        this.imageSourceCache.set(src, assetIdPromise);
        return assetIdPromise;
    }

    /**
     * 將完全相同的 Data URI 共用同一個短 ID。
     */
    _registerImageAsset(dataUri) {
        const cachedId = this.imageAssetIds.get(dataUri);
        if (cachedId) return cachedId;

        const assetId = `a${this.imageAssets.size.toString(36)}`;
        this.imageAssetIds.set(dataUri, assetId);
        this.imageAssets.set(assetId, dataUri);
        return assetId;
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
                const response = await this._fetchWithTimeout(link.href);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const cssText = await response.text();
                // 將 CSS 中的 url() 相對路徑轉為絕對路徑
                return this._resolveRelativeUrls(cssText, link.href);
            } catch (e) {
                this._recordResourceFailure("CSS", link.href, e);
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
        // 支援 url("path"), url('path'), url(path) 三種寫法
        return cssText.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match, quote, rawPath) => {
            const resourcePath = rawPath.trim();
            if (!resourcePath || /^(?:data:|#|var\()/i.test(resourcePath)) return match;

            try {
                const absoluteUrl = this._resolveResourceUrl(resourcePath, baseUrl);
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
        const urlRegex = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
        const matches = [...cssText.matchAll(urlRegex)];

        if (matches.length === 0) return cssText;

        // 收集所有需要轉碼的 URL (去重)
        const urlMap = new Map(); // url -> base64 data URI
        const uniqueUrls = [...new Set(
            matches
                .map(match => match[2].trim())
                .filter(url => url && !/^(?:data:|#|var\()/i.test(url))
        )];

        // 分批下載與轉碼
        for (let i = 0; i < uniqueUrls.length; i += IMAGE_BATCH_SIZE) {
            const batch = uniqueUrls.slice(i, i + IMAGE_BATCH_SIZE);
            await Promise.all(batch.map(async (resourceUrl) => {
                try {
                    const absoluteUrl = this._resolveResourceUrl(resourceUrl, document.baseURI);
                    const fetchUrl = new URL(absoluteUrl);
                    const fragment = fetchUrl.hash;
                    fetchUrl.hash = "";

                    const response = await this._fetchWithTimeout(fetchUrl.href);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);

                    const blob = await response.blob();
                    const dataUri = await this._blobToDataUri(blob);
                    urlMap.set(resourceUrl, dataUri + fragment);
                } catch (error) {
                    this._recordResourceFailure("CSS resource", resourceUrl, error);
                    // 使用空的 data URI，避免離線檔案再次對外連線。
                    urlMap.set(resourceUrl, "data:,");
                }
            }));
        }

        return cssText.replace(urlRegex, (match, quote, rawUrl) => {
            const dataUri = urlMap.get(rawUrl.trim());
            return dataUri ? `url(${quote}${dataUri}${quote})` : match;
        });
    }

    /**
     * 將跨 CSS 區塊重複的圖片 Data URI 收納至靜態 custom-property registry。
     * 只處理 custom property、background 或 background-image 中明確的 url()，
     * 避免碰觸註解、字串、descriptor 與其他 CSS 內容。
     * @param {string[]} cssSections - this.cssContent、rootVarsCSS、chatVarsInline
     * @returns {{ sections: string[], registry: string }}
     */
    _deduplicateCSSDataUris(cssSections) {
        const dataUriPattern = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/i;
        const allowedProperties = new Set(["background", "background-image"]);
        const usagesBySection = cssSections.map(() => []);
        const counts = new Map();

        const skipQuoted = (text, start) => {
            const quote = text[start];
            let index = start + 1;
            while (index < text.length) {
                if (text[index] === "\\") {
                    index += 2;
                } else if (text[index] === quote) {
                    return index + 1;
                } else {
                    index += 1;
                }
            }
            return text.length;
        };
        const findUrlEnd = (text, openIndex) => {
            let index = openIndex + 1;
            while (index < text.length) {
                if (text[index] === "\\") {
                    index += 2;
                } else if (text[index] === "\"" || text[index] === "'") {
                    index = skipQuoted(text, index);
                } else if (text[index] === ")") {
                    return index + 1;
                } else {
                    index += 1;
                }
            }
            return -1;
        };
        const isNameCharacter = character => character && (
            /[A-Za-z0-9_-]/.test(character) || character.charCodeAt(0) >= 0x80
        );
        const startsWithAtRule = header => {
            let index = 0;
            while (index < header.length) {
                if (/\s/.test(header[index])) {
                    index += 1;
                    continue;
                }
                if (header.startsWith("/*", index)) {
                    const commentEnd = header.indexOf("*/", index + 2);
                    if (commentEnd === -1) return true;
                    index = commentEnd + 2;
                    continue;
                }
                return header[index] === "@";
            }
            return false;
        };
        const getDeclarationName = statement => {
            const withoutComments = statement.replace(/\/\*[\s\S]*?\*\//g, "").trimStart();
            return withoutComments.match(
                /^([-_A-Za-z\u0080-\uFFFF][-_A-Za-z0-9\u0080-\uFFFF]*)\s*:/
            )?.[1] || null;
        };

        cssSections.forEach((cssText, sectionIndex) => {
            const blockStack = [];
            let statementStart = 0;
            let index = 0;
            while (index < cssText.length) {
                if (cssText.startsWith("/*", index)) {
                    const commentEnd = cssText.indexOf("*/", index + 2);
                    index = commentEnd === -1 ? cssText.length : commentEnd + 2;
                    continue;
                }

                const character = cssText[index];
                if (character === "\"" || character === "'") {
                    index = skipQuoted(cssText, index);
                    continue;
                }

                if (character === "{") {
                    blockStack.push(startsWithAtRule(cssText.slice(statementStart, index)));
                    statementStart = index + 1;
                    index += 1;
                    continue;
                }
                if (character === "}") {
                    if (blockStack.length > 0) blockStack.pop();
                    statementStart = index + 1;
                    index += 1;
                    continue;
                }
                if (character === ";") {
                    statementStart = index + 1;
                    index += 1;
                    continue;
                }

                const isUrlFunction = cssText.slice(index, index + 3).toLowerCase() === "url"
                    && !isNameCharacter(cssText[index - 1])
                    && cssText[index - 1] !== "\\"
                    && cssText[index + 3] === "(";
                if (!isUrlFunction) {
                    index += 1;
                    continue;
                }

                const end = findUrlEnd(cssText, index + 3);
                if (end === -1) {
                    index = cssText.length;
                    continue;
                }

                const innermostIsDescriptor = blockStack[blockStack.length - 1] === true;
                const declarationName = getDeclarationName(cssText.slice(statementStart, index));
                const isAllowedProperty = declarationName?.startsWith("--")
                    || allowedProperties.has(declarationName?.toLowerCase());
                const isAllowedTopLevelDeclaration = blockStack.length === 0 && sectionIndex === 2;
                if (innermostIsDescriptor || !isAllowedProperty
                    || (blockStack.length === 0 && !isAllowedTopLevelDeclaration)) {
                    index = end;
                    continue;
                }

                let dataUri = cssText.slice(index + 4, end - 1).trim();
                if (dataUri.startsWith("\"") || dataUri.startsWith("'")) {
                    const quote = dataUri[0];
                    if (dataUri.length < 2 || dataUri[dataUri.length - 1] !== quote) {
                        index = end;
                        continue;
                    }
                    dataUri = dataUri.slice(1, -1);
                }

                if (dataUriPattern.test(dataUri)) {
                    usagesBySection[sectionIndex].push({ start: index, end, dataUri });
                    counts.set(dataUri, (counts.get(dataUri) || 0) + 1);
                }
                index = end;
            }
        });

        const duplicateDataUris = [...counts].filter(([, count]) => count > 1);
        if (duplicateDataUris.length === 0) {
            return { sections: cssSections, registry: "" };
        }

        const sourceText = cssSections.join("\n");
        const registryNames = new Map();
        const registryEntries = [];
        let nameIndex = 0;
        for (const [dataUri] of duplicateDataUris) {
            let name;
            do {
                name = `--ycio-export-css-${nameIndex.toString(36)}`;
                nameIndex += 1;
            } while (sourceText.includes(name));
            registryNames.set(dataUri, name);
            registryEntries.push(`    ${name}: url("${dataUri}");`);
        }

        const sections = cssSections.map((cssText, sectionIndex) => {
            const replacements = usagesBySection[sectionIndex]
                .filter(({ dataUri }) => registryNames.has(dataUri));
            if (replacements.length === 0) return cssText;

            let rewritten = "";
            let cursor = 0;
            for (const { start, end, dataUri } of replacements) {
                rewritten += cssText.slice(cursor, start);
                rewritten += `var(${registryNames.get(dataUri)})`;
                cursor = end;
            }
            return rewritten + cssText.slice(cursor);
        });

        return {
            sections,
            registry: `:root {\n${registryEntries.join("\n")}\n}\n`
        };
    }

    /**
     * 將根路徑交給 Foundry 補上部署前綴，其餘路徑依來源 CSS 解析。
     */
    _resolveResourceUrl(resourcePath, baseUrl) {
        if (/^(?:https?:)?\/\//i.test(resourcePath) || /^[a-z][a-z\d+.-]*:/i.test(resourcePath)) {
            return new URL(resourcePath, window.location.href).href;
        }

        if (resourcePath.startsWith("/")) {
            const routePath = resourcePath.replace(/^\/+/, "");
            return new URL(foundry.utils.getRoute(routePath), window.location.origin).href;
        }

        return new URL(resourcePath, baseUrl).href;
    }

    /**
     * 以瀏覽器原生 AbortController 限制單一資源的等待時間。
     */
    async _fetchWithTimeout(url) {
        // AbortSignal.timeout remains active while callers consume text/blob bodies.
        return fetch(url, { signal: AbortSignal.timeout(RESOURCE_TIMEOUT_MS) });
    }

    /**
     * 紀錄不含 query/hash 的資源位置，避免錯誤記錄洩漏簽章參數。
     */
    _recordResourceFailure(type, resourceUrl, error) {
        let safeUrl = String(resourceUrl).split(/[?#]/, 1)[0];
        try {
            const parsed = new URL(resourceUrl, document.baseURI);
            safeUrl = `${parsed.origin}${parsed.pathname}`;
        } catch {
            // 非 URL 輸入沿用已移除 query/hash 的文字。
        }

        this.resourceFailures.push({
            type,
            url: safeUrl,
            error: error?.message || String(error)
        });
        console.warn(`[YCIO] 無法內嵌 ${type}: ${safeUrl}`, error);
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
