/**
 * scripts/chat-exporter.js
 * 負責處理聊天紀錄的導出、圖片 Base64 轉換與 HTML 檔案生成
 */

import { applyMessageTimestampDisplay, enrichMessageHTML, getMessageRouteId } from "./chat-helpers.js";
import { MODULE_ID } from "./config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const EXPORT_PROGRESS_KEYS = {
    Preparing: "YCIO.Exporter.ProgressPreparing",
    Styles: "YCIO.Exporter.ProgressStyles",
    Assets: "YCIO.Exporter.ProgressAssets",
    Messages: "YCIO.Exporter.ProgressMessages",
    Images: "YCIO.Exporter.ProgressImages",
    Assembling: "YCIO.Exporter.ProgressAssembling"
};

// Only errors constructed here may carry a user-facing diagnostic.
class ChatExportError extends Error {
    constructor(message) {
        super(message);
        this.name = "ChatExportError";
        this.exportSafeMessage = message;
    }
}

// A single retained dialog owns the client-local job, including while closed.
let exportDialog;
export function openChatExportDialog() {
    if (!game.user?.isGM) return;
    exportDialog ??= new ChatExportDialog();
    exportDialog._captureSelection();
    return exportDialog.render(true);
}

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
            doExport: ChatExportDialog.onDoExport,
            cancelExport: ChatExportDialog.onCancelExport,
            downloadExport: ChatExportDialog.onDownloadExport,
            discardExport: ChatExportDialog.onDiscardExport
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

        if (this._selection) {
            for (const tab of tabs) tab.checked = this._selection.tabs.includes(tab.id);
        }
        return { tabs, includePrivate: this._selection?.includePrivate ?? false };
    }

    _selection = null;
    _job = null;
    _result = null;
    _status = "";
    _failures = [];

    _captureSelection() {
        const form = this.element;
        if (!form?.querySelector('[name="tabs"]') || this._job || this._result) return;
        this._selection = {
            tabs: Array.from(form.querySelectorAll('[name="tabs"]:checked'), input => input.value),
            includePrivate: Boolean(form.querySelector('[name="includePrivate"]')?.checked)
        };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        this._updateStatus();
    }

    async close(options = {}) {
        this._captureSelection();
        if (this._job && !this._job.closeNotice) {
            this._job.closeNotice = true;
            ui.notifications.info(game.i18n.localize("YCIO.Exporter.InfoBackground"));
        }
        return super.close(options);
    }

    _updateStatus() {
        const root = this.element;
        if (!root) return;
        const busy = Boolean(this._job);
        const pending = Boolean(this._result);
        root.querySelectorAll('input').forEach(input => { input.disabled = busy || pending; });
        for (const [action, visible] of Object.entries({
            doExport: !busy && !pending, cancelExport: busy,
            downloadExport: pending, discardExport: pending
        })) {
            const button = root.querySelector(`[data-action="${action}"]`);
            if (button) button.hidden = !visible;
        }
        const cancel = root.querySelector('[data-action="cancelExport"]');
        if (cancel) cancel.disabled = Boolean(this._job?.controller.signal.aborted);
        const status = root.querySelector('[data-export-status]');
        if (status) status.textContent = this._status;
        const spinner = root.querySelector('[data-export-spinner]');
        if (spinner) spinner.hidden = !busy;
        const details = root.querySelector('[data-export-details]');
        if (details) {
            details.hidden = !this._failures.length;
            const summary = details.querySelector('summary');
            if (summary) summary.textContent = `${game.i18n.localize("YCIO.Exporter.FailureDetails")} (${this._failures.length})`;
            const list = details.querySelector('ul');
            // Progress updates must not rebuild or collapse an open report.
            if (list && list._failures !== this._failures) {
                list._failures = this._failures;
                list.replaceChildren(...this._failures.map(failure => {
                    const item = root.ownerDocument.createElement('li');
                    item.textContent = `${failure.type}: ${failure.url} — ${failure.reason} — `
                        + game.i18n.format("YCIO.Exporter.ReferenceCount", { count: failure.references })
                        + (failure.messageIds.length ? ` (${failure.messageIds.join(', ')})` : '');
                    return item;
                }));
            }
        }
    }

    _downloadResult() {
        if (!this._result || this._job || !game.user?.isGM) return;
        const result = this._result;
        // Clear before the synchronous handoff so repeated actions cannot download twice.
        this._result = null;
        try {
            foundry.utils.saveDataToFile(result.html, "text/html;charset=utf-8", result.filename);
            this._status = game.i18n.format("YCIO.Exporter.DownloadHandedOff", { count: result.messageCount });
            ui.notifications.info(this._status);
        } catch {
            this._status = game.i18n.localize("YCIO.Exporter.FailureDownload");
            ui.notifications.error(this._status);
        }
        this._updateStatus();
    }

    static onCancelExport(event) {
        event.preventDefault();
        if (!this._job) return;
        this._job.controller.abort();
        this._status = game.i18n.localize("YCIO.Exporter.Cancelling");
        this._updateStatus();
    }

    static onDownloadExport(event) {
        event.preventDefault();
        this._downloadResult();
    }

    static onDiscardExport(event) {
        event.preventDefault();
        if (this._job) return;
        this._result = null;
        this._status = game.i18n.localize("YCIO.Exporter.Discarded");
        this._updateStatus();
    }

    static async onDoExport(event, target) {
        event.preventDefault();
        if (!game.user?.isGM || this._job || this._result) return;
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

        this._selection = { tabs: selectedTabs, includePrivate };
        const job = { controller: new AbortController() };
        this._job = job;
        this._failures = [];
        this._status = game.i18n.localize("YCIO.Exporter.ProgressPreparing");
        this._updateStatus();
        try {
            const exporter = new ChatExporter({
                signal: job.controller.signal,
                onProgress: progress => {
                    if (this._job !== job || job.controller.signal.aborted) return;
                    this._status = game.i18n.localize(EXPORT_PROGRESS_KEYS[progress.phase] ?? EXPORT_PROGRESS_KEYS.Preparing)
                        + (progress.tabLabel ? ` — ${progress.tabLabel}` : '')
                        + (Number.isFinite(progress.total) ? ` ${progress.completed} / ${progress.total}` : '');
                    if (progress.failures) this._failures = progress.failures;
                    this._updateStatus();
                }
            });
            const result = await exporter.generateAndDownload(selectedTabs, { includePrivate });
            if (job.controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
            this._failures = result.failures;
            if (!result.messageCount) this._status = game.i18n.localize("YCIO.Exporter.NoMessages");
            else {
                this._result = result;
                this._status = game.i18n.format("YCIO.Exporter.WarningSummary", {
                    messages: result.messageCount, count: result.failures.length,
                    references: result.failures.reduce((sum, failure) => sum + failure.references, 0)
                }) + ' ' + game.i18n.format("YCIO.Exporter.AffectedMessages", {
                    count: new Set(result.failures.flatMap(failure => failure.messageIds)).size
                });
                if (result.failures.length) ui.notifications.warn(this._status);
            }
        } catch (error) {
            this._result = null;
            this._status = job.controller.signal.aborted
                ? game.i18n.localize("YCIO.Exporter.Cancelled")
                : game.i18n.format("YCIO.Exporter.FailedStage", { stage: this._status,
                    reason: error instanceof ChatExportError ? error.exportSafeMessage
                        : game.i18n.localize("YCIO.Exporter.FailureUnexpected") });
            if (!job.controller.signal.aborted) ui.notifications.error(foundry.utils.escapeHTML(this._status));
        } finally {
            this._job = null;
            this._updateStatus();
        }
        if (this._result && !this._failures.length) this._downloadResult();
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
    constructor({ signal, onProgress } = {}) {
        this.signal = signal || null;
        this.onProgress = typeof onProgress === "function" ? onProgress : null;
        this.cssContent = "";
        this.resourceFailures = new Map(); // type + safe URL -> grouped failure
        this.imageSourceCache = new Map(); // actual src -> Promise<short asset ID>
        this.textResourceCache = new Map(); // actual stylesheet URL -> Promise<text>
        this.cssResourceCache = new Map(); // actual fetch URL -> Promise<data URI>
        this.imageAssetIds = new Map(); // data URI -> short asset ID
        this.imageAssets = new Map(); // short asset ID -> data URI
        this._failureRevision = 0;
        this._failureSnapshotRevision = -1;
        this._failureSnapshot = Object.freeze([]);
    }

    /**
     * 只產生離線 HTML；下載與通知由保留中的匯出視窗負責。
     */
    async generateAndDownload(selectedTabs, { includePrivate = false } = {}) {
        this._reportProgress("Preparing", 0, undefined, { messageCount: 0 });
        // 先讓對話框的 busy 狀態與 spinner 有一次繪製機會。
        await this._yieldToBrowser();
        this._throwIfAborted();

        const exportTabs = await this._snapshotExportTabs(selectedTabs, includePrivate);
        const messageCount = exportTabs.reduce((count, tab) => count + tab.messageIds.length, 0);
        if (messageCount === 0) {
            return { html: null, filename: null, messageCount: 0, failures: [] };
        }

        const stylesheetUrls = Array.from(
            document.querySelectorAll('link[rel="stylesheet"]'),
            link => link.href
        ).filter(Boolean);
        let stylesCompleted = 0;
        const stylesTotal = stylesheetUrls.length + 1;
        const completeStyle = () => {
            stylesCompleted += 1;
            this._reportProgress("Styles", stylesCompleted, stylesTotal, { messageCount });
        };
        this._reportProgress("Styles", 0, stylesTotal, { messageCount });

        const globalCSS = await this._fetchGlobalCSS(stylesheetUrls, completeStyle);
        let moduleCSS = "";
        const moduleCSSUrl = new URL(
            foundry.utils.getRoute(`modules/${MODULE_ID}/styles/module.css`),
            window.location.origin
        ).href;
        try {
            moduleCSS = this._resolveRelativeUrls(await this._fetchText(moduleCSSUrl), moduleCSSUrl);
        } catch (error) {
            if (this._isCancellation(error)) throw error;
            this._recordResourceFailure("stylesheet", moduleCSSUrl, error);
        }
        completeStyle();
        this.cssContent = globalCSS + "\n/* --- YCIO Module CSS Priority Override --- */\n" + moduleCSS;

        const themeState = this._captureThemeState();
        let rootVarsCSS = this._captureRootCSSVariables();
        let chatVarsInline = this._captureChatCSSVariables();
        const cssSections = [this.cssContent, rootVarsCSS, chatVarsInline];
        const assetTotal = cssSections.reduce(
            (count, section) => count + this._getCSSResourceUsages(section).urls.length,
            0
        );
        let assetsCompleted = 0;
        const completeAsset = () => {
            assetsCompleted += 1;
            this._reportProgress("Assets", assetsCompleted, assetTotal, { messageCount });
        };
        this._reportProgress("Assets", 0, assetTotal, { messageCount });
        // 三段 CSS 順序處理，避免同時建立大量資源請求而掩蓋取消狀態。
        this.cssContent = await this._inlineCSSResources(this.cssContent, { onProcessed: completeAsset });
        rootVarsCSS = await this._inlineCSSResources(rootVarsCSS, { onProcessed: completeAsset });
        chatVarsInline = await this._inlineCSSResources(chatVarsInline, { onProcessed: completeAsset });
        const cssAssetResult = this._deduplicateCSSDataUris([
            this.cssContent,
            rootVarsCSS,
            chatVarsInline
        ]);
        [this.cssContent, rootVarsCSS, chatVarsInline] = cssAssetResult.sections;
        if (cssAssetResult.registry) rootVarsCSS = cssAssetResult.registry + rootVarsCSS;
        this._throwIfAborted();

        const messageProgress = { completed: 0, total: messageCount };
        const tabMarkup = new Map();
        for (const tab of exportTabs) {
            tabMarkup.set(
                tab.sourceId,
                await this._processMessagesForTab(tab, includePrivate, messageProgress)
            );
        }
        // 避免資源處理期間被刪除或改為不可匯出的訊息仍進入最終檔案。
        this._assertExportPlanIsCurrent(exportTabs, includePrivate);

        this._reportProgress("Assembling", 0, undefined, { messageCount });
        await this._yieldToBrowser();
        this._throwIfAborted();
        const failures = this._getFailures();
        const exportTimestamp = new Date().toISOString();
        const dateStr = exportTimestamp.split("T")[0];
        const htmlTitle = foundry.utils.escapeHTML(game.i18n.localize("YCIO.Exporter.HtmlTitle"));
        const htmlLang = foundry.utils.escapeHTML(game.i18n.lang || "en");
        const safeChatVars = foundry.utils.escapeHTML(chatVarsInline);
        const safeChatLogClasses = foundry.utils.escapeHTML(themeState.chatLogClasses);
        const scriptNonce = foundry.utils.randomID(32);
        const warningReport = this._buildWarningReportHtml(failures, messageCount, exportTimestamp);
        const imageAssetsJson = JSON.stringify(Object.fromEntries(this.imageAssets))
            .replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
        const fullHtml = `
<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline' data:; script-src 'nonce-${scriptNonce}'">
    <title>${htmlTitle} - ${dateStr}</title>
    <style>
        ${rootVarsCSS}
        body { margin: 0; padding: 0; font-family: system-ui, sans-serif; height: 100vh; overflow: hidden; }
        ${this.cssContent}
        .YCIO-floating-chat-window { position: relative; height: 100%; width: 100%; top: 0; left: 0; border: none; display: flex; flex-direction: column; }
        .export-warning { max-height: 30vh; overflow: auto; margin: 10px; padding: 10px; border: 1px solid #a66; border-radius: 4px; background: #fff3cd; color: #422; flex: 0 0 auto; }
        .export-warning p { margin: 0 0 6px; }
        .export-warning details { margin-top: 6px; }
        .export-warning ul { margin: 6px 0 0; padding-left: 20px; overflow-wrap: anywhere; }
        .ycio-export-missing-image { display: inline-block; padding: 0.25em 0.5em; border: 1px dashed currentColor; color: #a33; font-style: italic; }
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
        ${warningReport}
        <div class="export-nav" id="nav-container" role="tablist" aria-label="${htmlTitle}">
            ${exportTabs.map(tab => `<button id="${tab.navId}" type="button" role="tab" aria-selected="false" aria-controls="${tab.domId}" data-target="${tab.domId}">${foundry.utils.escapeHTML(tab.label)}</button>`).join("")}
        </div>
        <div class="chat-content">
            ${exportTabs.map(tab => `
            <div id="${tab.domId}" class="tab-content" role="tabpanel" aria-labelledby="${tab.navId}">
                <div class="YCIO-css-mirror tab sidebar-tab chat-sidebar" style="${safeChatVars}">
                    <div class="chat-scroll"><ol class="chat-log ${safeChatLogClasses}">${tabMarkup.get(tab.sourceId)}</ol></div>
                </div>
            </div>`).join("")}
        </div>
    </div>
    <script nonce="${scriptNonce}">
        const imageAssets = ${imageAssetsJson};
        document.querySelectorAll("img[data-ycio-asset]").forEach(image => {
            const assetId = image.dataset.ycioAsset;
            if (Object.prototype.hasOwnProperty.call(imageAssets, assetId)) image.setAttribute("src", imageAssets[assetId]);
        });
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
        document.querySelector('.export-nav').addEventListener('click', event => {
            const button = event.target.closest('button[data-target]');
            if (button) switchTab(button.dataset.target);
        });
        document.addEventListener('click', event => {
            const diceRoll = event.target.closest('.dice-roll');
            if (!diceRoll) return;
            diceRoll.classList.toggle('expanded');
            diceRoll.querySelectorAll('.dice-tooltip').forEach(tooltip => {
                if (tooltip.style.display === 'none') tooltip.style.display = '';
                else if (!diceRoll.classList.contains('expanded')) tooltip.style.display = 'none';
            });
        });
        document.querySelector('.export-nav button[data-target]')?.click();
    </script>
</body>
</html>`;

        await this._yieldToBrowser();
        this._assertExportPlanIsCurrent(exportTabs, includePrivate);
        this._throwIfAborted();
        this._reportProgress("Assembling", 1, undefined, { messageCount });
        return {
            html: fullHtml,
            filename: `chat-log-${dateStr}${failures.length ? "-warnings" : ""}.html`,
            messageCount,
            failures
        };
    }

    /**
     * 處理固定清單中的一個分頁。訊息在 render 前後都重新檢查可匯出資格。
     */
    async _processMessagesForTab(tab, includePrivate, messageProgress) {
        const container = document.createElement("div");
        const imageMessageIds = new Map();
        this._reportProgress("Messages", messageProgress.completed, messageProgress.total, {
            tabLabel: tab.label,
            messageCount: messageProgress.completed
        });
        for (const messageId of tab.messageIds) {
            this._throwIfAborted();
            const message = this._getCurrentExportableMessage(messageId, tab, includePrivate);
            let html;
            try {
                // renderHTML 無法被強制中斷；abort race 讓延遲回傳不得再推進本次工作。
                html = await this._awaitWithAbort(message.renderHTML());
                this._throwIfAborted();
                this._getCurrentExportableMessage(messageId, tab, includePrivate);
                enrichMessageHTML(message, html, { includeAvatarPreview: false });
                applyMessageTimestampDisplay(message, html, { exportMode: true });
                this._getCurrentExportableMessage(messageId, tab, includePrivate);
                container.appendChild(html);
                for (const image of html.querySelectorAll("img")) imageMessageIds.set(image, messageId);
            } catch (error) {
                if (this._isCancellation(error) || error instanceof ChatExportError) throw error;
                throw this._createSafeError("YCIO.Exporter.FailureMessage", {
                    tab: tab.label,
                    id: messageId
                });
            }

            messageProgress.completed += 1;
            this._reportProgress("Messages", messageProgress.completed, messageProgress.total, {
                tabLabel: tab.label,
                messageCount: messageProgress.completed
            });
            if (messageProgress.completed % IMAGE_BATCH_SIZE === 0) await this._yieldToBrowser();
        }

        const images = Array.from(container.querySelectorAll("img"));
        await this._convertImagesInBatches(images, {
            tabLabel: tab.label,
            messageCount: messageProgress.completed,
            imageMessageIds
        });
        return container.innerHTML;
    }

    /**
     * 分批將圖片轉為共用離線資源，並在每筆完成後更新本分頁的進度。
     */
    async _convertImagesInBatches(images, { tabLabel, messageCount, imageMessageIds }) {
        let completed = 0;
        this._reportProgress("Images", completed, images.length, { tabLabel, messageCount });
        for (let i = 0; i < images.length; i += IMAGE_BATCH_SIZE) {
            const batch = images.slice(i, i + IMAGE_BATCH_SIZE);
            await Promise.all(batch.map(async image => {
                await this._convertImageToOfflineAsset(image, imageMessageIds.get(image) || null);
                completed += 1;
                this._reportProgress("Images", completed, images.length, { tabLabel, messageCount });
            }));
            await this._yieldToBrowser();
        }
    }

    /**
     * 將 img 標籤改為離線資源 ID；不能內嵌時留下可見、離線的占位文字。
     */
    async _convertImageToOfflineAsset(imgElement, messageId) {
        const src = imgElement.currentSrc || imgElement.src;
        imgElement.removeAttribute("srcset");
        // picture/source 可在離線開啟時覆蓋 img 的 data asset；只清理此圖片的候選來源。
        const picture = imgElement.closest("picture");
        for (const source of picture?.querySelectorAll("source[srcset]") || []) source.remove();
        imgElement.removeAttribute("data-ycio-asset");
        if (!src) return;

        try {
            const assetId = await this._getImageAssetId(src);
            this._throwIfAborted();
            imgElement.removeAttribute("src");
            imgElement.setAttribute("data-ycio-asset", assetId);
        } catch (error) {
            if (this._isCancellation(error)) throw error;
            this._recordResourceFailure("image", src, error, { messageId });
            const placeholder = document.createElement("span");
            placeholder.className = "ycio-export-missing-image";
            placeholder.setAttribute("role", "img");
            placeholder.textContent = game.i18n.localize("YCIO.Exporter.MissingImage");
            imgElement.replaceWith(placeholder);
        }
    }

    /**
     * 取得離線圖片資源 ID；同一實際來源在本次工作共用同一個 Promise。
     */
    _getImageAssetId(src) {
        const cacheKey = String(src);
        const cached = this.imageSourceCache.get(cacheKey);
        if (cached) return cached;

        const assetIdPromise = (async () => {
            this._throwIfAborted();
            let dataUri = cacheKey;
            if (!/^data:/i.test(cacheKey)) {
                const blob = await this._fetchBlob(cacheKey);
                if (blob.type && !blob.type.startsWith("image/")) throw new Error("Unexpected image MIME type");
                dataUri = await this._blobToDataUri(blob);
            }
            this._throwIfAborted();
            return this._registerImageAsset(dataUri);
        })();
        // 保留拒絕的 Promise 到本次結束，避免稍後重試同 URL 而掩蓋先前缺漏。
        assetIdPromise.catch(() => {});
        this.imageSourceCache.set(cacheKey, assetIdPromise);
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
    async _fetchGlobalCSS(stylesheetUrls, onProcessed) {
        const cssParts = new Array(stylesheetUrls.length).fill("");
        for (let start = 0; start < stylesheetUrls.length; start += IMAGE_BATCH_SIZE) {
            const batch = stylesheetUrls.slice(start, start + IMAGE_BATCH_SIZE);
            await Promise.all(batch.map(async (stylesheetUrl, offset) => {
                this._throwIfAborted();
                try {
                    const cssText = await this._fetchText(stylesheetUrl);
                    // 完成順序可不同，輸出仍跟隨 <link> 的原始順序。
                    cssParts[start + offset] = this._resolveRelativeUrls(cssText, stylesheetUrl);
                } catch (error) {
                    if (this._isCancellation(error)) throw error;
                    this._recordResourceFailure("stylesheet", stylesheetUrl, error);
                }
                onProcessed?.();
            }));
            this._throwIfAborted();
            await this._yieldToBrowser();
        }
        return cssParts.join("\n");
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
    async _inlineCSSResources(cssText, { onProcessed } = {}) {
        const { urlRegex, urls, referencesByUrl } = this._getCSSResourceUsages(cssText);
        if (urls.length === 0) return cssText;

        const urlMap = new Map();
        for (let index = 0; index < urls.length; index += IMAGE_BATCH_SIZE) {
            const batch = urls.slice(index, index + IMAGE_BATCH_SIZE);
            await Promise.all(batch.map(async resourceUrl => {
                try {
                    urlMap.set(resourceUrl, await this._getCSSResourceDataUri(resourceUrl));
                } catch (error) {
                    if (this._isCancellation(error)) throw error;
                    this._recordResourceFailure("css-resource", resourceUrl, error, {
                        references: referencesByUrl.get(resourceUrl) || 1
                    });
                    // 使用空的 data URI，避免離線檔案再次對外連線。
                    urlMap.set(resourceUrl, "data:,");
                }
                onProcessed?.();
            }));
            this._throwIfAborted();
            await this._yieldToBrowser();
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
     * 將使用者選擇固定為 ID 與順序，避免匯出期間新訊息改變總數。
     */
    async _snapshotExportTabs(selectedTabs, includePrivate) {
        const sourceIds = [];
        const seen = new Set();
        for (const sourceId of selectedTabs || []) {
            if (typeof sourceId !== "string" || seen.has(sourceId)) continue;
            seen.add(sourceId);
            sourceIds.push(sourceId);
        }

        const tabs = sourceIds.map((sourceId, index) => {
            const scene = sourceId === "ooc" ? null : game.scenes.get(sourceId);
            const label = sourceId === "ooc"
                ? game.i18n.localize("YCIO.Exporter.OOCButton")
                : (scene?.navName || scene?.name || sourceId);
            return {
                sourceId,
                navId: `export-tab-button-${index}`,
                domId: `export-tab-${index}`,
                label,
                messageIds: []
            };
        });
        const byRoute = new Map(tabs.map(tab => [tab.sourceId, tab]));
        const messages = Array.from(game.messages.contents || []);
        this._reportProgress("Preparing", 0, messages.length);
        for (let index = 0; index < messages.length; index += 1) {
            const message = messages[index];
            try {
                const route = this._getExportableRoute(message, includePrivate);
                byRoute.get(route)?.messageIds.push(message.id);
            } catch {
                throw this._createSafeError("YCIO.Exporter.FailurePreparingMessage", { id: message.id });
            }
            if ((index + 1) % 100 === 0) {
                this._reportProgress("Preparing", index + 1, messages.length);
                await this._yieldToBrowser();
            }
        }
        this._reportProgress("Preparing", messages.length, messages.length);
        this._throwIfAborted();
        return tabs;
    }

    /**
     * 本次匯出範圍與原有顯示邊界一致。
     */
    _isMessageExportable(message, tabId, includePrivate) {
        return this._getExportableRoute(message, includePrivate) === tabId;
    }

    _getExportableRoute(message, includePrivate) {
        if (!message?.visible) return null;
        const isPrivate = message.blind || message.whisper?.length > 0 || !message.isContentVisible;
        if (!includePrivate && isPrivate) return null;
        return getMessageRouteId(message);
    }

    _getCurrentExportableMessage(messageId, tab, includePrivate) {
        const collection = game.messages;
        const message = collection?.get?.(messageId)
            || collection?.contents?.find(candidate => candidate.id === messageId);
        let isExportable = false;
        try {
            isExportable = this._isMessageExportable(message, tab.sourceId, includePrivate);
        } catch {
            // Cannot prove that the snapshot still fits the original permission boundary.
        }
        if (!game.user?.isGM || !isExportable) {
            throw this._createSafeError("YCIO.Exporter.FailureChanged", {
                tab: tab.label,
                id: messageId
            });
        }
        return message;
    }

    _assertExportPlanIsCurrent(exportTabs, includePrivate) {
        for (const tab of exportTabs) {
            for (const messageId of tab.messageIds) {
                this._getCurrentExportableMessage(messageId, tab, includePrivate);
            }
        }
    }

    _getCSSResourceUsages(cssText) {
        const urlRegex = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
        const referencesByUrl = new Map();
        for (const match of String(cssText || "").matchAll(urlRegex)) {
            const resourceUrl = match[2].trim();
            if (!resourceUrl || /^(?:data:|#|var\()/i.test(resourceUrl)) continue;
            referencesByUrl.set(resourceUrl, (referencesByUrl.get(resourceUrl) || 0) + 1);
        }
        return { urlRegex, urls: [...referencesByUrl.keys()], referencesByUrl };
    }

    async _getCSSResourceDataUri(resourceUrl) {
        this._throwIfAborted();
        const absoluteUrl = this._resolveResourceUrl(resourceUrl, document.baseURI);
        const fetchUrl = new URL(absoluteUrl);
        const fragment = fetchUrl.hash;
        fetchUrl.hash = "";
        // Cache with the actual request URL; only failure reports remove query/hash.
        const cacheKey = fetchUrl.href;
        let dataUriPromise = this.cssResourceCache.get(cacheKey);
        if (!dataUriPromise) {
            dataUriPromise = (async () => {
                const blob = await this._fetchBlob(cacheKey);
                return this._blobToDataUri(blob);
            })();
            dataUriPromise.catch(() => {});
            this.cssResourceCache.set(cacheKey, dataUriPromise);
        }
        return (await this._awaitWithAbort(dataUriPromise)) + fragment;
    }

    async _fetchText(url) {
        const cacheKey = String(url);
        let textPromise = this.textResourceCache.get(cacheKey);
        if (!textPromise) {
            textPromise = this._fetchWithTimeout(cacheKey, response => response.text());
            // 本次工作保留失敗結果，避免 priority stylesheet 的重試掩蓋前段缺漏。
            textPromise.catch(() => {});
            this.textResourceCache.set(cacheKey, textPromise);
        }
        return this._awaitWithAbort(textPromise);
    }

    async _fetchBlob(url) {
        return this._fetchWithTimeout(url, response => response.blob());
    }

    /**
     * 單一資源的 timeout 與使用者取消都維持到 response body 讀取完成。
     */
    async _fetchWithTimeout(url, consumeResponse) {
        this._throwIfAborted();
        const controller = new AbortController();
        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort(this._createTimeoutError());
        }, RESOURCE_TIMEOUT_MS);
        const abortFromParent = () => controller.abort(this._createAbortError());
        this.signal?.addEventListener("abort", abortFromParent, { once: true });

        try {
            const response = await fetch(url, { signal: controller.signal });
            this._throwIfAborted();
            if (!response.ok) throw this._createHttpError(response.status);
            const result = consumeResponse ? await consumeResponse(response) : response;
            this._throwIfAborted();
            return result;
        } catch (error) {
            if (this.signal?.aborted) throw this._createAbortError();
            if (timedOut) throw this._createTimeoutError();
            throw error;
        } finally {
            clearTimeout(timeoutId);
            this.signal?.removeEventListener("abort", abortFromParent);
        }
    }

    async _awaitWithAbort(value) {
        const promise = Promise.resolve(value);
        // Abort race 離開後，遲到的 renderer/resource rejection 仍有處理器。
        promise.catch(() => {});
        this._throwIfAborted();
        if (!this.signal) return promise;
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, result) => {
                if (settled) return;
                settled = true;
                this.signal.removeEventListener("abort", abort);
                callback(result);
            };
            const abort = () => finish(reject, this._createAbortError());
            this.signal.addEventListener("abort", abort, { once: true });
            promise.then(
                result => {
                    if (this.signal.aborted) finish(reject, this._createAbortError());
                    else finish(resolve, result);
                },
                error => finish(reject, error)
            );
        });
    }

    _throwIfAborted() {
        if (this.signal?.aborted) throw this._createAbortError();
    }

    _isCancellation() {
        // A third-party renderer or reader can also throw AbortError.
        // Only this job's signal makes it a user cancellation.
        return Boolean(this.signal?.aborted);
    }

    _createAbortError() {
        if (typeof DOMException === "function") return new DOMException("Export cancelled", "AbortError");
        const error = new Error("Export cancelled");
        error.name = "AbortError";
        return error;
    }

    _createTimeoutError() {
        const error = new Error("Resource request timed out");
        error.name = "TimeoutError";
        return error;
    }

    _createHttpError(status) {
        const error = new Error("Resource request failed");
        error.name = "HttpError";
        error.status = status;
        return error;
    }

    _createSafeError(key, data) {
        return new ChatExportError(game.i18n.format(key, data));
    }

    _getResourceFailureReason(error) {
        const key = error?.name === "TimeoutError"
            ? "YCIO.Exporter.FailureTimeout"
            : error?.name === "HttpError"
                ? "YCIO.Exporter.FailureHTTP"
                : "YCIO.Exporter.FailureResource";
        return game.i18n.localize(key);
    }

    _safeResourceUrl(resourceUrl) {
        const rawUrl = String(resourceUrl || "");
        try {
            const baseUrl = typeof document === "undefined" ? undefined : document.baseURI;
            const parsed = new URL(rawUrl, baseUrl);
            return `${parsed.origin}${parsed.pathname}`;
        } catch {
            return rawUrl.split(/[?#]/, 1)[0];
        }
    }

    /**
     * 以類型與安全 URL 匯總缺漏；簽章與原始例外不會流入 UI 或檔案。
     */
    _recordResourceFailure(type, resourceUrl, error, { references = 1, messageId = null } = {}) {
        const safeUrl = this._safeResourceUrl(resourceUrl);
        const key = `${type}\u0000${safeUrl}`;
        let failure = this.resourceFailures.get(key);
        if (!failure) {
            failure = {
                type,
                url: safeUrl,
                reason: this._getResourceFailureReason(error),
                references: 0,
                messageIds: new Set()
            };
            this.resourceFailures.set(key, failure);
        }
        failure.references += Math.max(1, Math.floor(Number(references) || 1));
        if (messageId) failure.messageIds.add(String(messageId));
        this._failureRevision += 1;
    }

    _getFailures() {
        if (this._failureSnapshotRevision === this._failureRevision) return this._failureSnapshot;
        this._failureSnapshot = Object.freeze([...this.resourceFailures.values()].map(failure => Object.freeze({
            type: failure.type,
            url: failure.url,
            reason: failure.reason,
            references: failure.references,
            messageIds: Object.freeze([...failure.messageIds])
        })));
        this._failureSnapshotRevision = this._failureRevision;
        return this._failureSnapshot;
    }

    _buildWarningReportHtml(failures, messageCount, exportTimestamp) {
        if (!failures.length) return "";
        const escape = value => foundry.utils.escapeHTML(String(value));
        const references = failures.reduce((total, failure) => total + failure.references, 0);
        const affectedMessageIds = new Set(failures.flatMap(failure => failure.messageIds));
        const summary = game.i18n.format("YCIO.Exporter.WarningSummary", {
            messages: messageCount,
            count: failures.length,
            references
        });
        const detailItems = failures.map(failure => {
            const referenceCount = game.i18n.format("YCIO.Exporter.ReferenceCount", {
                count: failure.references
            });
            const messages = failure.messageIds.length ? ` (${escape(failure.messageIds.join(", "))})` : "";
            return `<li>${escape(failure.type)}: ${escape(failure.url)} — ${escape(failure.reason)} — ${escape(referenceCount)}${messages}</li>`;
        }).join("");
        return `<section class="export-warning" role="status"><p>${escape(summary)}</p>`
            + `<p>${escape(game.i18n.format("YCIO.Exporter.AffectedMessages", { count: affectedMessageIds.size }))}</p>`
            + `<time datetime="${escape(exportTimestamp)}">${escape(exportTimestamp)}</time>`
            + `<details><summary>${escape(game.i18n.localize("YCIO.Exporter.FailureDetails"))}</summary>`
            + `<p>${escape(game.i18n.localize("YCIO.Exporter.FailureGroupingHint"))}</p><ul>${detailItems}</ul></details></section>`;
    }

    _reportProgress(phase, completed, total, { tabLabel = null, messageCount = 0 } = {}) {
        if (!this.onProgress) return;
        try {
            this.onProgress({
                phase,
                completed,
                total,
                tabLabel,
                messageCount,
                failures: this._getFailures()
            });
        } catch {
            // UI 更新失敗不能改變已固定的匯出資料範圍。
        }
    }

    async _yieldToBrowser() {
        await new Promise(resolve => setTimeout(resolve, 0));
        this._throwIfAborted();
    }

    /**
     * 將 Blob 轉為 Data URI 字串
     * @param {Blob} blob
     * @returns {Promise<string>}
     */
    _blobToDataUri(blob) {
        this._throwIfAborted();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            let settled = false;
            const finish = (callback, result) => {
                if (settled) return;
                settled = true;
                this.signal?.removeEventListener("abort", abort);
                callback(result);
            };
            const abort = () => {
                try {
                    reader.abort();
                } catch {
                    // Reader may have completed between the signal and abort call.
                }
                finish(reject, this._createAbortError());
            };
            this.signal?.addEventListener("abort", abort, { once: true });
            reader.onload = () => {
                if (this.signal?.aborted) finish(reject, this._createAbortError());
                else finish(resolve, String(reader.result));
            };
            reader.onerror = () => finish(reject, new Error("Could not read resource data"));
            reader.onabort = () => finish(reject, this._createAbortError());
            try {
                reader.readAsDataURL(blob);
            } catch {
                finish(reject, new Error("Could not read resource data"));
            }
        });
    }
}
