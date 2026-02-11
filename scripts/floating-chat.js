/**
 * Yuuko's Chat Interface Overhaul - 懸浮聊天視窗主邏輯
 * 包含：視窗渲染、聊天記錄管理、輸入處理、打字狀態同步(Flags)、右鍵選單
 */

import {prepareSpeakerList,
        getChatContextOptions,
        enrichMessageHTML,
        resolveCurrentAvatar,
        getSpeakerFromSelection,
        hexToRgba,
        triggerRenderHooks} from "./chat-helpers.js"; //某些函式
import { FLAG_SCOPE, FLAG_KEY, MODULE_ID } from "./config.js"; //某些常數，定義 Flag 作用域和 Key (用於打字狀態同步)
import { AvatarSelector, InlineAvatarPicker } from "./avatar-selector.js"; //頭像選擇器
import { ChatExportDialog } from "./chat-exporter.js"; //聊天記錄匯出

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class FloatingChat extends HandlebarsApplicationMixin(ApplicationV2) {
  
  constructor(options={}) {
    super(options);

    // --- 設定視窗標題 (i18n，優先使用設定中的標題) ---
    const customTitle = game.settings.get(MODULE_ID, "windowTitle");
    this.options.window.title = customTitle || game.i18n.localize("YCIO.WindowTitle");

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
        game.settings.set(MODULE_ID, "floatingChatPosition", pos);
        // console.log("YCIO | 主視窗位置已儲存", pos);
    }, 500);

    // 預設分頁：ooc
    this.activeTab = "ooc";
    //初始化 HTML 快取容器
    this._messageCache = new Map(); 

    // --- 狀態追蹤變數 ---
    this._isLoadingOlder = false;       // 防止重複觸發載入歷史訊息
    this._programmaticScroll = false;   // 用於區分「程式捲動」與「手動捲動」
    this._lastSpeakerValue = null;      //記錄上一次的發言身分，預設為 null
    this._lastFlashTime = 0;            // 記錄上一次觸發閃爍的時間
    
    // --- 打字狀態變數 ---
    this._typingTimeout = null;         // 倒數計時器
    this._isBroadcastingTyping = false; // 避免重複寫入資料庫
    
    // --- Hook 管理 ---
    this._hooks = [];               // 陣列以便管理多個 Hooks
    this._mainHooksRegistered = false; // 用來標記主要 Hooks 是否已註冊

    // --- 監聽設定變更，即時更新視窗樣式 ---
    Hooks.on("YCIO_UpdateStyle", () => this._applyCustomStyles());
  }

  /* ========================================================= */
  /* 1. 視窗設定 (Configuration)                              */
  /* ========================================================= */

  static DEFAULT_OPTIONS = {
    id: "YCIO-floating-chat-window",
    classes: ["YCIO-floating-chat-window"],
    tag: "aside",
    window: {
      title: "YCIO.WindowTitle",
      resizable: true,
      icon: "fas fa-comments"
    },
    position: { width: 800, height: 600 },
    
    // 定義 HTML 中的 data-action 對應的處理函式
    actions: {
      expandRoll: FloatingChat.onExpandRoll,       // 展開/折疊擲骰結果
      deleteMessage: FloatingChat.onDeleteMessage, // 刪除訊息
      jumpToBottom: FloatingChat.onJumpToBottom,   // 跳至底部
      switchTab: FloatingChat.onSwitchTab, // 切換分頁
      toggleMinimize: FloatingChat.onToggleMinimize, // 最小化/還原

      // --- 文字格式工具列 Actions ---
      formatBold: FloatingChat.onFormatBold,
      formatItalic: FloatingChat.onFormatItalic,
      formatStrikethrough: FloatingChat.onFormatStrikethrough,
      applyTextColor: FloatingChat.onApplyTextColor,
      formatInlineAvatar: FloatingChat.onFormatInlineAvatar,
      exportLog: FloatingChat.onExportLog
    }
  };

  static PARTS = {
    tabs: { template: "modules/yuuko-chat-interface-overhaul/templates/chat-tabs.hbs" },
    content: { template: "modules/yuuko-chat-interface-overhaul/templates/chat-window.hbs" },
    input: { template: "modules/yuuko-chat-interface-overhaul/templates/chat-input.hbs" }
  };

  /* ========================================================= */
  /* 2. 靜態動作 (Static Actions)                             */
  /* ========================================================= */

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
    
    if (message) await message.delete();
  }

  /**
   * Action: 跳至底部按鈕點擊
   */
  static onJumpToBottom(event, target) {
    const log = document.getElementById("custom-chat-log");
    if (log) {
        log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
    }
  }

  /* ========================================================= */
  /* 3. 生命週期 (Lifecycle & Rendering)                      */
  /* ========================================================= */

  /**
   * 準備渲染訊息資料
   */
  async _prepareContext(_options) {
    // 1. 準備場景列表 (給 chat-tabs.hbs 使用)
    const scenes = game.scenes.filter(s => s.visible || game.user.isGM).map(s => ({
        id: s.id,
        name: s.navName || s.name,
        active: s.id === this.activeTab
    }));

    // 2. 準備訊息列表 (根據當前 activeTab 過濾)
    const allMessages = game.messages.contents;
    const filteredMessages = [];
    
    // 從最新訊息開始往回找，直到湊滿 50 筆符合當前分頁的訊息
    for (let i = allMessages.length - 1; i >= 0; i--) {
        const msg = allMessages[i];
        if (this._isMessageVisibleInTab(msg)) {
            filteredMessages.unshift(msg); 
            if (filteredMessages.length >= 50) break;
        }
    }

    // 不回傳 renderedMessages 字串陣列給 Handlebars，而是把 DOM 元素準備好，存在 this._contextMessageElements 供 _onRender 使用
    this._contextMessageElements = []; 

    for (const m of filteredMessages) {
        let messageElement;

        // 快取檢查 (現在 Map 裡存的是 HTMLElement)
        if (this._messageCache.has(m.id)) {
            messageElement = this._messageCache.get(m.id);
        } else {
            // 1. 渲染與 DOM 處理
            const html = await m.renderHTML();
            messageElement = html instanceof jQuery ? html[0] : html;
            
            enrichMessageHTML(m, messageElement); // 注入頭像

            // 2. 觸發函式，根據Config決定是 renderChatLog 或 renderChatMessage 綁定事件監聽
            // 只在元素產生時做一次，以後切換分頁都不再做
            triggerRenderHooks(this, m, messageElement);

            // 3. 寫入快取 (存 DOM 物件)
            this._messageCache.set(m.id, messageElement);
        }

        this._contextMessageElements.push(messageElement);
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
        speakers: speakers,
        draftContent: draftContent,
        isGM: game.user.isGM
    };
  }

  /**
   * 覆寫 render 方法
   */
  async render(options, _options) {
        //目的：在 DOM 被銷毀重繪之前，先「快照」當前的發言身分
        //這能確保我們捕捉到使用者「最後一眼看到」的狀態
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

    // --- 將右上角的「關閉(X)」按鈕偽裝成「最小化」按鈕 ---
    const appWindow = document.getElementById(this.id);
    if (appWindow) {
        // 尋找 header 中的關閉按鈕
        const closeBtn = appWindow.querySelector('.window-header [data-action="close"]');
        if (closeBtn) {
            //移除原本的叉叉圖示改用減號
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
                // 將準備好的 DOM 元素注入容器
                // 因為 this._contextMessageElements 裡的是「活的」DOM 物件
                // 瀏覽器會保留上面的事件監聽器 (Event Listeners)
                if (this._contextMessageElements && this._contextMessageElements.length > 0) {
                    const fragment = document.createDocumentFragment();
                    this._contextMessageElements.forEach(el => fragment.appendChild(el));
                    log.appendChild(fragment);
                }

                // 準備傳給 Hook 的 jQuery 物件，如果是隔離模式 (Clone)，複製假容器給它綁定
                let $hookLog = $(log);
                const mode = game.settings.get(MODULE_ID, "hookCompatibilityMode");
                if (mode === "clone") {
                    $hookLog = $hookLog.clone();
                }

                // 全域觸發一次 renderChatLog
                Hooks.call("renderChatLog", this, $hookLog, {});
                // 標記為已綁定
                log.dataset.hooksBound = "true";
            }

            // Scroll 監聽
            log.addEventListener("scroll", this._onChatScroll.bind(this));

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
                        // 這會觸發我們在 _initializeContextMenu 中設定好的選單
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
            });
            
            this._programmaticScroll = true;
            setTimeout(() => {
                log.scrollTop = log.scrollHeight;
                this._initializeContextMenu(log);
                setTimeout(() => { this._programmaticScroll = false; }, 50); 
            }, 0);
        }
    }

    // --- B. 輸入區 (Input) 事件綁定 ---
    // 包含：發話身分選單、頭像按鈕、顏色選擇器、輸入框、發送按鈕
    if (parts.includes("input")) {
        // 1. 發話身分選單
        const speakerSelect = this.element.querySelector("#chat-speaker-select");
        if (speakerSelect) {
            const currentValue = speakerSelect.value;
            const now = Date.now();
            const ANIMATION_DURATION = 1200; // 動畫持續時間 (毫秒)，配合 CSS

            // 如果這是第一次渲染 (null) 不閃爍
            if (this._lastSpeakerValue !== null && this._lastSpeakerValue !== currentValue) {
                this._lastFlashTime = now; // 偵測到變動，更新閃爍時間戳
            }
            // 更新紀錄
            this._lastSpeakerValue = currentValue;

            // --- 執行閃爍邏輯 ---
            // 判斷條件：如果「現在時間」距離「最後閃爍時間」在動畫長度內
            // 這確保了即使 DOM 因為切換分頁被重建，新長出來的 DOM 也會因為符合時間差而繼續閃爍
            if (now - this._lastFlashTime < ANIMATION_DURATION) {
                speakerSelect.classList.remove("YCIO-pulse-animation");
                void speakerSelect.offsetWidth; // 強制 Reflow
                speakerSelect.classList.add("YCIO-pulse-animation");
            }
            
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
                    if (scene) await scene.view(); 
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
                    ev.preventDefault(); ev.stopPropagation(); return;
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
            
            // [新增] 如果有草稿內容，重新調整高度
            if (input.value) this._adjustInputHeight(input);
        }

        if (sendBtn && input) {
            sendBtn.addEventListener("click", async () => {
                 const content = input.value.trim();
                 if (content) {
                     this._stopTypingBroadcast();
                     await this._processMessage(content);
                     input.value = "";
                     input.focus();
                     this._adjustInputHeight(input);
                 }
            });
        }

        // 5. 更新打字狀態顯示 (因為 DOM 重建了，要重新抓元素)
        this._updateTypingDisplay();
    }

    // --- C. 分頁列 (Tabs) 事件綁定 ---
    if (parts.includes("tabs")) {
        const tabs = this.element.querySelectorAll(".tabs .item");
        tabs.forEach(tab => {
            tab.addEventListener("click", (ev) => {
                ev.preventDefault();
                const tabId = ev.currentTarget.dataset.tab;
                this.changeTab(tabId);
            });
        });
    }

    // --- Hooks 註冊 (只需註冊一次) ---
    if (!this._mainHooksRegistered) {
        this._mainHooksRegistered = true; // 鎖定，防止重複註冊
        
        // 1. 輔助函式：註冊並儲存
        const register = (hook, fn) => {
            const id = Hooks.on(hook, fn);
            this._hooks.push({ hook, id });
        };

        // 2. 打字狀態同步
        register("updateUser", (user, changes) => {
            console.log("YCIO Debug | User Update:", user.name, changes);
            if (changes.flags?.[FLAG_SCOPE]) this._updateTypingDisplay();
        });

        // 3. 場景切換監聽 (自動切換分頁)
        register("canvasDraw", (canvas) => {
            const newSceneId = canvas.scene?.id;
            // 如果新場景存在，且當前分頁不是該場景 -> 切換
            // 這會讓分頁始終跟隨 GM 或玩家切換的場景
            if (newSceneId && this.activeTab !== newSceneId) {
                this.changeTab(newSceneId, false);
            }
        });

        // 4. 訊息建立前攔截監聽 (Snapshot Avatar & Force Speaker Identity)
        register("preCreateChatMessage", (messageDoc, initialData, context, userId) => {
            
            const speakerSelect = this.element.querySelector("#chat-speaker-select");
            const selection = speakerSelect ? speakerSelect.value : "ooc";

            // 判斷使用者是否使用了 /ooc 指令
            // CONST.CHAT_MESSAGE_STYLES.OOC 的值為 1
            const isOOCCommand = messageDoc.style === 1;

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
            } 
            else {
                // 選單選的是 Token，且使用者沒打 /ooc -> 強制鎖定為該 Token
                const [sceneId, tokenId] = selection.split(".");
                
                const scene = game.scenes.get(sceneId);
                const token = scene?.tokens.get(tokenId);
                const actorId = token?.actor?.id || null;

                messageDoc.updateSource({
                    speaker: {
                        scene: sceneId,
                        token: tokenId,
                        actor: actorId,
                        alias: token?.name || messageDoc.speaker.alias
                    }
                });
            }

            // [原有邏輯] 計算並寫入頭像快照
            const finalAvatarUrl = resolveCurrentAvatar(messageDoc);
            if (finalAvatarUrl) {
                messageDoc.updateSource({
                    [`flags.${MODULE_ID}.avatarUrl`]: finalAvatarUrl
                });
            }
        });

        // 5. 場景列表更新監聽 (新增/刪除/改名，還有選擇Token時重繪)
        register("controlToken", () => this.render());
        register("createScene", () => this.render());
        register("deleteScene", () => this.render());
        register("updateScene", (scene, changes) => {
            // 取得所有變更的屬性名稱 (Keys)
            const keys = Object.keys(changes);

            // 1. 檢查是否涉及權限變更 (包含 ownership, ownership.default, ownership.UserID...)
            // 使用 includes 可以同時捕捉 "ownership" 和 "ownership.xxxx"
            const ownershipChanged = keys.some(k => k.includes("ownership"));

            // 2. 檢查是否涉及導覽列顯示 (navigation) 或 可見度 (visible)
            const visibilityChanged = keys.includes("navigation") || keys.includes("visible");

            // 3. 檢查名稱變更
            const nameChanged = keys.includes("name") || keys.includes("navName");

            // 只有當上述任一條件成立時，才觸發重繪
            if (ownershipChanged || visibilityChanged || nameChanged) {
                // console.log("YCIO | 偵測到場景關鍵變更，觸發重繪", changes); // Debug 用
                this.render();
            }
        });
    }
  }

  /**
   * 讀取Config設定並套用 CSS 變數
   */
  _applyCustomStyles() {
      if (!this.element) return;

      const colorHex = game.settings.get(MODULE_ID, "backgroundColor");
      const opacity = game.settings.get(MODULE_ID, "backgroundOpacity");

      // 呼叫 Helper RGB轉換
      const rgba = hexToRgba(colorHex, opacity);

      // 設定 CSS 變數，即時改變外觀
      this.element.style.setProperty('--YCIO-bg', rgba);

      // 設定玩家顏色變數 (V13 使用 .css 取得色碼 string)
      const userColor = game.user.color?.css ?? "#f5f5f5";
      this.element.style.setProperty('--user-color', userColor);
  }

  /**
   * 視窗關閉時的清理工作
   */
  async close(options) {
        // 防呆：確保 options 是一個物件，如果它是 undefined 就設為空物件
        options = options || {};

        // 如果傳入 force: true (例如模組卸載、或是程式碼強制關閉時)，才真正執行關閉
        if (options.force) {
            // --- 執行原本的 Hooks 清理工作 ---
            this._hooks.forEach(h => Hooks.off(h.hook, h.id));
            this._hooks = [];
            this._mainHooksRegistered = false;

            // 呼叫父層真正的關閉邏輯
            return super.close(options);
        }

        // --- 否則：只執行最小化 ---
        // 這是 ApplicationV2 內建的方法，會將視窗收折到剩標題列
        return this.minimize();
  }

  /**
   * 自定義最小化/還原動作，替換視窗關閉動作
   */
  static onToggleMinimize(event, target) {
      event.preventDefault();
      // 在 ApplicationV2 的 action 中，this 指向視窗實例
      this.minimize(); 
  }

  /**
   * 覆寫 setPosition 以便在移動/縮放時自動存檔
   */
  setPosition(position={}) {
      // 1. 執行原本的定位邏輯
      const newPosition = super.setPosition(position);
      
      // 2. 觸發存檔 (使用防抖動函式)
      // 注意：newPosition 包含了 {left, top, width, height}
      this._savePositionDebounced(newPosition);

      return newPosition;
  }


  /* ========================================================= */
  /* 4. 處理場景分頁                                           */
  /* ========================================================= */
  /* 靜態動作，對應 HTML 的 data-action="switchTab" */
  static onSwitchTab(event, target) {
    event.preventDefault();
    // 呼叫實例方法 changeTab
    this.changeTab(target.dataset.tab);
  }

  /* --- 切換分頁邏輯 --- */
  async changeTab(tabId, triggerSceneView = true) {
    if (this.activeTab === tabId) return;

    this.activeTab = tabId;

    // 1. 連動切換 FVTT 場景 (僅當目標不是 ooc 時)
    if (triggerSceneView && tabId !== "ooc") {
        const scene = game.scenes.get(tabId);
        if (scene) await scene.view();
    }

    // 2. 重新渲染並「等待」渲染完成 (解決 Race Condition 的關鍵)
    await this.render({ parts: ["tabs", "input"] });

    // 3. 呼叫自定義的 DOM 抽換方法
    await this._refreshChatLogDOM();
  }

  /**
   * 手動抽換聊天容器內的訊息，避免摧毀容器本身
   */
  async _refreshChatLogDOM() {
      const log = this.element.querySelector("#custom-chat-log");
      if (!log) return;

      // 1. 過濾出屬於新分頁的最新 50 筆訊息
      const allMessages = game.messages.contents;
      const filteredMessages = [];
      for (let i = allMessages.length - 1; i >= 0; i--) {
          const msg = allMessages[i];
          if (this._isMessageVisibleInTab(msg)) {
              filteredMessages.unshift(msg);
              if (filteredMessages.length >= 50) break;
          }
      }

      // 2. 清空當前容器內的 DOM 節點 (不摧毀容器本身)
      // 使用 replaceChildren 效能極佳，且不會破壞原本被移出畫面的節點
      log.replaceChildren();

      // 3. 組裝新分頁的 DOM
      const fragment = document.createDocumentFragment();
      for (const m of filteredMessages) {
          let messageElement;

          if (this._messageCache.has(m.id)) {
              messageElement = this._messageCache.get(m.id);
          } else {
              const html = await m.renderHTML();
              messageElement = html instanceof jQuery ? html[0] : html;
              enrichMessageHTML(m, messageElement);
              
              // 觸發單筆訊息的 Hook
              triggerRenderHooks(this, m, messageElement);
              
              this._messageCache.set(m.id, messageElement);
          }
          fragment.appendChild(messageElement);
      }

      // 4. 一次性塞入容器並置底
      log.appendChild(fragment);
      log.scrollTop = log.scrollHeight;
  }

  /* --- 判斷訊息該去哪個分頁 --- */
  _getMessageRoute(message) {
      // 嚴格邏輯：只有帶有 Token ID 的訊息才屬於場景
      // 如果沒有 Token (即使有 Scene ID，例如用 OOC 身分在場景發話)，一律歸類為 OOC
      if (!message.speaker.token) return "ooc";
      
      // 有 Token 則回傳該 Token 所在的 Scene ID
      return message.speaker.scene || "ooc";
  }

  /* --- 判斷訊息是否屬於當前分頁 (過濾器) --- */
  _isMessageVisibleInTab(message) {
      // 首先檢查是否有權限看到這條訊息
      // 如果是 GM 隱藏的訊息，對玩家來說 message.visible 會是 false
      if (!message.visible) return false;

      const msgSceneId = message.speaker.scene;
      const msgTokenId = message.speaker.token;

      if (this.activeTab === "ooc") {
          // OOC 分頁：沒有 Token 的訊息才顯示
          return !msgTokenId; 
      } else {
          // 場景分頁：必須屬於該場景，且必須有 Token
          return msgSceneId === this.activeTab && !!msgTokenId;
      }
  }

  /* ========================================================= */
  /* 5. 聊天記錄管理 (Chat Log Logic)                         */
  /* ========================================================= */

  /**
   * 處理捲動事件
   * 1. 控制「跳至底部」按鈕的顯示/隱藏
   * 2. 觸發「載入舊訊息」
   */
  async _onChatScroll(event) {
    if (this._programmaticScroll) return;
    const log = event.target;
    const jumpBtn = this.element.querySelector(".jump-to-bottom");

    const distanceToBottom = log.scrollHeight - log.scrollTop - log.clientHeight;

    // 距離底部 > 100px 顯示按鈕
    if (distanceToBottom > 100) {
        jumpBtn?.classList.add("visible");
    } 
    // 接近底部 < 50px 隱藏按鈕，並清除未讀標記
    else if (distanceToBottom < 50) {
        jumpBtn?.classList.remove("visible", "unread");
    }

    // 接近頂部 < 50px 且不在載入中 -> 載入歷史訊息
    if (log.scrollTop < 50 && !this._isLoadingOlder) {
        await this._loadOlderMessages(log);
    }
  }

  /**
   * 載入歷史訊息 (無限捲動)
   */
  async _loadOlderMessages(logElement) {
    this._isLoadingOlder = true;

    const firstMessageEl = logElement.querySelector(".message");
    if (!firstMessageEl) { this._isLoadingOlder = false; return; }
    
    const firstMsgId = firstMessageEl.dataset.messageId;
    const allMessages = game.messages.contents;

    // 用 Map 查找物件 + indexOf，比 findIndex 遍歷更快
    const anchorMsg = game.messages.get(firstMsgId);
    
    // 如果該訊息剛好被刪除導致找不到，直接中止
    if (!anchorMsg) { this._isLoadingOlder = false; return; }

    const currentIndex = allMessages.indexOf(anchorMsg);
    
    if (currentIndex <= 0) { this._isLoadingOlder = false; return; }

    // --- 使用過濾器往前搜尋 20 筆 ---
    const BATCH_SIZE = 20;
    const olderMessages = [];
    let searchIndex = currentIndex - 1;

    while (olderMessages.length < BATCH_SIZE && searchIndex >= 0) {
        const msg = allMessages[searchIndex];
        // 只有符合當前分頁的才加入
        if (this._isMessageVisibleInTab(msg)) {
            // 用 push (O(1)) 取代 unshift (O(N))
            olderMessages.push(msg);
        }
        searchIndex--;
    }
    
    // 因為是用 push 收集 (新->舊)，需要反轉回正確的時間序 (舊->新)
    olderMessages.reverse();
    // -------------------------------------

    if (olderMessages.length === 0) { this._isLoadingOlder = false; return; }

    const previousScrollHeight = logElement.scrollHeight;
    const previousScrollTop = logElement.scrollTop;

    const fragment = document.createDocumentFragment();
    for (const msg of olderMessages) {
        const html = await msg.renderHTML();
        enrichMessageHTML(msg, html); // 放入頭像
        fragment.appendChild(html);
    }
    logElement.insertBefore(fragment, logElement.firstChild);

    const newScrollHeight = logElement.scrollHeight;
    logElement.scrollTop = newScrollHeight - previousScrollHeight + previousScrollTop;

    this._isLoadingOlder = false;
  }

  /**
   * 插入新訊息 (由 main.js 的 createChatMessage Hook 呼叫)
   */
  async appendMessage(message) {
    // 1. 取得這則訊息該去哪 (使用核心路由)
    const targetTab = this._getMessageRoute(message);

    // 2. 判定是否需要自動跳轉
    // 條件：是我發的 (isAuthor) 且 當前不在目標分頁
    if (message.isAuthor && this.activeTab !== targetTab) {
        // 等待切換完成 (包含 Render)
        await this.changeTab(targetTab, false);
    }

    // 3. 如果訊息不屬於當前分頁 (且剛剛沒跳轉)，則忽略
    if (!this._isMessageVisibleInTab(message)) return;
 
    // 4. 重新抓取 Log DOM (確保是切換後的新 DOM)
    const log = this.element.querySelector("#custom-chat-log");
    if (!log) return;

    // 判斷使用者是否正在瀏覽舊訊息 (在插入前判斷)
    const distanceToBottom = log.scrollHeight - log.scrollTop - log.clientHeight;
    const isAtBottom = distanceToBottom < 50;

    const htmlElement = await message.renderHTML();
    enrichMessageHTML(message, htmlElement); // 放入頭像
    log.appendChild(htmlElement); 

    // 針對這一條新訊息觸發函式，根據設定決定 renderChatLog 或renderChatMessage
    triggerRenderHooks(this, message, htmlElement);
    // 並同步寫入快取 (這很重要，如此下次切換分頁時，這條帶有事件的 DOM 才會被保留)
    this._messageCache.set(message.id, htmlElement);

    const jumpBtn = this.element.querySelector(".jump-to-bottom");

    // 5. 自動捲動邏輯
    // 如果是我發的 -> 強制置底 (User Experience 核心)
    // 或者原本就在底部 -> 保持置底
    if (message.isAuthor || isAtBottom) {
        // 使用 setTimeout 確保 DOM 佈局計算完成後再捲動 (雙重保險)
        setTimeout(() => {
            log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
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
   */
  deleteMessageFromDOM(messageId) {
    this.invalidateCache(messageId); //清除快取

    const log = this.element.querySelector("#custom-chat-log");
    const el = log?.querySelector(`[data-message-id="${messageId}"]`);
    if (el) {
      $(el).slideUp(200, () => el.remove()); // jQuery 動畫效果
    }
  }


  /**
   * 更新 DOM 中的訊息 (通用同步邏輯)
   * 無論是內容更新、權限變更、公開/隱藏，都統一由此方法處理
   */
  async updateMessageInDOM(message) {
    this.invalidateCache(message.id); //訊息更新清除快取
    const log = this.element.querySelector("#custom-chat-log");
    if (!log) return;

    // 取得目前 DOM 裡的元素
    const el = log.querySelector(`[data-message-id="${message.id}"]`);
    
    // 核心判斷：我有權限看這則訊息嗎？(Foundry 原生屬性)
    const isVisible = message.visible; 

    // 狀況 A: 我沒權限看 (例如被改為私訊)，但它卻在畫面上 -> 移除
    if (!isVisible) {
        if (el) this.deleteMessageFromDOM(message.id);
        return;
    }

    // 狀況 B: 我有權限看，且它已經在畫面上 -> 更新內容
    if (el) {
        const newHtml = await message.renderHTML();
        enrichMessageHTML(message, newHtml); // 放入頭像
        
        // 綁定事件
        triggerRenderHooks(this, message, newHtml);
        // 更新快取
        this._messageCache.set(message.id, newHtml instanceof jQuery ? newHtml[0] : newHtml);
        
        el.replaceWith(newHtml);
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

  /* ========================================================= */
  /* 6. 輸入框邏輯 (Input Handling)                           */
  /* ========================================================= */

  /**
   * 處理 Enter 鍵發送
   */
  async _onChatKeyDown(event) {
    // 監聽 Enter: 如果沒按 Shift 就發送
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault(); // 阻止換行
        this._stopTypingBroadcast(); // 停止打字狀態

        const input = event.target;
        const content = input.value.trim();

        if (content) {
            await this._processMessage(content);
            input.value = "";
            this._adjustInputHeight(input); // 重置高度
        }
    }
  }

  /**
   * 呼叫 FVTT 核心處理訊息 (支援 /r, /w 等指令)
   */
  async _processMessage(content) {
    // 先進行行內頭像替換 (Pre-processing)
    content = this._parseInlineAvatars(content);

    try {
        // 將處理過(可能包含 img 標籤)的內容送給核心
        await ui.chat.processMessage(content);
        // console.log("YCIO | 原始發送訊息：" + content); // Debug 用
    } catch (err) {
        console.error("YCIO | 訊息處理錯誤:", err);
        ui.notifications.error(game.i18n.localize("YCIO.Warning.FailedMsg")+"（"+err+"）");
    }
  }

  /**
   * 解析並替換行內頭像標籤 ([[Tag]])
   */
  _parseInlineAvatars(content) {
      // 1. 取得當前發話身份
      const speakerSelect = this.element.querySelector("#chat-speaker-select");
      const value = speakerSelect ? speakerSelect.value : "ooc";
      
      // 使用 helper 直接取得 Document
      const { actorDoc, user } = getSpeakerFromSelection(value);
      
      // 優先使用 Actor，若無則使用 User (OOC)
      const targetDoc = actorDoc || user;

      // 若找不到文件 (罕見情況) 或該文件沒有設定頭像列表，直接回傳
      if (!targetDoc) return content;
      
      const avatarList = targetDoc.getFlag(MODULE_ID, "avatarList") || [];
      if (avatarList.length === 0) return content;

      // 2. 正則替換核心 
      return content.replace(/\[\[(.*?)\]\]/g, (match, tagLabel) => {
          const found = avatarList.find(a => a.label === tagLabel);
          if (found) {
              return `<img src="${found.src}" class="YCIO-inline-emote" alt="${tagLabel}">`;
          }
          return match;
      });
  }

  /**
   * 輸入框自動長高 (Auto-grow Textarea)
   */
  _adjustInputHeight(input) {
    input.style.height = 'auto'; // 先重置才能算出正確的 scrollHeight
    
    // 限制最大高度為視窗的一半
    const maxHeight = this.element.clientHeight * 0.5;
    const scrollHeight = input.scrollHeight;

    if (scrollHeight > maxHeight) {
        input.style.height = `${maxHeight}px`;
        input.style.overflowY = "auto";
    } else {
        input.style.height = `${scrollHeight}px`;
        input.style.overflowY = "hidden";
    }
  }

  /* ========================================================= */
  /* 7. 格式工具列邏輯 (Formatting Toolbar)               */
  /* ========================================================= */

  /**
   * 通用格式化助手：在 Textarea 游標處插入 HTML 標籤
   * @param {HTMLElement} target - 觸發事件的按鈕 DOM
   * @param {String} startTag - 開始標籤 (如 "<b>")
   * @param {String} endTag - 結束標籤 (如 "</b>")
   */
  static _insertFormat(target, startTag, endTag) {
    // 1. 找到輸入框
    const wrapper = target.closest(".window-content"); 
    const textarea = wrapper?.querySelector(".YCIO-chat-entry");
    
    if (!textarea) return;

    // 2. 取得當前游標位置與選取範圍
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;

    // 3. 進行字串切割與重組
    const selectedText = text.substring(start, end);
    const beforeText = text.substring(0, start);
    const afterText = text.substring(end);

    // 組合新字串
    const newText = beforeText + startTag + selectedText + endTag + afterText;
    
    // 4. 更新輸入框內容
    textarea.value = newText;

    // 5. 處理游標位置
    textarea.focus();
    
    if (start === end) {
      // 狀況 A: 沒有選取文字 -> 游標停在標籤中間 (方便直接打字)
      // 位置 = 前段文字長度 + 開始標籤長度
      textarea.setSelectionRange(start + startTag.length, start + startTag.length);
    } else {
      // 狀況 B: 有選取文字 -> 保持選取狀態 (包住原本的文字)
      // 起點 = 前段 + tag，終點 = 前段 + tag + 原文長度
      textarea.setSelectionRange(start + startTag.length, end + startTag.length);
    }
  }

  // --- 各個按鈕的具體實作 ---

  static onFormatBold(event, target) {
    FloatingChat._insertFormat(target, "<b>", "</b>");
  }

  static onFormatItalic(event, target) {
    FloatingChat._insertFormat(target, "<i>", "</i>");
  }

  static onFormatStrikethrough(event, target) {
    FloatingChat._insertFormat(target, "<s>", "</s>");
  }

  static onApplyTextColor(event, target) {
      // 1. 找到視窗內的色盤 Input
      const wrapper = target.closest(".window-content");
      const picker = wrapper?.querySelector("input[type=color]"); // 找同一視窗內的色盤
      
      if (picker) {
          const color = picker.value;
          // 2. 插入標籤
          FloatingChat._insertFormat(target, `<span style="color:${color}">`, `</span>`);
      }
  }

  // 表符按鈕
  static onFormatInlineAvatar(event, target) {
    // 1. 取得 DOM 與發話身份
    const wrapper = target.closest(".YCIO-floating-chat-window");
    const speakerSelect = wrapper.querySelector("#chat-speaker-select");
    const value = speakerSelect ? speakerSelect.value : "ooc";
    
    // [修改] 使用新版 helper
    const { actorDoc, user } = getSpeakerFromSelection(value);
    const targetDoc = actorDoc || user;

    if (!targetDoc) return;

    // 2. 讀取並過濾列表 (只顯示有註解的)
    const rawList = targetDoc.getFlag(MODULE_ID, "avatarList") || [];
    const validList = rawList.filter(a => a.label && a.label.trim() !== "");

    // 3. 防呆：如果沒有可用的表情
    if (validList.length === 0) {
        ui.notifications.warn("YCIO.Warning.NoLabeledAvatars", {localize: true});
        // 如果還沒設定語言檔，暫時用 ui.notifications.warn("沒有設定註解的頭像可供使用");
        return;
    }

    // 4. 定義回呼函式：當玩家選了圖片後要做什麼
    const onPick = (label) => {
        // 呼叫我們之前寫好的插入助手，插入 [[標籤]]
        FloatingChat._insertFormat(target, `[[${label}]]`, "");
    };

    // 5. 開啟視窗
    new InlineAvatarPicker(validList, onPick).render(true);
  }

  // Action: 開啟聊天紀錄導出視窗
  static onExportLog(event, target) {
      if (!game.user.isGM) return;
      new ChatExportDialog().render(true);
  }

  /* ========================================================= */
  /* 8. 打字狀態同步 (Typing Status - Flags)                  */
  /* ========================================================= */

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
   */
  async _setTypingFlag(isTyping) {
      // 避免重複寫入 (節省資料庫效能)
      const current = game.user.getFlag(FLAG_SCOPE, FLAG_KEY);
      if (current === isTyping) return;

      // console.log(`[YCIO] 更新 Flag: ${isTyping}`);
      if (isTyping) {
          await game.user.setFlag(FLAG_SCOPE, FLAG_KEY, true);
      } else {
          await game.user.unsetFlag(FLAG_SCOPE, FLAG_KEY);
      }
  }

  /**
   * UI 更新：讀取所有人的 Flag 並顯示在畫面上
   */
  _updateTypingDisplay() {
    const indicator = this.element.querySelector("#typing-indicator");
    if (!indicator) return;

    // 找出所有 Flag 為 true 的使用者 (包含自己)
    const typingUsers = game.users.filter(u => {
        return u.getFlag(FLAG_SCOPE, FLAG_KEY) === true;
    });

    const userNames = typingUsers.map(u => u.name);

    if (userNames.length > 0) {
        const typingText = game.i18n.localize("YCIO.Input.Typing");
        indicator.textContent = userNames.join(", ") + typingText;
        indicator.classList.add("active");
    } else {
        indicator.classList.remove("active");
        // 動畫結束後清空文字
        setTimeout(() => { 
            if(!indicator.classList.contains("active")) {
                indicator.textContent = game.i18n.localize("YCIO.Input.TypingNone"); 
            }
        }, 300);
    }
  }

  /* ========================================================= */
  /* 9. 右鍵選單 (Context Menu)                               */
  /* ========================================================= */

  /**
   * 初始化右鍵選單
   */
  _initializeContextMenu(html) {
    // 1. 確保取得原生的 HTMLElement (非 jQuery 物件)
    const element = html instanceof jQuery ? html[0] : html;
    
    let contextMenu;

    // 2. 使用新版路徑 foundry.applications.ux.ContextMenu
    // 3. 傳入 element 而非 $html
    // 4. 加入 jQuery: false 設定
    contextMenu = new foundry.applications.ux.ContextMenu(element, ".message", [], {
        jQuery: false, // 告訴 FVTT 我們使用原生 DOM
        onOpen: (target) => {
            // target 現在是 HTMLElement
            const options = getChatContextOptions();
            
            // 為了相容其他可能還在用 jQuery 的模組 Hook，我們這裡把 target 包回 jQuery 傳出去
            Hooks.call("getChatMessageContextOptions", $(target), options);
            
            contextMenu.menuItems = options;
        }
    });
  }


  /**
   * 智慧插入訊息，主要是右鍵選單讓訊息可見或不可見
   * 根據時間戳記，將訊息插入到 DOM 中正確的排序位置
   */
  async _insertMessageSmartly(message, log) {
      const newHtml = await message.renderHTML();
      enrichMessageHTML(message, newHtml); // 放入頭像

      // --- 綁定事件與快取 ---
      triggerRenderHooks(this, message, newHtml);

      // 2. 寫入快取 (確保之後切換分頁時，這個帶有事件的 DOM 能被重複使用)
      // 注意：要存入原生的 DOM 元素 (如果是 jQuery 物件要取 [0])
      this._messageCache.set(message.id, newHtml instanceof jQuery ? newHtml[0] : newHtml);
      // ---------------------------------------

      const targetTime = message.timestamp;

      // 1. 找出所有現存的訊息 DOM
      const existingElements = Array.from(log.querySelectorAll(".message"));
      
      // 2. 找到第一條「時間比我晚」的訊息 (代表我應該排在它前面)
      const nextElement = existingElements.find(el => {
          const msgId = el.dataset.messageId;
          const msg = game.messages.get(msgId);
          // 如果找不到 msg (可能被刪了) 或是 msg 時間比我晚，就停在這裡
          return msg && msg.timestamp > targetTime;
      });

      if (nextElement) {
          // 找到了，插在它前面
          log.insertBefore(newHtml, nextElement);
      } else {
          // 沒找到 (代表我是最新的，或是目前載入的訊息都比我舊) -> 插在最後面
          log.appendChild(newHtml);
          
          // 如果原本就在底部，順便捲動一下
          const distanceToBottom = log.scrollHeight - log.scrollTop - log.clientHeight;
          if (distanceToBottom < 50) {
              log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
          }
      }
  }

  /* ========================================================= */
  /* 9.更新頭像按鈕的 Tooltip (顯示當前圖片預覽) */
  /* ========================================================= */
  _updateAvatarBtnTooltip() {
      const btn = this.element.querySelector("#chat-avatar-btn");
      if (!btn) return;

      const speakerSelect = this.element.querySelector("#chat-speaker-select");
      const value = speakerSelect ? speakerSelect.value : "ooc";
      
      // 1. 使用 helper 取得完整資訊
      // 我們直接解構出需要的資訊：Token 狀態、連結狀態、以及 speaker/user 物件
      const { isToken, isLinked, speaker, user } = getSpeakerFromSelection(value);
      
      // 判斷是否為「未連結 Token」(是 Token 且 未連結)
      const isUnlinked = isToken && !isLinked;

      // 2. 切換 CSS Class (控制按鈕變灰)
      btn.classList.toggle("YCIO-disabled", isUnlinked);

      // 3. 計算當前頭像 URL
      // resolveCurrentAvatar 需要 {speaker, user} 結構，helper 回傳的物件剛好包含這些
      const currentUrl = resolveCurrentAvatar({ speaker, user });

      // 4. 設定 Tooltip 內容 (保持不變，只移除了解析邏輯)
      let tooltipContent = "";

      if (isUnlinked) {
          tooltipContent = `
            <div style="text-align: left;">
                <div style="margin-bottom: 5px; color: #ffcccc;">${game.i18n.localize("YCIO.Avatar.UnlinkedWarning")}</div>
                <img src="${currentUrl}" style="max-width: 100px; max-height: 100px; border: 1px solid #666; border-radius: 4px; background: black;">
            </div>
          `;
      } else {
          tooltipContent = `
            <div style="text-align: left;">
                <div style="margin-bottom: 5px; font-weight: bold;">${game.i18n.localize("YCIO.Avatar.Current")}</div>
                <img src="${currentUrl}" style="max-width: 100px; max-height: 100px; border: 1px solid #666; border-radius: 4px; background: black;">
            </div>
          `;
      }

      btn.dataset.tooltip = tooltipContent;
      btn.dataset.tooltipClass = "YCIO-avatar-tooltip";
  }

  /* ========================================================= */
  /* 10. 原生 ChatLog 相容性介面 (Native Compatibility Shim)   */
  /* 為了讓系統透過 renderChatMessage 綁定的按鈕能正常運作，  */
  /* 我們必須實作 ChatLog 的標準方法，因為系統會呼叫 app.method()        */
  /* ========================================================= */

  /**
   * 許多系統的刪除按鈕會呼叫此方法
   * @param {string} messageId 
   * @param {Object} [options]
   */
  async deleteMessage(messageId, {deleteAll=false}={}) {
      if (deleteAll) {
          return game.messages.flush();
      }
      const message = game.messages.get(messageId);
      if (message) return message.delete();
  }

  /**
   * 許多系統的更新/編輯按鈕會呼叫此方法
   * @param {ChatMessage} message 
   * @param {Object} updateData 
   */
  async updateMessage(message, updateData) {
      return message.update(updateData);
  }

  /**
   * 捲動到底部 (某些系統發話後會主動呼叫這個)
   */
  scrollBottom() {
      // 呼叫我們自己的跳轉邏輯
      const log = this.element.querySelector("#custom-chat-log");
      if (log) {
           log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
      }
  }

}