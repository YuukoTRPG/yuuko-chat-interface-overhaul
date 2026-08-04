/**
 * Yuuko's Chat Interface Overhaul - 懸浮聊天視窗主邏輯
 * 包含：視窗渲染、聊天記錄管理、輸入處理、打字狀態同步(Flags)、右鍵選單
 */

import {
    prepareSpeakerList,
    getChatContextOptions,
    enrichMessageHTML,
    resolveCurrentAvatar,
    getSpeakerFromSelection,
    triggerRenderHooks,
    insertTextFormat,
    autoResizeTextarea,
    applyWindowStyles,
    shouldPlayNotification,
    getMessageRouteId,
    getVisibleChatScenes,
    isSceneVisibleToUser,
    isMessageVisibleInTab,
    generateTypingStatusHTML,
    parseInlineAvatars,
    generateAvatarTooltip
} from "./chat-helpers.js";

import { FLAG_SCOPE, FLAG_KEY, MODULE_ID } from "./config.js"; // 打字狀態同步常數
import { AvatarSelector, InlineAvatarPicker } from "./avatar-selector.js"; // 頭像選擇器
import { ChatExportDialog } from "./chat-exporter.js"; // 聊天記錄匯出
import { AboutDialog } from "./about-dialog.js"; // 關於本模組對話框

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class FloatingChat extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(options = {}) {
        super(options);

        // --- 設定視窗標題 (i18n，優先使用設定中的標題) ---
        const customTitle = game.settings.get(MODULE_ID, "windowTitle");
        this.options.window.title = customTitle || game.i18n.localize("YCIO.WindowTitle");

        // --- 標題列右側選單按鈕 ---
        // 確保 controls 陣列存在 (防禦性程式碼)
        this.options.window.controls = this.options.window.controls || [];

        // 在右上選單放入 GM 專用按鈕，聊天紀錄導出
        if (game.user?.isGM) {
            this.options.window.controls.unshift(
                {
                    icon: "fas fa-file-export",
                    label: game.i18n.localize("YCIO.Menu.ExportLog"),
                    action: "exportLog"
                },
                {
                    icon: "fas fa-trash",
                    label: game.i18n.localize("YCIO.Menu.ClearLog"),
                    action: "flushLog"
                }
            );
        }

        // --- 讀取並還原視窗位置 ---
        const savedPos = game.settings.get(MODULE_ID, "floatingChatPosition");
        if (savedPos && !foundry.utils.isEmpty(savedPos)) {
            // 使用安全的方式賦值，防止壞掉的資料導致視窗崩潰
            if (Number.isFinite(savedPos.left)) this.position.left = Math.max(1, savedPos.left);
            if (Number.isFinite(savedPos.top)) this.position.top = Math.max(1, savedPos.top);
            if (Number.isFinite(savedPos.width)) this.position.width = savedPos.width;
            if (Number.isFinite(savedPos.height)) this.position.height = savedPos.height;
        }

        // --- 防抖動的視窗座標與大小存檔函式 (延遲 500ms) ---
        // 只有當動作停止 500ms 後才會真正寫入資料庫
        this._savePositionDebounced = foundry.utils.debounce((pos) => {
            void game.settings.set(MODULE_ID, "floatingChatPosition", pos)
                .catch(error => console.error("YCIO | 儲存視窗位置失敗:", error));
        }, 500);

        // 預設分頁：ooc
        this.activeTab = "ooc";

        // 初始化 HTML 快取容器
        this._messageCache = new Map();
        this._contentGeneration = 0;
        this._historyExhausted = new Set();
        this._contentMutationQueue = Promise.resolve();

        // --- 未讀分頁狀態追蹤 (Unread Tabs Tracking) ---
        // 記錄當下有哪些分頁 (ooc 或 SceneID) 包含未讀訊息
        this._unreadTabs = new Set();

        // --- 狀態追蹤變數 ---
        this._isLoadingOlder = false;       // 防止重複觸發載入歷史訊息
        this._programmaticScroll = false;   // 用於區分「程式捲動」與「手動捲動」
        this._lastSpeakerValue = null;      // 記錄上一次的發言身分，預設為 null
        this._lastFlashTime = 0;            // 記錄上一次觸發閃爍的時間
        this._scrollCheckInterval = null;   // 捲動檢查計時器

        // --- 打字狀態變數 ---
        this._typingTimeout = null;         // 倒數計時器
        this._isBroadcastingTyping = false; // 避免重複寫入資料庫
        this._typingDesired = false;
        this._typingWrite = Promise.resolve();
        this._isSending = false;
        this._isProcessingYCIOMessage = false;

        // --- 馬賽克發言者 (暫態，重整即恢復) ---
        this._isMosaicActive = false;

        // --- Hook 管理 ---
        this._hooks = [];               // 陣列以便管理多個 Hooks
        this._mainHooksRegistered = false; // 用來標記主要 Hooks 是否已註冊

    }

    /**
     * ============================================
     * 1. 視窗設定 (Configuration)
     * ============================================
     */

    static DEFAULT_OPTIONS = {
        id: "YCIO-floating-chat-window",
        classes: ["YCIO-floating-chat-window"],
        tag: "aside",
        window: {
            title: "YCIO.WindowTitle",
            resizable: true,
            icon: "fas fa-comments",
            // 放入靜態按鈕（所有玩家可見）
            controls: [
                {
                    icon: "fas fa-eye-slash",
                    label: "YCIO.Menu.MosaicSpeaker",
                    action: "toggleMosaicSpeaker"
                },
                {
                    icon: "fas fa-gear",
                    label: "YCIO.Menu.Settings",
                    action: "openSettings"
                },
                {
                    icon: "fas fa-circle-info",
                    label: "YCIO.Menu.About",
                    action: "openAbout"
                }
            ]
        },

        position: { width: 800, height: 600 },

        // 定義 HTML 中的 data-action 對應的處理函式
        actions: {
            expandRoll: FloatingChat.onExpandRoll,       // 展開/折疊擲骰結果
            deleteMessage: FloatingChat.onDeleteMessage, // 刪除訊息
            jumpToBottom: FloatingChat.onJumpToBottom,   // 跳至底部
            switchTab: FloatingChat.onSwitchTab,         // 切換分頁
            toggleMinimize: FloatingChat.onToggleMinimize, // 最小化/還原
            toggleWait: FloatingChat.onToggleWait,       // 切換稍等一下
            toggleQuickRoll: FloatingChat.onToggleQuickRoll, // 快速擲骰

            // 文字格式工具列 Actions
            formatBold: FloatingChat.onFormatBold,
            formatItalic: FloatingChat.onFormatItalic,
            formatStrikethrough: FloatingChat.onFormatStrikethrough,
            applyTextColor: FloatingChat.onApplyTextColor,
            formatInlineAvatar: FloatingChat.onFormatInlineAvatar,

            // 右上按鈕 Action
            exportLog: FloatingChat.onExportLog,
            flushLog: FloatingChat.onFlushLog,
            toggleMosaicSpeaker: FloatingChat.onToggleMosaicSpeaker,
            openSettings: FloatingChat.onOpenSettings,
            openAbout: FloatingChat.onOpenAbout
        }
    };

    static PARTS = {
        tabs: { template: "modules/yuuko-chat-interface-overhaul/templates/chat-tabs.hbs" },
        content: { template: "modules/yuuko-chat-interface-overhaul/templates/chat-window.hbs" },
        input: { template: "modules/yuuko-chat-interface-overhaul/templates/chat-input.hbs" }
    };

    /**
     * ============================================
     * 2. 靜態動作 (Static Actions)
     * ============================================
     */

    /**
     * Action: 展開/折疊擲骰結果
     * 透過切換 CSS class 來控制顯示，參考 chat.mjs 原生邏輯
     */
    static onExpandRoll(event, target) {
        event.preventDefault();
        target.classList.toggle("expanded");
    }

    /**
     * Action: 刪除訊息
     * 找到對應的 messageId 並呼叫 Document.delete()
     */
    static async onDeleteMessage(event, target) {
        event.preventDefault();
        const messageElement = target.closest("[data-message-id]");
        const messageId = messageElement?.dataset.messageId;
        const message = game.messages.get(messageId);

        if (message?.canUserModify(game.user, "delete")) await message.delete();
    }

    /**
     * Action: 跳至底部按鈕點擊
     */
    static onJumpToBottom(event, target) {
        const log = document.getElementById("custom-chat-log");
        const scrollContainer = log?.closest(".chat-scroll");
        if (scrollContainer) {
            scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
        } else if (log) {
            log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
        }
    }

    /**
     * Action: 切換「稍等一下」狀態
     */
    static async onToggleWait(event, target) {
        event.preventDefault();
        // 取得目前狀態
        const current = game.user.getFlag(FLAG_SCOPE, "isWaiting");
        // 切換狀態 (Toggle)
        const newState = !current;

        // 寫入 Flag (這會觸發 updateUser Hook，進而更新 UI)
        if (newState) {
            await game.user.setFlag(FLAG_SCOPE, "isWaiting", true);
        } else {
            await game.user.unsetFlag(FLAG_SCOPE, "isWaiting");
        }

        // 按鈕的樣式更新會由 _updateWaitButtonState 處理，或者等待 Hook 回調
        // 暫時先手動切換 class 等等可以註解掉
        target.classList.toggle("YCIO-active", newState);
        target.setAttribute("aria-pressed", String(newState));
    }

    /**
     * Action: 切換快速擲骰面板的顯示/隱藏
     */
    static onToggleQuickRoll(event, target) {
        event.preventDefault();
        const wrapper = target.closest(".YCIO-quick-roll-wrapper");
        const panel = wrapper?.querySelector("#YCIO-quick-roll-panel");
        if (!panel) return;

        const isVisible = panel.style.display !== "none";
        panel.style.display = isVisible ? "none" : "";
        target.setAttribute("aria-expanded", String(!isVisible));
    }

    /**
     * Action: 開啟聊天紀錄導出視窗 (僅 GM)
     */
    static onExportLog(event, target) {
        if (!game.user.isGM) return;
        new ChatExportDialog().render(true);
    }

    /**
     * Action: 開啟模組設定頁面
     * 使用 SettingsConfig 的 initialCategory 直接跳轉到本模組的設定分頁
     */
    static onOpenSettings(event, target) {
        const settingsApp = new foundry.applications.settings.SettingsConfig({
            initialCategory: MODULE_ID
        });
        settingsApp.render(true);
    }

    /**
     * Action: 開啟「關於本模組」對話框
     */
    static onOpenAbout(event, target) {
        new AboutDialog().render(true);
    }

    /**
     * Action: 切換馬賽克發言者（截圖用）
     * 模糊化/還原所有訊息的 .message-sender 文字
     */
    static onToggleMosaicSpeaker(event, target) {
        // 在 static action 中，this 指向 App 實例 (ApplicationV2 的設計)
        this._isMosaicActive = !this._isMosaicActive;

        // Toggle 視窗容器的 class
        const appEl = this.element;
        if (appEl) {
            appEl.classList.toggle("YCIO-mosaic-speaker", this._isMosaicActive);
        }

        // 更新按鈕的選項文字與 icon
        const btn = target.closest("button") || target;
        const newLabel = this._isMosaicActive
            ? game.i18n.localize("YCIO.Menu.MosaicSpeakerOff")
            : game.i18n.localize("YCIO.Menu.MosaicSpeaker");

        // 更新選項本身的文字 (.control-label)
        const labelEl = btn.querySelector(".control-label");
        if (labelEl) labelEl.textContent = newLabel;

        // 切換圖示
        const icon = btn.querySelector("i") || btn;
        if (icon) {
            if (this._isMosaicActive) {
                icon.classList.remove("fa-eye-slash");
                icon.classList.add("fa-eye");
            } else {
                icon.classList.remove("fa-eye");
                icon.classList.add("fa-eye-slash");
            }
        }
    }

    /**
     * Action: 刪除所有訊息紀錄 (僅 GM)
     */
    static async onFlushLog(event, target) {
        if (!game.user.isGM) return;

        // 使用 V13 原生的 DialogV2 建立現代化確認視窗
        const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: "YCIO.Clearer.Title", icon: "fas fa-exclamation-triangle" },
            content: game.i18n.localize("YCIO.Clearer.Description"),
            rejectClose: false
        });

        if (confirmed) {
            // 呼叫 FVTT 核心的刪除方法
            await game.messages.flush();
            ui.notifications.info(game.i18n.localize("YCIO.Clearer.Notification"));
        }
    }

    /**
     * Action: 自定義最小化/還原動作，替換視窗關閉動作
     */
    static onToggleMinimize(event, target) {
        event.preventDefault();
        return this.minimized ? this.maximize() : this.minimize();
    }

    /**
     * ============================================
     * 3. 生命週期 (Lifecycle & Rendering)
     * ============================================
     */

    /**
     * 準備渲染訊息資料
     * @returns {Object} 提供給 Handlebars 的資料
     */
    async _prepareContext(_options = {}) {
        // 1. 準備場景列表 (給 chat-tabs.hbs 使用)
        const availableScenes = getVisibleChatScenes();
        const scenes = availableScenes.map(s => ({
            id: s.id,
            name: s.navName || s.name,
            active: s.id === this.activeTab,
            hasUnread: this._unreadTabs.has(s.id) // 標記是否有未讀訊息
        }));

        // tabs/input 的局部 render 不需要重新渲染 50 則訊息。
        const requestedParts = _options.parts || Object.keys(FloatingChat.PARTS);
        const messageElements = [];
        if (requestedParts.includes("content")) {
            const generation = this._contentGeneration;
            const tabId = this.activeTab;
            const filteredMessages = this._latestMessagesForTab(tabId);

            for (const message of filteredMessages) {
                const messageElement = await this._getMessageElement(message);
                if (generation !== this._contentGeneration || tabId !== this.activeTab) break;
                messageElements.push(messageElement);
            }
        }

        // 準備發話身份列表 (Speakers)，呼叫chat-helpers.js的函式
        const speakers = prepareSpeakerList();

        // --- 狀態暫存機制 ---
        // 嘗試讀取當前 DOM 中的輸入框內容 (如果視窗已經存在)
        // 為了防止局部渲染 "input" 區塊時，使用者打到一半的字被清空
        const inputEl = this.element?.querySelector("#chat-message-input");
        const draftContent = inputEl ? inputEl.value : "";

        return {
            scenes: scenes,
            activeTab: this.activeTab,
            oocHasUnread: this._unreadTabs.has("ooc"), // 傳遞 OOC 分頁的未讀狀態
            speakers: speakers,
            draftContent: draftContent,
            isGM: game.user.isGM,
            messageElements
        };
    }

    /**
     * 覆寫 render 方法
     */
    async render(options, _options) {
        // 目的：在 DOM 被銷毀重繪之前，先快照當前的發言身分
        // 這能確保捕捉到使用者最後一眼看到的狀態
        // 如果視窗已經存在 DOM 中，嘗試抓取當前的選單值
        const select = this.element?.querySelector("#chat-speaker-select");
        if (select) {
            this._lastSpeakerValue = select.value;
        }

        // 執行原本的渲染邏輯 (這會銷毀舊 DOM 並建立新 DOM)
        return super.render(options, _options);
    }

    /**
     * 渲染後的邏輯 (DOM Listeners & Hooks)
     */
    _onRender(context, options) {
        super._onRender(context, options);

        // 鏡像原生 CSS 變數與主題
        this._syncTheme();
        this._bridgeCSSVariables();

        // --- 將右上角的「關閉(X)」按鈕偽裝成「最小化」按鈕 ---
        const appWindow = document.getElementById(this.id);
        if (appWindow) {
            // 尋找 header 中的關閉按鈕
            const closeBtn = appWindow.querySelector('.window-header [data-action="close"]');
            if (closeBtn) {
                // 移除原本的叉叉圖示改用減號
                closeBtn.classList.remove("fa-xmark", "fa-times");
                closeBtn.classList.add("fa-minus");

                // 設定提示文字
                const tooltipText = game.i18n.localize("YCIO.MinimizeIcon");
                closeBtn.dataset.tooltip = tooltipText;
                closeBtn.setAttribute("aria-label", tooltipText);

                // 替換按鈕的動作
                closeBtn.dataset.action = "toggleMinimize";
            }
        }

        // --- 每次渲染時套用最新的背景設定 ---
        this._applyCustomStyles();

        // 判斷這次渲染了哪些部分 (如果是初次渲染，parts 會是 undefined，代表全部)
        const parts = options.parts || ["tabs", "content", "input"];

        // --- A. 內容區 (Content) 事件綁定 ---
        if (parts.includes("content")) {
            const log = this.element.querySelector("#custom-chat-log");
            if (log) {
                if (!log.dataset.hooksBound) {
                    // 將本次 render context 準備好的 DOM 元素注入容器。
                    if (context.messageElements?.length > 0) {
                        const fragment = document.createDocumentFragment();
                        context.messageElements.forEach(el => fragment.appendChild(el));
                        log.appendChild(fragment);
                    }

                    // 取得設定：決定隔離模式與參數型別
                    const cloneMode = game.settings.get(MODULE_ID, "hookCompatibilityMode") === "clone";
                    const argType = game.settings.get(MODULE_ID, "hookArgumentType");

                    // 準備基底元素 (決定要不要 Clone)
                    let baseElement = cloneMode ? log.cloneNode(true) : log;

                    // 準備最終傳遞的參數型別 (決定是 jQuery 還是原生 DOM)
                    let finalHookArgument = argType === "jquery" ? $(baseElement) : baseElement;

                    // 全域觸發一次 renderChatLog
                    Hooks.callAll("renderChatLog", this, finalHookArgument, {});

                    // 標記為已綁定
                    log.dataset.hooksBound = "true";
                }

                // Scroll 監聽 (改為監聽真正的滾動包裝容器 .chat-scroll)
                const scrollContainer = this.element.querySelector(".chat-scroll");
                if (scrollContainer) {
                    scrollContainer.addEventListener("scroll", this._onChatScroll.bind(this));
                } else {
                    log.addEventListener("scroll", this._onChatScroll.bind(this));
                }

                // 接管系統的選單按鈕
                // 監聽整個 log 區域的點擊事件
                log.addEventListener("click", (ev) => {
                    // 檢查被點擊的元素是否為 [data-context-menu] 或其子元素 (例如 icon)
                    const btn = ev.target.closest("[data-context-menu]");

                    if (btn) {
                        ev.preventDefault();
                        ev.stopPropagation();

                        // 找到這顆按鈕所屬的訊息元素
                        const messageEl = btn.closest(".message");

                        if (messageEl) {
                            // 手動派發一個 "contextmenu" (右鍵) 事件
                            // 這會觸發在 _initializeContextMenu 中設定好的選單
                            const contextEvent = new MouseEvent("contextmenu", {
                                bubbles: true,
                                cancelable: true,
                                view: window,
                                clientX: ev.clientX, // 讓選單出現在滑鼠點擊的位置
                                clientY: ev.clientY
                            });
                            messageEl.dispatchEvent(contextEvent);
                        }
                    }
                }, { capture: true });

                this._programmaticScroll = true;
                setTimeout(() => {
                    if (!this.rendered || !log.isConnected) {
                        this._programmaticScroll = false;
                        return;
                    }
                    const scrollContainer = this.element?.querySelector(".chat-scroll");
                    if (scrollContainer) {
                        scrollContainer.scrollTop = scrollContainer.scrollHeight;
                    } else {
                        log.scrollTop = log.scrollHeight;
                    }
                    this._initializeContextMenu(log);
                    setTimeout(() => { this._programmaticScroll = false; }, 50);
                }, 0);
            }
        }

        // --- B. 輸入區 (Input) 事件綁定 ---
        // 包含：發話身分選單、頭像按鈕、顏色選擇器、輸入框、發送按鈕
        if (parts.includes("input")) {
            if (this._quickRollClickOutsideTimeout) {
                clearTimeout(this._quickRollClickOutsideTimeout);
                this._quickRollClickOutsideTimeout = null;
            }
            if (this._quickRollClickOutside) {
                document.removeEventListener("click", this._quickRollClickOutside);
                this._quickRollClickOutside = null;
            }

            // 1. 發話身分選單
            const speakerSelect = this.element.querySelector("#chat-speaker-select");
            if (speakerSelect) {
                this._syncSpeakerSelectionState(speakerSelect);

                speakerSelect.addEventListener("change", async (ev) => {
                    // 手動變更時，立即更新時間戳並觸發閃爍
                    this._lastFlashTime = Date.now();

                    // 立即觸發視覺回饋 (不用等下一次 Render)
                    speakerSelect.classList.remove("YCIO-pulse-animation");
                    void speakerSelect.offsetWidth;
                    speakerSelect.classList.add("YCIO-pulse-animation");

                    // 更新紀錄，防止下一次 Render 誤判為變化
                    this._lastSpeakerValue = ev.target.value;

                    const value = ev.target.value;
                    if (value === "ooc") {
                        if (canvas.tokens) canvas.tokens.releaseAll();
                        this.changeTab("ooc", false);
                        return;
                    }

                    const [sceneId, tokenId] = value.split(".");
                    if (canvas.scene?.id !== sceneId) {
                        const scene = game.scenes.get(sceneId);
                        if (!isSceneVisibleToUser(scene)) {
                            await this.changeTab("ooc", false);
                            return;
                        }
                        await scene.view();
                    }
                    if (canvas.scene?.id === sceneId) {
                        const token = canvas.tokens.placeables.find(t => t.id === tokenId);
                        if (token) {
                            token.control({ releaseOthers: true });
                            this.changeTab(sceneId, false);
                        }
                    }
                });

                // 監聽變化以更新 Tooltip
                speakerSelect.addEventListener("change", () => this._updateAvatarBtnTooltip());
            }

            // 2. 頭像設定按鈕
            const avatarBtn = this.element.querySelector("#chat-avatar-btn");
            if (avatarBtn) {
                avatarBtn.addEventListener("click", (ev) => {
                    // 頭像按鈕邏輯
                    if (avatarBtn.classList.contains("YCIO-disabled")) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        return;
                    }

                    const speakerSelect = this.element.querySelector("#chat-speaker-select");
                    const value = speakerSelect ? speakerSelect.value : "ooc";
                    let targetDoc;

                    if (value === "ooc") {
                        targetDoc = game.user;
                    } else {
                        const [sceneId, tokenId] = value.split(".");
                        const scene = game.scenes.get(sceneId);
                        const token = scene?.tokens.get(tokenId);
                        if (token && token.actor) targetDoc = token.actor;
                    }

                    if (targetDoc) new AvatarSelector(targetDoc).render(true);
                });
            }

            // 重新計算 Tooltip 狀態
            this._updateAvatarBtnTooltip();

            // 3. 顏色選擇器 (包含恢復記憶顏色)
            const colorPicker = this.element.querySelector("#chat-text-color-picker");
            if (colorPicker) {
                const savedColor = game.settings.get(MODULE_ID, "lastUsedTextColor");
                colorPicker.value = savedColor; // 重新填入記憶顏色

                colorPicker.addEventListener("change", async (ev) => {
                    const color = ev.target.value;
                    await game.settings.set(MODULE_ID, "lastUsedTextColor", color);
                });
            }

            // 4. 輸入框與發送按鈕
            const input = this.element.querySelector("#chat-message-input");
            const sendBtn = this.element.querySelector("#chat-send-btn");

            if (input) {
                input.addEventListener("keydown", this._onChatKeyDown.bind(this));
                input.addEventListener("input", () => this._adjustInputHeight(input));
                input.addEventListener("input", this._onTypingInput.bind(this));
                input.addEventListener("dragover", this._onChatDragOver.bind(this));
                input.addEventListener("drop", this._onChatDrop.bind(this));

                // 如果有草稿內容，重新調整高度
                if (input.value) this._adjustInputHeight(input);
            }

            if (sendBtn && input) {
                sendBtn.addEventListener("click", async () => {
                    const content = input.value;
                    if (content.trim()) {
                        this._stopTypingBroadcast();
                        if (await this._processMessage(content)) {
                            input.value = "";
                            input.focus();
                            this._adjustInputHeight(input);
                        }
                    }
                });
            }

            // 5. 同步「請等一下」按鈕狀態
            const waitBtn = this.element.querySelector("#chat-wait-btn");
            if (waitBtn) {
                const isWaiting = game.user.getFlag(FLAG_SCOPE, "isWaiting");
                // 如果 flag 為 true，加上 active class
                waitBtn.classList.toggle("YCIO-active", !!isWaiting);
                waitBtn.setAttribute("aria-pressed", String(!!isWaiting));
            }

            // 6. 快速擲骰面板事件綁定
            const quickRollPanel = this.element.querySelector("#YCIO-quick-roll-panel");
            if (quickRollPanel) {
                // 骰子計數器狀態 (暫存於面板 DOM)
                const diceCounts = {};

                // 更新骰子按鈕的 badge 顯示
                const updateBadges = () => {
                    quickRollPanel.querySelectorAll(".YCIO-dice-btn").forEach(btn => {
                        const d = btn.dataset.dice;
                        const badge = btn.querySelector(".YCIO-dice-badge");
                        const count = diceCounts[d] || 0;
                        badge.textContent = count > 0 ? count : "";
                        badge.classList.toggle("visible", count > 0);
                        btn.setAttribute("aria-label", count > 0 ? "d" + d + " × " + count : "d" + d);
                    });
                };

                // 重置所有骰子計數
                const resetDice = () => {
                    Object.keys(diceCounts).forEach(k => delete diceCounts[k]);
                    updateBadges();
                };

                // 關閉面板
                const closePanel = () => {
                    quickRollPanel.style.display = "none";
                    this.element.querySelector("#YCIO-quick-roll-btn")
                        ?.setAttribute("aria-expanded", "false");
                    resetDice();
                };

                // 骰子按鈕：左鍵增加，右鍵減少
                quickRollPanel.querySelectorAll(".YCIO-dice-btn").forEach(btn => {
                    btn.addEventListener("click", (ev) => {
                        ev.preventDefault();
                        const d = btn.dataset.dice;
                        diceCounts[d] = (diceCounts[d] || 0) + 1;
                        updateBadges();
                    });
                    btn.addEventListener("contextmenu", (ev) => {
                        ev.preventDefault();
                        const d = btn.dataset.dice;
                        if (diceCounts[d] && diceCounts[d] > 0) {
                            diceCounts[d]--;
                            if (diceCounts[d] === 0) delete diceCounts[d];
                            updateBadges();
                        }
                    });
                });

                // 「擲骰！」按鈕
                const submitBtn = quickRollPanel.querySelector(".YCIO-roll-submit");
                if (submitBtn) {
                    submitBtn.addEventListener("click", async () => {
                        // 組合骰子字串
                        const parts = [];
                        for (const [d, count] of Object.entries(diceCounts)) {
                            if (count > 0) parts.push(`${count}d${d}`);
                        }
                        if (parts.length === 0) {
                            ui.notifications.warn(game.i18n.localize("YCIO.Input.QuickRollNoSelection"));
                            return;
                        }
                        const formula = `/r ${parts.join("+")}`;
                        if (await this._processMessage(formula)) closePanel();
                    });
                }

                // 「取消」按鈕
                const cancelBtn = quickRollPanel.querySelector(".YCIO-roll-cancel");
                if (cancelBtn) {
                    cancelBtn.addEventListener("click", () => closePanel());
                }

                // 點擊面板外區域自動關閉
                // 使用 setTimeout 確保本次點擊事件不會立即觸發關閉
                this._quickRollClickOutsideTimeout = setTimeout(() => {
                    const onClickOutside = (ev) => {
                        const wrapper = this.element.querySelector(".YCIO-quick-roll-wrapper");
                        if (wrapper && !wrapper.contains(ev.target) && quickRollPanel.style.display !== "none") {
                            closePanel();
                        }
                    };
                    document.addEventListener("click", onClickOutside);
                    this._quickRollClickOutside = onClickOutside;
                    this._quickRollClickOutsideTimeout = null;
                }, 0);
            }

            // 7. 更新打字狀態顯示 (因為 DOM 重建了，要重新抓元素)
            this._updateTypingDisplay();
        }

        // 啟動或重置捲動檢查計時器 (每 1000ms 檢查一次)
        if (this._scrollCheckInterval) clearInterval(this._scrollCheckInterval);
        this._scrollCheckInterval = setInterval(() => this._toggleJumpToBottomButton(), 1000);

        // --- C. Hooks 註冊 (只需註冊一次) ---
        if (!this._mainHooksRegistered) {
            this._mainHooksRegistered = true; // 鎖定，防止重複註冊

            // 1. 輔助函式：註冊並儲存
            const register = (hook, fn) => {
                const id = Hooks.on(hook, fn);
                this._hooks.push({ hook, id });
            };
            register("YCIO_UpdateStyle", () => this._applyCustomStyles());

            // 2. 打字狀態同步
            register("updateUser", (user, changes) => {
                if (changes.flags?.[FLAG_SCOPE]) this._updateTypingDisplay();
            });
            register("YCIO_AvatarChanged", () => this._updateAvatarBtnTooltip());

            // 3. 場景切換監聽 (自動切換分頁)
            register("canvasDraw", (canvas) => {
                const newSceneId = canvas.scene?.id;
                // 如果新場景存在，且當前分頁不是該場景 -> 切換
                // 這會讓分頁始終跟隨 GM 或玩家切換的場景
                if (newSceneId && this.activeTab !== newSceneId) {
                    void this.changeTab(newSceneId, false);
                }
            });

            // 4. 訊息建立前攔截監聽 (Snapshot Avatar & Force Speaker Identity)
            register("preCreateChatMessage", (messageDoc, initialData, context, userId) => {
                if (!this._isProcessingYCIOMessage || userId !== game.user.id) return;
                this._isProcessingYCIOMessage = false;

                const speakerSelect = this.element.querySelector("#chat-speaker-select");
                const selection = speakerSelect ? speakerSelect.value : "ooc";

                // 判斷使用者是否使用了 /ooc 指令
                const isOOCCommand = messageDoc.style === CONST.CHAT_MESSAGE_STYLES.OOC;

                // 如果選單選的是 OOC，或者使用者手動打了 /ooc 指令
                if (selection === "ooc" || isOOCCommand) {
                    // 強制清洗為 OOC 身分
                    messageDoc.updateSource({
                        speaker: {
                            actor: null,
                            token: null,
                            scene: null, // 確保徹底脫離場景
                            alias: game.user.name
                        }
                    });
                } else {
                    // 選單選的是 Token，且使用者沒打 /ooc -> 強制鎖定為該 Token
                    const { speaker } = getSpeakerFromSelection(selection);

                    messageDoc.updateSource({
                        speaker
                    });
                }

                // 計算並寫入頭像快照
                const finalAvatarUrl = resolveCurrentAvatar(messageDoc);
                if (finalAvatarUrl) {
                    messageDoc.updateSource({
                        [`flags.${MODULE_ID}.avatarUrl`]: finalAvatarUrl
                    });
                }
            });

            // 5. 場景列表更新監聽 (新增/刪除/改名，選擇 Token 時僅更新選單)
            register("controlToken", () => this._refreshSpeakerSelect());
            const queueSceneRefresh = () => this.queueContentMutation(() => this._refreshSceneUI());
            register("createToken", queueSceneRefresh);
            register("deleteToken", queueSceneRefresh);
            register("updateToken", (token, changes) => {
                const keys = Object.keys(changes);
                const speakerChanged = keys.some(k => k.includes("actorId") || k.includes("name") || k.includes("hidden"));

                if (speakerChanged) {
                    queueSceneRefresh();
                }
            });
            register("updateActor", (actor, changes) => {
                const keys = Object.keys(changes);
                const ownershipChanged = keys.some(k => k.includes("ownership"));

                if (ownershipChanged) {
                    queueSceneRefresh();
                }
            });
            register("createScene", queueSceneRefresh);
            register("deleteScene", queueSceneRefresh);
            register("updateScene", (scene, changes) => {
                // 取得所有變更的屬性名稱 (Keys)
                const keys = Object.keys(changes);

                // 1. 檢查是否涉及權限變更 (包含 ownership, ownership.default, ownership.UserID...)
                // 使用 includes 可以同時捕捉 "ownership" 和 "ownership.xxxx"
                const ownershipChanged = keys.some(k => k.includes("ownership"));

                // Scene update diff 使用 source 欄位；visible 是衍生 getter，不會出現在 changes。
                const visibilityChanged = keys.includes("navigation") || keys.includes("active");

                // 3. 檢查名稱變更
                const nameChanged = keys.includes("name") || keys.includes("navName");

                // 只有當上述任一條件成立時，才觸發重繪
                if (ownershipChanged || visibilityChanged || nameChanged) {
                    queueSceneRefresh();
                }
            });
        }
    }

    /**
     * 套用 CSS 變數：呼叫 helper 取得並套用設定
     */
    _applyCustomStyles() {
        applyWindowStyles(this.element, game.user);
    }

    /**
     * 同步發話身分的狀態與切換動畫。
     * @param {HTMLSelectElement} speakerSelect
     */
    _syncSpeakerSelectionState(speakerSelect) {
        const currentValue = speakerSelect.value;
        const now = Date.now();
        const ANIMATION_DURATION = 1200; // 動畫持續時間 (毫秒)，配合 CSS

        // 如果這是第一次渲染 (null) 不閃爍
        if (this._lastSpeakerValue !== null && this._lastSpeakerValue !== currentValue) {
            this._lastFlashTime = now;
        }

        this._lastSpeakerValue = currentValue;

        if (now - this._lastFlashTime < ANIMATION_DURATION) {
            speakerSelect.classList.remove("YCIO-pulse-animation");
            void speakerSelect.offsetWidth; // 強制 Reflow
            speakerSelect.classList.add("YCIO-pulse-animation");
        }
    }

    /**
     * 原地更新發話身分選單，避免背景事件重繪 input part 並替換 textarea。
     */
    _refreshSpeakerSelect() {
        const speakerSelect = this.element?.querySelector("#chat-speaker-select");
        if (!speakerSelect) return;

        const speakers = prepareSpeakerList();
        const selectedValue = speakers.find(speaker => speaker.selected)?.value
            ?? speakers[0]?.value
            ?? "ooc";
        const options = document.createDocumentFragment();

        for (const speaker of speakers) {
            const option = document.createElement("option");
            option.value = speaker.value;
            option.textContent = speaker.label;
            option.selected = speaker.value === selectedValue;
            options.appendChild(option);
        }

        speakerSelect.replaceChildren(options);
        this._syncSpeakerSelectionState(speakerSelect);
        this._updateAvatarBtnTooltip();
    }

    async _refreshSceneUI() {
        const activeSceneIsAvailable = this.activeTab === "ooc"
            || getVisibleChatScenes().some(scene => scene.id === this.activeTab);
        if (!activeSceneIsAvailable) return this._changeTab("ooc", false);

        const generation = ++this._contentGeneration;
        const tabId = this.activeTab;
        this._historyExhausted.clear();
        await this.render({ parts: ["tabs"] });
        if (generation !== this._contentGeneration || tabId !== this.activeTab) return;
        this._refreshSpeakerSelect();
        await this._refreshChatLogDOM(generation, tabId);
    }

    _onClose(options) {
        if (this._scrollCheckInterval) clearInterval(this._scrollCheckInterval);
        this._scrollCheckInterval = null;
        if (this._typingTimeout) clearTimeout(this._typingTimeout);
        this._typingTimeout = null;
        if (this._quickRollClickOutsideTimeout) clearTimeout(this._quickRollClickOutsideTimeout);
        this._quickRollClickOutsideTimeout = null;
        if (this._quickRollClickOutside) {
            document.removeEventListener("click", this._quickRollClickOutside);
        }
        this._quickRollClickOutside = null;
        this._programmaticScroll = false;
        this._isLoadingOlder = false;
        this._isBroadcastingTyping = false;
        this._typingDesired = false;

        this._savePositionDebounced?.cancel?.();
        this._contextMenu?.close?.({ animate: false });
        this._contextMenu = null;
        this._hooks.forEach(({ hook, id }) => Hooks.off(hook, id));
        this._hooks = [];
        this._mainHooksRegistered = false;
        this._messageCache.clear();
        this._historyExhausted.clear();
        this._contentGeneration++;
        void this._setTypingFlag(false);

        return super._onClose(options);
    }

    /**
     * 覆寫 setPosition 以便在移動/縮放時自動存檔
     */
    setPosition(position = {}) {
        const result = super.setPosition(position);
        this._savePositionDebounced?.({
            left: this.position.left,
            top: this.position.top,
            width: this.position.width,
            height: this.position.height
        });
        return result;
    }

    /**
     * 序列化所有會替換或增刪聊天內容 DOM 的工作。
     * ponytail: a single queue is sufficient for normal chat volume.
     */
    queueContentMutation(task) {
        const operation = this._contentMutationQueue.then(() => {
            if (!this.rendered) return;
            return task();
        });
        this._contentMutationQueue = operation.catch(error => {
            console.error("YCIO | 聊天內容更新失敗:", error);
        });
        return this._contentMutationQueue;
    }

    reconcileMessages() {
        return this.queueContentMutation(async () => {
            const generation = ++this._contentGeneration;
            const tabId = this.activeTab;
            this._historyExhausted.clear();
            await this._refreshChatLogDOM(generation, tabId);
        });
    }

    _latestMessagesForTab(tabId, limit = 50) {
        const messages = [];
        const allMessages = game.messages.contents;
        for (let index = allMessages.length - 1; index >= 0; index--) {
            const message = allMessages[index];
            if (!isMessageVisibleInTab(message, tabId)) continue;
            messages.unshift(message);
            if (messages.length >= limit) break;
        }
        return messages;
    }

    _cacheMessage(messageId, element) {
        this._messageCache.delete(messageId);
        this._messageCache.set(messageId, element);

        // ponytail: FIFO 200 is sufficient for the visible window plus history;
        // replace with measured LRU behavior only if real sessions need it.
        while (this._messageCache.size > 200) {
            this._messageCache.delete(this._messageCache.keys().next().value);
        }
    }

    async _getMessageElement(message, { fresh = false } = {}) {
        if (!fresh) {
            const cached = this._messageCache.get(message.id);
            if (cached) return cached;
        }

        const rendered = await message.renderHTML();
        const element = rendered instanceof jQuery ? rendered[0] : rendered;
        enrichMessageHTML(message, element);
        triggerRenderHooks(this, message, element);
        this._cacheMessage(message.id, element);
        return element;
    }


    /**
     * ============================================
     * 4. 處理場景分頁
     * ============================================
     */

    /**
     * Action: 靜態動作，對應 HTML 的 data-action="switchTab" 
     */
    static onSwitchTab(event, target) {
        event.preventDefault();
        // 呼叫實例方法 changeTab
        this.changeTab(target.dataset.tab);
    }

    /**
     * 切換目標分頁邏輯
     * @param {string} tabId - 切換的目標分頁 ID
     * @param {boolean} triggerSceneView - 是否連動視角切換至目標點
     */
    async changeTab(tabId, triggerSceneView = true) {
        return this.queueContentMutation(() => this._changeTab(tabId, triggerSceneView));
    }

    async _changeTab(tabId, triggerSceneView = true) {
        let scene = tabId === "ooc" ? null : game.scenes.get(tabId);
        if (tabId !== "ooc" && !isSceneVisibleToUser(scene)) {
            tabId = "ooc";
            scene = null;
        }
        if (this.activeTab === tabId) return;

        // 場景檢視失敗時不要提前提交分頁狀態，避免畫布、狀態與舊 DOM 分離。
        if (triggerSceneView && scene) await scene.view();

        // --- 清除該分頁的未讀狀態 ---
        // 當使用者切換到該分頁時，移除未讀狀態並在後續的 render 消除紅點
        if (this._unreadTabs.has(tabId)) {
            this._unreadTabs.delete(tabId);
        }

        this.activeTab = tabId;
        const generation = ++this._contentGeneration;

        // 1. 重新渲染並等待渲染完成
        await this.render({ parts: ["tabs"] });
        if (generation !== this._contentGeneration || tabId !== this.activeTab) return;
        this._refreshSpeakerSelect();

        // 2. 呼叫自定義的 DOM 抽換方法
        await this._refreshChatLogDOM(generation, tabId);
    }

    /**
     * 手動換皮：抽換聊天容器內的訊息，避免摧毀容器本身
     */
    async _refreshChatLogDOM(generation = this._contentGeneration, tabId = this.activeTab) {
        const log = this.element.querySelector("#custom-chat-log");
        if (!log) return;
        const scrollContainer = this.element.querySelector(".chat-scroll");
        const elements = [];
        for (const message of this._latestMessagesForTab(tabId)) {
            elements.push(await this._getMessageElement(message));
            if (generation !== this._contentGeneration || tabId !== this.activeTab) return;
        }

        if (log !== this.element.querySelector("#custom-chat-log")) return;
        const fragment = document.createDocumentFragment();
        elements.forEach(element => fragment.appendChild(element));
        log.replaceChildren(fragment);
        if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
        } else {
            log.scrollTop = log.scrollHeight;
        }
    }

    /**
     * ============================================
     * 5. 聊天記錄管理 (Chat Log Logic)
     * ============================================
     */

    /**
     * 處理捲動事件
     * 1. 控制「跳至底部」按鈕的顯示/隱藏
     * 2. 觸發「載入舊訊息」
     */
    async _onChatScroll(event) {
        if (this._programmaticScroll) return;
        const log = event.target;

        // 呼叫共用邏輯來控制按鈕
        this._toggleJumpToBottomButton();

        // 載入舊訊息的邏輯
        if (log.scrollTop < 50 && !this._isLoadingOlder && !this._historyExhausted.has(this.activeTab)) {
            this._isLoadingOlder = true;
            try {
                await this.queueContentMutation(() => this._loadOlderMessages(log));
            } finally {
                this._isLoadingOlder = false;
            }
        }
    }

    /**
     * 共用的置底按鈕狀態檢查邏輯
     * 供 Scroll 事件與 setInterval 呼叫
     */
    _toggleJumpToBottomButton() {
        const log = this.element?.querySelector(".chat-scroll") || this.element?.querySelector("#custom-chat-log");
        const jumpBtn = this.element?.querySelector(".jump-to-bottom");

        // 防呆：如果視窗已關閉或 DOM 不存在則不執行
        if (!log || !jumpBtn) return;

        const distanceToBottom = log.scrollHeight - log.scrollTop - log.clientHeight;
        const THRESHOLD_SHOW = 100; // 距離底部超過 100px 顯示
        const THRESHOLD_HIDE = 50;  // 距離底部小於 50px 隱藏

        if (distanceToBottom > THRESHOLD_SHOW) {
            // 只有當按鈕還沒顯示時才加 class (微幅效能優化)
            if (!jumpBtn.classList.contains("visible")) {
                jumpBtn.classList.add("visible");
            }
        } else if (distanceToBottom < THRESHOLD_HIDE) {
            // 在底部：隱藏按鈕，並順便移除未讀狀態
            jumpBtn.classList.remove("visible", "unread");
        }
    }

    /**
     * 往上載入歷史訊息 (無限捲動機制)
     * @param {HTMLElement} logElement - 滾動區域元素
     */
    async _loadOlderMessages(logElement) {
        const generation = this._contentGeneration;
        const tabId = this.activeTab;

        try {
            const logContainer = logElement.matches?.("#custom-chat-log")
                ? logElement
                : logElement.querySelector("#custom-chat-log");
            const firstMessageEl = logContainer?.querySelector(".message");
            if (!logContainer || !firstMessageEl) return;

            const allMessages = game.messages.contents;
            const anchorMsg = game.messages.get(firstMessageEl.dataset.messageId);
            if (!anchorMsg) return;

            const currentIndex = allMessages.indexOf(anchorMsg);
            if (currentIndex <= 0) {
                this._historyExhausted.add(tabId);
                return;
            }

            const olderMessages = [];
            let searchIndex = currentIndex - 1;
            while (olderMessages.length < 20 && searchIndex >= 0) {
                const message = allMessages[searchIndex--];
                if (isMessageVisibleInTab(message, tabId)) olderMessages.push(message);
            }
            olderMessages.reverse();

            if (olderMessages.length === 0) {
                this._historyExhausted.add(tabId);
                return;
            }

            const previousScrollHeight = logElement.scrollHeight;
            const previousScrollTop = logElement.scrollTop;
            const elements = [];
            for (const message of olderMessages) {
                elements.push(await this._getMessageElement(message));
                if (generation !== this._contentGeneration || tabId !== this.activeTab) return;
            }

            if (logContainer !== this.element.querySelector("#custom-chat-log")) return;
            const fragment = document.createDocumentFragment();
            elements.forEach(element => fragment.appendChild(element));
            logContainer.insertBefore(fragment, logContainer.firstChild);
            logElement.scrollTop = logElement.scrollHeight - previousScrollHeight + previousScrollTop;
            if (searchIndex < 0) this._historyExhausted.add(tabId);
        } catch (error) {
            console.error("YCIO | 載入歷史訊息失敗:", error);
        }
    }

    /**
     * 播放新訊息通知音效
     * @param {ChatMessage} message - 觸發通知的訊息
     */
    _playNotification(message) {
        if (shouldPlayNotification(message)) {
            const soundPath = game.settings.get(MODULE_ID, "notificationSoundPath");
            try {
                foundry.audio.AudioHelper.play({
                    src: soundPath,
                    volume: game.settings.get("core", "globalInterfaceVolume"),
                    autoplay: true,
                    loop: false
                }, false);
            } catch (error) {
                console.warn("YCIO | 播放通知音效失敗:", error);
            }
        }
    }

    /**
     * 插入新訊息 (由 main.js 的 createChatMessage Hook 呼叫)
     * @param {ChatMessage} message - 新建立的訊息
     */
    async appendMessage(message) {
        const targetTab = getMessageRouteId(message);
        if (!isMessageVisibleInTab(message, targetTab)) return;
        this._playNotification(message);

        if (message.isAuthor && this.activeTab !== targetTab) {
            await this._changeTab(targetTab, false);
        }

        if (!isMessageVisibleInTab(message, this.activeTab)) {
            this._unreadTabs.add(targetTab);
            void this.render({ parts: ["tabs"] });
            return;
        }

        const generation = this._contentGeneration;
        const tabId = this.activeTab;
        const log = this.element.querySelector("#custom-chat-log");
        if (!log) return;
        const scrollContainer = this.element.querySelector(".chat-scroll");

        const scrollElement = scrollContainer || log;
        const distanceToBottom = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
        const isAtBottom = distanceToBottom < 50;

        const htmlElement = await this._getMessageElement(message, { fresh: true });
        if (generation !== this._contentGeneration || tabId !== this.activeTab) return;
        if (log !== this.element.querySelector("#custom-chat-log")) return;
        if (game.messages.get(message.id) !== message || !isMessageVisibleInTab(message, tabId)) return;

        const existing = log.querySelector(`[data-message-id="${message.id}"]`);
        if (existing) existing.replaceWith(htmlElement);
        else log.appendChild(htmlElement);

        const jumpBtn = this.element.querySelector(".jump-to-bottom");

        if (message.isAuthor || isAtBottom) {
            setTimeout(() => {
                if (generation !== this._contentGeneration || !scrollElement.isConnected) return;
                scrollElement.scrollTo({ top: scrollElement.scrollHeight, behavior: "smooth" });
            }, 0);
            jumpBtn?.classList.remove("visible", "unread");
        } else {
            // 否則顯示未讀提示
            jumpBtn?.classList.add("visible");
            if (!message.isAuthor) {
                jumpBtn?.classList.add("unread");
            }
        }
    }

    /**
     * 移除 DOM 中的訊息 (由 main.js 的 deleteChatMessage Hook 呼叫)
     * @param {string} messageId - 被刪除的訊息 ID
     */
    deleteMessageFromDOM(messageId) {
        this.invalidateCache(messageId); // 清除快取

        const log = this.element.querySelector("#custom-chat-log");
        const el = log?.querySelector(`[data-message-id="${messageId}"]`);
        el?.remove();
    }

    /**
     * 更新 DOM 中的訊息 (通用同步邏輯)
     * 無論是內容更新、權限變更、公開/隱藏，都統一由此方法處理
     * @param {ChatMessage} message - 更新後的訊息
     */
    async updateMessageInDOM(message) {
        this.invalidateCache(message.id); // 訊息更新清除快取
        this._historyExhausted.delete(getMessageRouteId(message));
        const log = this.element.querySelector("#custom-chat-log");
        if (!log) return;

        // 取得目前 DOM 裡的元素
        const el = log.querySelector(`[data-message-id="${message.id}"]`);

        const isVisible = isMessageVisibleInTab(message, this.activeTab);

        // 狀況 A: 我沒權限看 (例如被改為私訊)，但它卻在畫面上 -> 移除
        if (!isVisible) {
            if (el) this.deleteMessageFromDOM(message.id);
            return;
        }

        // 狀況 B: 我有權限看，且它已經在畫面上 -> 更新內容
        if (el) {
            const generation = this._contentGeneration;
            const tabId = this.activeTab;
            const htmlElement = await this._getMessageElement(message, { fresh: true });
            if (generation !== this._contentGeneration || tabId !== this.activeTab) return;
            if (game.messages.get(message.id) !== message || !isMessageVisibleInTab(message, tabId)) return;
            const current = this.element.querySelector(`#custom-chat-log [data-message-id="${message.id}"]`);
            current?.replaceWith(htmlElement);
            return;
        }

        // 狀況 C: 我有權限看，但它不在畫面上 (例如 GM 剛剛重新公開) -> 插入到正確位置
        // 這時候不能只用 append，因為這可能是一條舊訊息
        await this._insertMessageSmartly(message, log);
    }

    /**
     * 清除特定訊息的快取，強迫下次重繪
     * @param {string|null} messageId - 指定 ID 則清除單筆，null 則清除全部
     */
    invalidateCache(messageId = null) {
        if (messageId) {
            this._messageCache.delete(messageId);
        } else {
            this._messageCache.clear();
        }
    }

    /**
     * ============================================
     * 6. 輸入框邏輯 (Input Handling)
     * ============================================
     */

    /**
     * 處理 Enter 鍵發送
     * @param {Event} event - 鍵盤事件
     */
    async _onChatKeyDown(event) {
        if (event.key !== "Enter" || event.isComposing) return;

        // 讀取設定：是否交換 Enter/Shift+Enter 的行為
        // swapped=false (預設): Enter 送出, Shift+Enter 換行
        // swapped=true:         Shift+Enter 送出, Enter 換行
        const swapped = game.settings.get(MODULE_ID, "swapEnterShiftEnter");
        const shouldSend = swapped ? event.shiftKey : !event.shiftKey;

        if (shouldSend) {
            event.preventDefault(); // 阻止換行
            this._stopTypingBroadcast(); // 停止打字狀態

            const input = event.target;
            const content = input.value;

            if (content.trim() && await this._processMessage(content)) {
                input.value = "";
                this._adjustInputHeight(input); // 重置高度
            }
        }
    }

    /**
     * 呼叫 FVTT 核心處理訊息 (支援 /r, /w 等指令)
     * @param {string} content - 準備發送的內容
     */
    async _processMessage(content) {
        if (this._isSending) return false;

        // 在 Class 內決定誰是發話者 (UI 狀態邏輯)
        const speakerSelect = this.element.querySelector("#chat-speaker-select");
        const value = speakerSelect ? speakerSelect.value : "ooc";
        const { actorDoc, user } = getSpeakerFromSelection(value);
        const targetDoc = actorDoc || user;

        // 呼叫 Helper 進行行內頭像替換
        content = parseInlineAvatars(content, targetDoc);
        const sendButton = this.element.querySelector("#chat-send-btn");

        try {
            this._isSending = true;
            this._isProcessingYCIOMessage = true;
            if (sendButton) sendButton.disabled = true;
            await ui.chat.processMessage(content);
            return true;
        } catch (err) {
            console.error("YCIO | 訊息處理錯誤:", err);
            ui.notifications.error(game.i18n.localize("YCIO.Warning.FailedMsg") + "（" + err + "）");
            return false;
        } finally {
            this._isProcessingYCIOMessage = false;
            this._isSending = false;
            if (sendButton) sendButton.disabled = false;
        }
    }

    /**
     * 輸入框自動長高
     * @param {HTMLElement} input - 輸入框元素
     */
    _adjustInputHeight(input) {
        // 傳入最大高度 (視窗高度的一半)
        const maxHeight = this.element.clientHeight * 0.5;
        autoResizeTextarea(input, maxHeight);
    }

    /**
     * 允許 Foundry 文件拖放到聊天輸入框。
     * @param {DragEvent} event - 拖曳事件
     */
    _onChatDragOver(event) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }

    /**
     * 將拖放的 Foundry 文件轉為 @UUID 語法並插入輸入框。
     * @param {DragEvent} event - 放置事件
     */
    _onChatDrop(event) {
        const reference = this._getDroppedDocumentReference(event);
        if (!reference?.uuid) return;

        event.preventDefault();
        event.stopPropagation();

        const input = event.currentTarget;
        const label = String(reference.name || "").replace(/[{}]/g, "").trim();
        const uuidText = label ? `@UUID[${reference.uuid}]{${label}}` : `@UUID[${reference.uuid}]`;
        this._insertTextAtCursor(input, uuidText);
    }

    /**
     * 解析 Foundry 拖曳資料，支援 V13 的 TextEditor API 與 JSON 後備。
     * @param {DragEvent} event - 拖放事件
     * @returns {{uuid: string, name: string}|null}
     */
    _getDroppedDocumentReference(event) {
        let data = null;

        try {
            data = foundry.applications.ux.TextEditor.getDragEventData(event);
        } catch (err) {
            data = null;
        }

        if (!data) {
            for (const type of ["application/json", "text/plain"]) {
                const raw = event.dataTransfer?.getData(type);
                if (!raw) continue;
                try {
                    data = JSON.parse(raw);
                    break;
                } catch (err) {
                    // Plain text drops are left to the browser's default textarea handling.
                }
            }
        }

        const uuid = data?.uuid
            || data?.documentUuid
            || data?.documentUUID
            || (data?.pack && data?.id ? `Compendium.${data.pack}.${data.id}` : null)
            || (data?.type && data?.id ? `${data.type}.${data.id}` : null);
        if (!uuid) return null;

        const doc = foundry.utils.fromUuidSync(uuid);
        return {
            uuid,
            name: data?.name || data?.label || doc?.name || ""
        };
    }

    /**
     * 在 textarea 游標或選取範圍插入文字。
     * @param {HTMLTextAreaElement} input - 輸入框元素
     * @param {string} text - 要插入的文字
     */
    _insertTextAtCursor(input, text) {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        const prefix = input.value.slice(0, start);
        const suffix = input.value.slice(end);
        const spacerBefore = prefix && !/\s$/.test(prefix) ? " " : "";
        const spacerAfter = suffix && !/^\s/.test(suffix) ? " " : "";
        const insertion = `${spacerBefore}${text}${spacerAfter}`;

        input.value = `${prefix}${insertion}${suffix}`;
        const cursor = start + insertion.length;
        input.focus();
        input.setSelectionRange(cursor, cursor);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    /**
     * ============================================
     * 7. 格式工具列邏輯 (Formatting Toolbar)
     * ============================================
     */

    static onFormatBold(event, target) {
        const textarea = target.closest(".window-content")?.querySelector(".YCIO-chat-entry");
        insertTextFormat(textarea, "<b>", "</b>");
    }

    static onFormatItalic(event, target) {
        const textarea = target.closest(".window-content")?.querySelector(".YCIO-chat-entry");
        insertTextFormat(textarea, "<i>", "</i>");
    }

    static onFormatStrikethrough(event, target) {
        const textarea = target.closest(".window-content")?.querySelector(".YCIO-chat-entry");
        insertTextFormat(textarea, "<s>", "</s>");
    }

    static onApplyTextColor(event, target) {
        const wrapper = target.closest(".window-content");
        const picker = wrapper?.querySelector("input[type=color]");
        const textarea = wrapper?.querySelector(".YCIO-chat-entry");

        if (picker && textarea) {
            insertTextFormat(textarea, `<span style="color:${picker.value}">`, `</span>`);
        }
    }

    /**
     * 表符按鈕插入邏輯
     */
    static onFormatInlineAvatar(event, target) {
        // 1. 取得 DOM 與發話身份
        const wrapper = target.closest(".YCIO-floating-chat-window");
        const speakerSelect = wrapper.querySelector("#chat-speaker-select");
        const value = speakerSelect ? speakerSelect.value : "ooc";

        // 使用 helper
        const { actorDoc, user } = getSpeakerFromSelection(value);
        const targetDoc = actorDoc || user;

        if (!targetDoc) return;

        // 2. 讀取並過濾列表 (只顯示有註解的)
        const rawList = targetDoc.getFlag(MODULE_ID, "avatarList") || [];
        const validList = rawList.filter(a => a.label && a.label.trim() !== "");

        // 3. 防呆：如果沒有可用的表情
        if (validList.length === 0) {
            ui.notifications.warn("YCIO.Warning.NoLabeledAvatars", { localize: true });
            return;
        }

        // 4. 定義回呼函式：當玩家選了圖片後要做什麼
        const onPick = (label) => {
            const textarea = target.closest(".window-content")?.querySelector(".YCIO-chat-entry");
            insertTextFormat(textarea, `[[${label}]]`, "");
        };

        // 5. 開啟視窗
        new InlineAvatarPicker(validList, onPick).render(true);
    }

    /**
     * ============================================
     * 8. 打字狀態同步 (Typing Status - Flags)
     * ============================================
     */

    /**
     * 監聽輸入事件：控制 Flag 的開啟與關閉
     */
    _onTypingInput(event) {
        if (this._typingTimeout) clearTimeout(this._typingTimeout);

        // 開始輸入：寫入 Flag = true
        if (!this._isBroadcastingTyping) {
            this._setTypingFlag(true);
            this._isBroadcastingTyping = true;
        }

        // 停止輸入：1.5秒無動作後，Flag = false (unset)
        this._typingTimeout = setTimeout(() => {
            this._setTypingFlag(false);
            this._isBroadcastingTyping = false;
            this._typingTimeout = null;
        }, 1500);
    }

    /**
     * 強制停止打字狀態 (例如按下發送按鈕時)
     */
    _stopTypingBroadcast() {
        if (this._typingTimeout) {
            clearTimeout(this._typingTimeout);
            this._typingTimeout = null;
        }
        if (this._isBroadcastingTyping) {
            this._setTypingFlag(false);
            this._isBroadcastingTyping = false;
        }
    }

    /**
     * 核心：寫入/刪除 User Flags
     * @param {boolean} isTyping - 是否正在打字
     */
    async _setTypingFlag(isTyping) {
        this._typingDesired = isTyping;
        this._typingWrite = this._typingWrite
            .then(async () => {
                const desired = this._typingDesired;
                const current = game.user.getFlag(FLAG_SCOPE, FLAG_KEY) === true;
                if (current === desired) return;
                if (desired) await game.user.setFlag(FLAG_SCOPE, FLAG_KEY, true);
                else await game.user.unsetFlag(FLAG_SCOPE, FLAG_KEY);
            })
            .catch(error => console.error("YCIO | 更新輸入狀態失敗:", error));
        return this._typingWrite;
    }

    /**
     * UI 更新：讀取所有人的 Flag 並顯示在畫面上，也包含處理「稍等一下」
     */
    _updateTypingDisplay() {
        const indicator = this.element.querySelector("#typing-indicator");
        if (!indicator) return;

        // 呼叫 Helper 取得 HTML
        const htmlContent = generateTypingStatusHTML();

        if (htmlContent) {
            indicator.innerHTML = htmlContent;
            indicator.classList.add("active");
        } else {
            indicator.classList.remove("active");
            setTimeout(() => {
                if (!indicator.classList.contains("active")) {
                    indicator.textContent = game.i18n.localize("YCIO.Input.TypingNone");
                }
            }, 300);
        }
    }

    /**
     * ============================================
     * 9. 右鍵選單 (Context Menu)
     * ============================================
     */

    /**
     * 初始化右鍵選單
     * @param {HTMLElement|jQuery} html - 包含訊息元素的父節點
     */
    _initializeContextMenu(html) {
        const element = html instanceof jQuery ? html[0] : html;
        this._contextMenu?.close?.({ animate: false });
        this._contextMenu = this._createContextMenu(
            () => getChatContextOptions(),
            ".message",
            {
                container: element,
                hookName: "getChatMessageContextOptions"
            }
        );
    }

    /**
     * 智慧插入訊息，主要是右鍵選單讓訊息可見或不可見
     * 根據時間戳記，將訊息插入到 DOM 中正確的排序位置
     * @param {ChatMessage} message - 要插入的訊息
     * @param {HTMLElement} log - 滾動區域元素
     */
    async _insertMessageSmartly(message, log) {
        const generation = this._contentGeneration;
        const tabId = this.activeTab;
        if (!isMessageVisibleInTab(message, tabId)) return false;

        let existingElements = Array.from(log.querySelectorAll(".message"));
        const firstMessage = game.messages.get(existingElements[0]?.dataset.messageId);
        if (firstMessage && message.timestamp < firstMessage.timestamp) {
            // Keep the currently loaded history window contiguous. The message
            // will appear naturally if the user scrolls far enough upward.
            this._historyExhausted.delete(tabId);
            return false;
        }

        const htmlElement = await this._getMessageElement(message, { fresh: true });
        if (generation !== this._contentGeneration || tabId !== this.activeTab) return false;
        if (log !== this.element.querySelector("#custom-chat-log")) return false;
        if (game.messages.get(message.id) !== message || !isMessageVisibleInTab(message, tabId)) return false;

        const duplicate = log.querySelector(`[data-message-id="${message.id}"]`);
        if (duplicate) {
            duplicate.replaceWith(htmlElement);
            return true;
        }

        const targetTime = message.timestamp;
        existingElements = Array.from(log.querySelectorAll(".message"));

        // 2. 找到第一條「時間比我晚」的訊息 (代表我應該排在它前面)
        const nextElement = existingElements.find(el => {
            const msgId = el.dataset.messageId;
            const msg = game.messages.get(msgId);
            // 如果找不到 msg (可能被刪了) 或是 msg 時間比我晚，就停在這裡
            return msg && msg.timestamp > targetTime;
        });

        if (nextElement) {
            // 找到了，插在它前面
            log.insertBefore(htmlElement, nextElement);
        } else {
            // 沒找到 (代表我是最新的，或是目前載入的訊息都比我舊) -> 插在最後面
            log.appendChild(htmlElement)

            // 如果原本就在底部，順便捲動一下
            const scrollElement = this.element.querySelector(".chat-scroll") || log;
            const distanceToBottom = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
            if (distanceToBottom < 50) {
                scrollElement.scrollTo({ top: scrollElement.scrollHeight, behavior: "smooth" });
            }
        }
        return true;
    }

    /**
     * ============================================
     * 10. 更新頭像按鈕的 Tooltip (顯示當前圖片預覽)
     * ============================================
     */
    _updateAvatarBtnTooltip() {
        const btn = this.element.querySelector("#chat-avatar-btn");
        if (!btn) return;

        const speakerSelect = this.element.querySelector("#chat-speaker-select");
        const value = speakerSelect ? speakerSelect.value : "ooc";

        // 1. 使用 helper 取得完整資訊
        // 直接解構出需要的資訊：Token 狀態、連結狀態、以及 speaker/user 物件
        const { isToken, isLinked, speaker, user } = getSpeakerFromSelection(value);

        // 判斷是否為「未連結 Token」(是 Token 且 未連結)
        const isUnlinked = isToken && !isLinked;

        // 2. 切換 CSS Class (控制按鈕變灰)
        btn.classList.toggle("YCIO-disabled", isUnlinked);
        btn.setAttribute("aria-disabled", String(isUnlinked));

        // 3. 計算當前頭像 URL
        // resolveCurrentAvatar 需要 {speaker, user} 結構，helper 回傳的物件剛好包含這些
        const currentUrl = resolveCurrentAvatar({ speaker, user });

        // 呼叫 Helper
        const tooltipContent = generateAvatarTooltip(isUnlinked, currentUrl);

        btn.dataset.tooltip = tooltipContent;
        btn.dataset.tooltipClass = "YCIO-avatar-tooltip";
    }

    /**
     * ============================================
     * 11. 原生 ChatLog 相容性介面 (Native Compatibility Shim)
     * ============================================
     * 為了讓系統透過 renderChatMessage 綁定的按鈕能正常運作，必須實作 ChatLog 的標準方法，因為系統會呼叫 app.method()
     */

    /**
     * 許多系統的刪除按鈕會呼叫此方法
     * @param {string} messageId 
     * @param {Object} [options]
     */
    async deleteMessage(messageId, { deleteAll = false } = {}) {
        if (deleteAll) {
            if (game.user.isGM) return game.messages.flush();
            return;
        }
        const message = game.messages.get(messageId);
        if (message?.canUserModify(game.user, "delete")) return message.delete();
    }

    /**
     * 許多系統的更新/編輯按鈕會呼叫此方法
     * @param {ChatMessage} message 
     * @param {Object} updateData 
     */
    async updateMessage(message, updateData) {
        if (message?.canUserModify(game.user, "update")) return message.update(updateData);
    }

    /**
     * 捲動到底部 (某些系統發話後會主動呼叫這個)
     */
    scrollBottom() {
        // 呼叫自己的跳轉邏輯
        const log = this.element.querySelector("#custom-chat-log");
        const scrollContainer = this.element.querySelector(".chat-scroll");
        if (scrollContainer) {
            scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
        } else if (log) {
            log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
        }
    }

    /**
     * 從原生 #chat 元素複製所有相關的 CSS 變數到 YCIO 鏡像容器
     */
    _bridgeCSSVariables() {
        const nativeChat = document.getElementById("chat");
        const mirror = this.element?.querySelector("[data-ycio-css-mirror]");
        if (!nativeChat || !mirror) return;

        const nativeStyle = getComputedStyle(nativeChat);

        // 1. 基底預定義變數列表 (防呆且最常見)
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
                // 排除無效或跨網域的 CSS 規則限制
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
            } catch (e) {
                // 跨網域 (CORS) 樣式表讀取限制，跳過即可
            }
        }

        // 3. 一次性同步所有收集到的變數值
        for (const varName of variablesToBridge) {
            const value = nativeStyle.getPropertyValue(varName).trim();
            if (value) {
                mirror.style.setProperty(varName, value);
            }
        }
    }

    /**
     * 同步原生主題設置與 Class 到鏡像容器
     */
    _syncTheme() {
        const nativeLog = document.querySelector("#chat .chat-log");
        const customLog = this.element?.querySelector("#custom-chat-log");
        if (!customLog) return;

        if (nativeLog) {
            // 直接鏡像原生的 class
            customLog.className = nativeLog.className;
        } else {
            // 後備方案
            const uiConfig = game.settings.get("core", "uiConfig") || {};
            const colorScheme = uiConfig.colorScheme || {};
            const theme = colorScheme.interface || "light";
            customLog.className = `chat-log plain themed theme-${theme}`;
        }
    }
}
