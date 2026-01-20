/**
 * Yuuko's Chat Interface Overhaul - 懸浮聊天視窗主邏輯
 * 包含：視窗渲染、聊天記錄管理、輸入處理、打字狀態同步(Flags)、右鍵選單
 */

import { prepareSpeakerList, getChatContextOptions, enrichMessageHTML, resolveCurrentAvatar} from "./chat-helpers.js"; //某些函式
import { FLAG_SCOPE, FLAG_KEY, MODULE_ID } from "./config.js"; //某些常數，定義 Flag 作用域和 Key (用於打字狀態同步)
import { AvatarSelector } from "./avatar-selector.js"; //頭像選擇器

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class FloatingChat extends HandlebarsApplicationMixin(ApplicationV2) {
  
  constructor(options={}) {
    super(options);
    // 預設分頁：若有場景則為場景ID，否則為 ooc
    this.activeTab = canvas.scene?.id || "ooc";

    // --- 設定視窗標題 (使用 i18n，優先使用設定中的標題) ---
    const customTitle = game.settings.get(MODULE_ID, "windowTitle");
    this.options.window.title = customTitle || game.i18n.localize("YCIO.WindowTitle");

    // --- 狀態追蹤變數 ---
    this._isLoadingOlder = false;       // 防止重複觸發載入歷史訊息
    this._programmaticScroll = false;   // 用於區分「程式捲動」與「手動捲動」
    
    // --- 打字狀態變數 ---
    this._typingTimeout = null;         // 倒數計時器
    this._isBroadcastingTyping = false; // 避免重複寫入資料庫
    
    // --- Hook 管理 ---
    this._hooks = [];               // 陣列以便管理多個 Hooks

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
      switchTab: FloatingChat.onSwitchTab // 切換分頁
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

    const renderedMessages = [];
    for (const m of filteredMessages) {
      const html = await m.renderHTML(); // HTMLElement (jQuery object in v12, Element in v13)
      enrichMessageHTML(m, html[0] || html); // 注入頭像，相容 jQuery 與原生 DOM
      renderedMessages.push({ id: m.id, html: html.outerHTML }); // 使用修改後的 outerHTML
    }

    // 準備發話身份列表 (Speakers)，呼叫chat-helpers.js的函式
    const speakers = prepareSpeakerList();

    return { 
        messages: renderedMessages,
        scenes: scenes,
        activeTab: this.activeTab,
        speakers: speakers
    };
  }

  /**
   * 渲染後的邏輯 (DOM Listeners & Hooks)
   */
  _onRender(context, options) {
    super._onRender(context, options);

    // --- 每次渲染時套用最新的背景設定 ---
    this._applyCustomStyles();

    // --- 聊天記錄區域 ---
    const log = this.element.querySelector("#custom-chat-log");
    if (log) {
        log.addEventListener("scroll", this._onChatScroll.bind(this));
        requestAnimationFrame(() => {
            log.scrollTop = log.scrollHeight;
            this._initializeContextMenu(log);
        });
    }

    // --- 選單元素，下拉選單選擇發言Token與監聽邏輯 ---
    const speakerSelect = this.element.querySelector("#chat-speaker-select");

    if (speakerSelect) {
        speakerSelect.addEventListener("change", async (ev) => {
            const value = ev.target.value;
            
            // 情況 1: 選擇 OOC
            if (value === "ooc") {
                if (canvas.tokens) canvas.tokens.releaseAll();
                return;
            }

            // 情況 2: 選擇某個 Token (格式: SceneID.TokenID)
            const [sceneId, tokenId] = value.split(".");
            
            // 2.1 如果目標在不同場景 -> 轉場
            if (canvas.scene?.id !== sceneId) {
                const scene = game.scenes.get(sceneId);
                if (scene) await scene.view(); 
            }

            // 2.2 選取 Token 並切換分頁
            if (canvas.scene?.id === sceneId) {
                const token = canvas.tokens.placeables.find(t => t.id === tokenId);
                if (token) {
                    token.control({ releaseOthers: true }); // 選取 Token
                    this.changeTab(sceneId, false);         // 切換分頁
                }
            }
        });
    }

    // --- 頭像設定按鈕 ---
    const avatarBtn = this.element.querySelector("#chat-avatar-btn");
    if (avatarBtn) {
        avatarBtn.addEventListener("click", () => {
            // 1. 判斷現在選的是誰 (下拉選單的值)
            const speakerSelect = this.element.querySelector("#chat-speaker-select");
            const value = speakerSelect ? speakerSelect.value : "ooc";
            
            let targetDoc;

            if (value === "ooc") {
                targetDoc = game.user; // 目標是 User
            } else {
                // value 格式是 "SceneID.TokenID"
                const [sceneId, tokenId] = value.split(".");
                const scene = game.scenes.get(sceneId);
                const token = scene?.tokens.get(tokenId);
                if (token && token.actor) {
                    targetDoc = token.actor; // 目標是 Actor
                }
            }

            if (targetDoc) {
                new AvatarSelector(targetDoc).render(true);
            }
        });
    }
    // --- 初始化 頭像按鈕的Tooltip ---
    this._updateAvatarBtnTooltip();
    // --- 監聽下拉選單變化，更新 Tooltip ---
    if (speakerSelect) {
        speakerSelect.addEventListener("change", () => this._updateAvatarBtnTooltip());
    }
    // --- 監聽頭像變更 Hook (由 AvatarSelector 觸發)，更新 Tooltip ---
    // 檢查是否已經註冊過這個 Hook，避免重複註冊
    const hookName = "YCIO_AvatarChanged";
    if (!this._hooks.some(h => h.hook === hookName)) {
        const id = Hooks.on(hookName, () => this._updateAvatarBtnTooltip());
        this._hooks.push({ hook: hookName, id });
    }

    // --- 輸入框與按鈕 ---
    const input = this.element.querySelector("#chat-message-input");
    const sendBtn = this.element.querySelector("#chat-send-btn");
    
    if (input) {
        input.addEventListener("keydown", this._onChatKeyDown.bind(this));
        input.addEventListener("input", () => this._adjustInputHeight(input));
        input.addEventListener("input", this._onTypingInput.bind(this));
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

    // --- 手動綁定分頁切換 (解決點擊無效問題) ---
    // 穩健的做法，確保每次渲染後點擊都有效
    const tabs = this.element.querySelectorAll(".tabs .item");
    tabs.forEach(tab => {
        tab.addEventListener("click", (ev) => {
            ev.preventDefault();
            const tabId = ev.currentTarget.dataset.tab;
            this.changeTab(tabId);
        });
    });

    // --- 打字狀態顯示 ---
    this._updateTypingDisplay();

    // --- Hooks 註冊 (只需註冊一次) ---
    if (this._hooks.length === 0) {
        
        // 1. 輔助函式：註冊並儲存
        const register = (hook, fn) => {
            const id = Hooks.on(hook, fn);
            this._hooks.push({ hook, id });
        };

        // 2. 打字狀態同步
        register("updateUser", (user, changes) => {
            if (changes.flags?.[FLAG_SCOPE]) this._updateTypingDisplay();
        });

        // 3. 場景切換監聽 (自動切換分頁)
        register("canvasDraw", (canvas) => {
            const newSceneId = canvas.scene?.id;
            if (this.activeTab !== "ooc" && newSceneId && this.activeTab !== newSceneId) {
                this.changeTab(newSceneId, false);
            }
        });

        // 4. 訊息建立前攔截監聽 (Snapshot Avatar)
        // 在訊息寫入資料庫前，將當前的頭像設定「烙印」到訊息的 flags 裡
        register("preCreateChatMessage", (messageDoc, initialData, context, userId) => {
            // 呼叫 helper 計算當下應該是用哪張圖
            // messageDoc 此時雖然還沒存檔，但已經具備 user, speaker 等屬性，足夠用來判斷
            const finalAvatarUrl = resolveCurrentAvatar(messageDoc);

            // 只要算得出來，就寫入 flags
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
            // 只有當名字、導航顯示或權限變更時才重繪，節省效能
            if (changes.name || changes.navName || ('visible' in changes) || ('ownership' in changes)) {
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

      // 簡單的 Hex 轉 RGB 轉換
      const r = parseInt(colorHex.slice(1, 3), 16);
      const g = parseInt(colorHex.slice(3, 5), 16);
      const b = parseInt(colorHex.slice(5, 7), 16);
      
      const rgba = `rgba(${r}, ${g}, ${b}, ${opacity})`;

      // 設定 CSS 變數，即時改變外觀
      this.element.style.setProperty('--ycio-bg', rgba);
  }

  /**
   * 視窗關閉時的清理工作
   */
  async close(options) {
      // 正確移除所有監聽的 Hook
      this._hooks.forEach(h => Hooks.off(h.hook, h.id));
      this._hooks = [];
      return super.close(options);
  }


  /* ========================================================= */
  /* 3.5 處理場景分頁                                           */
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

    // 1. 如果是場景 ID 且不是 ooc，連動切換 FVTT 場景
    if (triggerSceneView && tabId !== "ooc") {
        const scene = game.scenes.get(tabId);
        if (scene) await scene.view();
    }

    // 2. 重新渲染視窗 (刷新 Tabs 樣式與訊息內容)
    this.render();
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
  /* 4. 聊天記錄管理 (Chat Log Logic)                         */
  /* ========================================================= */

  /**
   * 處理捲動事件
   * 1. 控制「跳至底部」按鈕的顯示/隱藏
   * 2. 觸發「載入舊訊息」
   */
  async _onChatScroll(event) {
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
   * 載入歷史訊息 (無限捲動核心)
   */
　　async _loadOlderMessages(logElement) {
    this._isLoadingOlder = true;

    const firstMessageEl = logElement.querySelector(".message");
    if (!firstMessageEl) { this._isLoadingOlder = false; return; }
    
    const firstMsgId = firstMessageEl.dataset.messageId;
    const allMessages = game.messages.contents;
    const currentIndex = allMessages.findIndex(m => m.id === firstMsgId);
    
    if (currentIndex <= 0) { this._isLoadingOlder = false; return; }

    // --- 使用過濾器往前搜尋 20 筆 ---
    const BATCH_SIZE = 20;
    const olderMessages = [];
    let searchIndex = currentIndex - 1;

    while (olderMessages.length < BATCH_SIZE && searchIndex >= 0) {
        const msg = allMessages[searchIndex];
        // 只有符合當前分頁的才加入
        if (this._isMessageVisibleInTab(msg)) {
            olderMessages.unshift(msg);
        }
        searchIndex--;
    }
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
    // 當訊息是自己發的，強制檢查並切換到對應分頁
    if (message.isAuthor) {
        const msgSceneId = message.speaker.scene;
        const targetTab = msgSceneId || "ooc";
        
        if (this.activeTab !== targetTab) {
            // 切換分頁 (不強制 view scene，因為如果是 Token 發話，上面的下拉選單已經處理過了)
            this.changeTab(targetTab, false); 
        }
    }

    // 如果訊息不屬於當前分頁，直接忽略，不插入 DOM
    if (!this._isMessageVisibleInTab(message)) return;
 
    const log = this.element.querySelector("#custom-chat-log");
    if (!log) return;

    // 判斷使用者是否正在瀏覽舊訊息
    const distanceToBottom = log.scrollHeight - log.scrollTop - log.clientHeight;
    const isAtBottom = distanceToBottom < 50;

    const htmlElement = await message.renderHTML();
    enrichMessageHTML(message, htmlElement); // 放入頭像
    log.appendChild(htmlElement); 

    const jumpBtn = this.element.querySelector(".jump-to-bottom");

    // 自動捲動邏輯：
    // 如果原本就在底部，或是自己發的訊息 -> 強制捲動到底部
    if (isAtBottom || message.isAuthor) {
        log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
        jumpBtn?.classList.remove("visible", "unread");
    } else {
        // 否則 -> 顯示未讀提示
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
        el.replaceWith(newHtml);
        return;
    }

    // 狀況 C: 我有權限看，但它不在畫面上 (例如 GM 剛剛重新公開) -> 插入到正確位置
    // 這時候不能只用 append，因為這可能是一條舊訊息
    await this._insertMessageSmartly(message, log);
  }

  /* ========================================================= */
  /* 5. 輸入框邏輯 (Input Handling)                           */
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
    try {
        await ui.chat.processMessage(content);
        console.log("YCIO | 原始發送訊息：" + content);
    } catch (err) {
        console.error("YCIO | 訊息處理錯誤:", err);
        ui.notifications.error("訊息發送失敗");
    }
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
  /* 6. 打字狀態同步 (Typing Status - Flags)                  */
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
  /* 7. 右鍵選單 (Context Menu)                               */
  /* ========================================================= */

  /**
   * 初始化右鍵選單
   */
  _initializeContextMenu(html) {
    const $html = $(html);
    let contextMenu;

    contextMenu = new ContextMenu($html, ".message", [], {
        onOpen: ($target) => {
            const options = getChatContextOptions();
            Hooks.call("getChatMessageContextOptions", $target, options);
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
  /* 8.更新頭像按鈕的 Tooltip (顯示當前圖片預覽) */
  /* ========================================================= */
  _updateAvatarBtnTooltip() {
      const btn = this.element.querySelector("#chat-avatar-btn");
      if (!btn) return;

      const speakerSelect = this.element.querySelector("#chat-speaker-select");
      const value = speakerSelect ? speakerSelect.value : "ooc";
      
      // 建構一個假 Message 物件，傳給 resolveCurrentAvatar 用
      // 這是為了複用 resolveCurrentAvatar 的邏輯
      let dummyMessage = { speaker: {}, user: null };

      if (value === "ooc") {
          dummyMessage.user = game.user;
      } else {
          // value 格式是 "SceneID.TokenID"
          const [sceneId, tokenId] = value.split(".");
          dummyMessage.speaker = { scene: sceneId, token: tokenId, actor: null };
          
          // 嘗試找出 Actor ID (為了讓 resolveCurrentAvatar 能讀到 flag)
          const scene = game.scenes.get(sceneId);
          const token = scene?.tokens.get(tokenId);
          if (token && token.actor) {
              dummyMessage.speaker.actor = token.actor.id;
          }
      }

      // 計算當前頭像 URL
      const currentUrl = resolveCurrentAvatar(dummyMessage);
      
      // 設定 HTML Tooltip
      // 這裡使用 Foundry 的 data-tooltip 屬性，它支援 HTML
      const tooltipContent = `
        <div style="text-align: center;">
            <div style="margin-bottom: 5px; font-weight: bold;">${game.i18n.localize("YCIO.Avatar.Current")}</div>
            <img src="${currentUrl}" style="max-width: 100px; max-height: 100px; border: 1px solid #666; border-radius: 4px; background: black;">
        </div>
      `;
      
      btn.dataset.tooltip = tooltipContent;
      // 確保沒有 aria-label 干擾 tooltip 顯示 (如果有的話)
      // btn.removeAttribute("aria-label"); 

      // --- 指定 Tooltip 的 CSS 類別，把這個 class 加到 #tooltip 元素上
      btn.dataset.tooltipClass = "ycio-avatar-tooltip";
  }
}