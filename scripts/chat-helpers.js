/**
 * 輔助函式庫 (Helpers)
 * 用於處理資料格式化、邏輯運算等不涉及 UI 渲染的工作
 */

import { FLAG_SCOPE, FLAG_KEY, MODULE_ID } from "./config.js";
import { MessageEditor } from "./message-editor.js";

/**
 * 準備發話身份列表 (Speakers)
 * 遍歷場景與 Token，回傳符合下拉選單格式的陣列
 * @returns {Array} 包含發言身分選項的陣列
 */
export function prepareSpeakerList() {
    // 1. 找出當前選中的 Token (用於標記 selected)
    const controlled = canvas.tokens?.controlled[0];
    let currentSelectionValue = "ooc"; // 預設 OOC

    if (controlled) {
        // 如果當前有選中 Token，值為 "SceneID.TokenID"
        currentSelectionValue = `${canvas.scene.id}.${controlled.id}`;
    }

    const speakers = [];

    // 2. 加入 OOC 選項
    speakers.push({
        value: "ooc",
        label: `${game.user.name} (${game.i18n.localize("YCIO.Speaker.OOC")})`,
        selected: currentSelectionValue === "ooc"
    });

    // 3. 遍歷所有場景，找出玩家擁有的 Token
    const validScenes = game.scenes.filter(s => s.visible || game.user.isGM);

    for (const scene of validScenes) {
        // 找出該場景中，玩家擁有權限的 Token (且有關聯 Actor)
        const tokens = scene.tokens.filter(t => t.actor && t.actor.isOwner);

        for (const token of tokens) {
            const value = `${scene.id}.${token.id}`;
            speakers.push({
                value: value,
                label: `${token.name} (${scene.navName || scene.name})`,
                selected: value === currentSelectionValue
            });
        }
    }

    return speakers;
}

/**
 * ============================================
 * 取得右鍵選單選項
 * ============================================
 * 定義右鍵點擊訊息時的功能：公開、隱藏、刪除
 * @returns {Array} 包含選單選項設定的陣列
 */
export function getChatContextOptions() {
    return [
        {
            name: "CHAT.RevealMessage",
            icon: '<i class="fa-solid fa-eye"></i>',
            condition: li => {
                const element = li instanceof jQuery ? li[0] : li;
                const message = game.messages.get(element.dataset.messageId);
                const isLimited = message?.whisper.length || message?.blind;
                return isLimited && (game.user.isGM || message?.isAuthor) && message?.isContentVisible;
            },
            callback: li => {
                const element = li instanceof jQuery ? li[0] : li;
                const message = game.messages.get(element.dataset.messageId);
                return message?.update({ whisper: [], blind: false });
            }
        },
        {
            name: "CHAT.ConcealMessage",
            icon: '<i class="fa-solid fa-eye-slash"></i>',
            condition: li => {
                const element = li instanceof jQuery ? li[0] : li;
                const message = game.messages.get(element.dataset.messageId);
                const isLimited = message?.whisper.length || message?.blind;
                return !isLimited && (game.user.isGM || message?.isAuthor) && message?.isContentVisible;
            },
            callback: li => {
                const element = li instanceof jQuery ? li[0] : li;
                const message = game.messages.get(element.dataset.messageId);
                return message?.update({ whisper: ChatMessage.getWhisperRecipients("gm").map(u => u.id), blind: false });
            }
        },
        {
            name: "YCIO.Editor.Edit",
            icon: '<i class="fas fa-edit"></i>',
            condition: li => {
                const element = li instanceof jQuery ? li[0] : li;
                const message = game.messages.get(element.dataset.messageId);

                // 1. 基本權限檢查：只有作者或 GM 能編輯
                if (!message?.isAuthor && !game.user.isGM) return false;

                // 2. 資料層級檢查：如果是擲骰資料 (rolls 陣列 或 type 為 ROLL)，則禁止
                if (message.rolls.length > 0) return false;

                // 檢查 V13 的訊息類型常數 (ROLL = 5)
                if (message.type === CONST.CHAT_MESSAGE_TYPES.ROLL) return false;

                // 3. 內容檢查：避免編輯到內容為空的純系統訊息 (完全由 Flags/Template 渲染的)
                // 如果 content 不存在或 trim 後為空字串，視為不可編輯
                if (!message.content || message.content.trim().length === 0) return false;

                // 4. DOM 特徵黑名單檢查：
                // 如果訊息 HTML 內部包含以下任何一個 Class，視為某種發言訊息以外的訊息，禁止編輯
                const systemUISelectors = [
                    ".dice-roll",     // 核心擲骰結構
                    ".roll",          // 核心擲骰結構2
                    ".chat-card",     // 核心與系統卡片 (D&D 5e, PF2e 等物品/法術卡)
                    ".card-draw",     // 牌庫抽牌
                    ".table-draw",    // 骰表結果
                    ".content-link",  // 內容連結
                    ".roll-card",     // 第三方模組常見樣式
                    ".roll-result",   // 第三方模組常見樣式 
                    ".dice-result",   // 第三方模組常見樣式 
                    ".dice-total",    // 第三方模組常見樣式 
                    ".inline-roll",   // 插入擲骰
                    ".item-card",     // 通用物品卡片樣式
                    ".midi-chat-card" // Midi-QOL 自動化模組專用卡片
                ];

                // 使用 querySelector 檢查 element (li) 內部是否包含上述任何選擇器
                // 只要命中一個，hasSystemUI 就會是 true
                const hasSystemUI = systemUISelectors.some(selector => element.querySelector(selector));

                // 當沒有以上特徵時，才允許編輯
                return !hasSystemUI;
            },
            callback: li => {
                const element = li instanceof jQuery ? li[0] : li;
                const message = game.messages.get(element.dataset.messageId);
                // 啟動編輯器
                new MessageEditor(message).render(true);
            }
        },
        {
            name: "SIDEBAR.Delete",
            icon: '<i class="fa-solid fa-trash"></i>',
            condition: li => {
                const element = li instanceof jQuery ? li[0] : li;
                const message = game.messages.get(element.dataset.messageId);
                return message?.canUserModify(game.user, "delete");
            },
            callback: li => {
                const element = li instanceof jQuery ? li[0] : li;
                const message = game.messages.get(element.dataset.messageId);
                return message?.delete();
            }
        }
    ];
}

/**
 * ============================================
 * 頭像處理與 HTML 改造 (Avatar & DOM Enrichment)
 * ============================================
 */

/**
 * 計算當下應該使用哪張頭像
 * 不讀取訊息歷史快照，純粹根據當下的 Actor/User/Token 狀態回傳 URL
 * @param {ChatMessage} message - 訊息物件
 * @returns {string} 頭像圖片的 URL
 */
export function resolveCurrentAvatar(message) {
    const speaker = message.speaker;
    // 相容性處理，優先讀取 author (V12+), 如果沒有則讀取 user
    const messageUser = message.author ?? message.user;

    // --- 0. 準備資料物件 (TokenDoc & ActorDoc) ---
    let tokenDoc = null;
    let actorDoc = null;

    if (speaker.token) {
        // A. 嘗試從當前 Canvas 找
        const token = canvas.tokens?.get(speaker.token);
        if (token) tokenDoc = token.document;

        // B. 嘗試從指定場景找 (跨場景發話)
        if (!tokenDoc && speaker.scene) {
            const scene = game.scenes.get(speaker.scene);
            tokenDoc = scene?.tokens.get(speaker.token);
        }
    }

    if (speaker.actor) {
        actorDoc = game.actors.get(speaker.actor);
    }

    // --- 1. 檢查自選頭像 (Custom Flag) ---
    // 只有「連結 (Linked) 角色」或「純 User (OOC)」才允許使用自選頭像
    // 未連結 (Unlinked) 角色強制略過此段，直接進入預設邏輯
    const isUnlinked = tokenDoc && !tokenDoc.actorLink;

    if (!isUnlinked) {
        // 檢查 Actor 身上是否有選中特定頭像
        if (actorDoc) {
            const customAvatar = actorDoc.getFlag(MODULE_ID, "currentAvatar");
            if (customAvatar) return customAvatar;
        }

        // 檢查 User 身上是否有選中特定頭像 (OOC)
        if (!tokenDoc && !actorDoc && messageUser) {
            const user = messageUser.id ? messageUser : game.users.get(messageUser);
            if (user) {
                const customAvatar = user.getFlag(MODULE_ID, "currentAvatar");
                if (customAvatar) return customAvatar;
            }
        }
    }

    // --- 2. 預設邏輯 (Default Fallback) ---

    // A. 如果是未連結 Token (Unlinked) -> 強制使用 Token 圖片
    if (isUnlinked && tokenDoc) {
        return tokenDoc.texture.src;
    }

    // B. 如果是連結 Token (Linked) -> 根據設定決定
    if (tokenDoc && tokenDoc.actorLink) {
        const useTokenAsDefault = game.settings.get(MODULE_ID, "useTokenAvatarDefault");

        // 如果設定勾選「用 Token 圖」 -> 回傳 Token 圖
        if (useTokenAsDefault) return tokenDoc.texture.src;

        // 如果設定未勾選 -> 繼續往下走，會讀取 Actor 圖
    }

    // C. 嘗試從 Actor 取得 (預設為 Actor 圖片)
    if (actorDoc) return actorDoc.img;

    // D. 嘗試從 Token 取得 (兜底，萬一沒有 Actor)
    if (tokenDoc) return tokenDoc.texture.src;

    // E. 嘗試從 User 取得 (使用者頭像)
    if (messageUser) {
        const user = messageUser.id ? messageUser : game.users.get(messageUser);
        if (user) return user.avatar;
    }

    // F. 真的什麼都沒有
    return "icons/svg/mystery-man.svg";
}

/**
 * 根據訊息內容取得對應的頭像 URL
 * @param {ChatMessage} message - 訊息物件
 * @returns {string} 頭像的 URL
 */
export function getAvatarUrl(message) {
    // --- 最高優先級 - 讀取訊息本身的歷史快照 (Snapshot) ---
    // 這確保了即使角色後來換了頭像，這條舊訊息依然顯示當時的樣子
    const snapshotAvatar = message.getFlag(MODULE_ID, "avatarUrl");
    if (snapshotAvatar) return snapshotAvatar;

    // 如果沒有快照 (舊訊息或錯誤)，才計算當下狀態
    return resolveCurrentAvatar(message);
}

/**
 * 改造訊息 HTML：注入頭像與調整結構
 * @param {ChatMessage} message - 訊息物件
 * @param {HTMLElement|jQuery} htmlElement - Foundry 渲染出的原生 DOM 或 jQuery 物件
 * @returns {HTMLElement} 處理後 DOM
 */
export function enrichMessageHTML(message, htmlElement) {

    // 相容性處理，無論傳進來的是 jQuery 物件還是 HTMLElement (V13標準)，統一轉為原生 DOM
    const element = htmlElement instanceof jQuery ? htmlElement[0] : htmlElement;

    // --- DOM 淨化：清理發話者區域 (Clean Sender) ---
    const shouldCleanSender = game.settings.get(MODULE_ID, "cleanMessageSender");
    if (shouldCleanSender) {
        const senderEl = element.querySelector('.message-sender');
        if (senderEl) {
            // 取得純文字名稱。優先順序：訊息別名 (Token Name) -> 發話者/作者名稱 -> 預設字串
            const rawName = message.speaker?.alias || message.author?.name || message.user?.name || "Unknown";

            // 使用 textContent 會直接抹除裡面的所有 HTML 標籤 (img, span, div)，只留下純文字，確保不會有其他系統殘留的節點
            senderEl.textContent = rawName;
        }
    }

    // --- 訊息背景色覆蓋：根據 GM 設定動態加入 class ---
    const enableCustomBg = game.settings.get(MODULE_ID, "enableCustomMessageBg");
    if (enableCustomBg) {
        element.classList.add("YCIO-custom-bg");
    }

    // 取得頭像 (注意：這裡直接呼叫同檔案的函式，不用 this)
    const avatarUrl = getAvatarUrl(message);

    // 判斷是否為無頭像模式
    if (avatarUrl === "__NO_AVATAR__") {
        // A. 無頭像模式
        // 為了讓 CSS 方便處理 (如果需要微調邊距)，加個 class
        element.classList.add("no-avatar-mode");

        // 建立右側內容容器 (message-body)
        const bodyDiv = document.createElement("div");
        bodyDiv.classList.add("message-body");

        // 將原本的內容移動進去
        const children = Array.from(element.childNodes);
        children.forEach(child => bodyDiv.appendChild(child));

        // 只加入 bodyDiv，不加入 avatarDiv
        element.appendChild(bodyDiv);
    } else {
        // B. 正常頭像模式，繼續插入頭像
        // 建立頭像 DOM
        const avatarDiv = document.createElement("div");
        avatarDiv.classList.add("message-avatar");
        const img = document.createElement("img");
        img.src = avatarUrl;
        img.alt = message.speaker.alias || "Avatar";
        avatarDiv.appendChild(img);

        // 建立右側內容容器 (message-body)
        const bodyDiv = document.createElement("div");
        bodyDiv.classList.add("message-body");

        // 移動原本的內容
        const children = Array.from(element.childNodes);
        children.forEach(child => bodyDiv.appendChild(child));

        // 重新組裝
        element.appendChild(avatarDiv);
        element.appendChild(bodyDiv);
    }

    // 如果原本傳進來的是 jQuery，這裡回傳原生 DOM 也可以，因為 append 動作是「引用傳遞」，
    // 修改 element 等於修改了原本的 htmlElement[0]，介面會正常更新。
    return element;
}

/**
 * 根據下拉選單的值，解析出完整的身分資訊
 * @param {String} value - 下拉選單的值 (例如 "ooc" 或 "SceneID.TokenID")
 * @returns {Object} 包含 speaker, user, actorDoc, tokenDoc, isToken, isLinked
 */
export function getSpeakerFromSelection(value) {
    // 預設回傳結構 (OOC / User)
    const result = {
        speaker: { scene: null, token: null, actor: null, alias: game.user.name }, // 保持 FVTT speaker 結構
        user: game.user,       // User Document
        actorDoc: null,        // Actor Document
        tokenDoc: null,        // Token Document
        isToken: false,        // 是否為 Token
        isLinked: false        // 是否為連結 (Linked) 角色
    };

    // 情況 1: OOC 或無值
    if (!value || value === "ooc") {
        return result;
    }

    // 情況 2: 選擇了 Token (格式 "SceneID.TokenID")
    const [sceneId, tokenId] = value.split(".");

    result.isToken = true;
    result.speaker.scene = sceneId;
    result.speaker.token = tokenId;

    // 嘗試查找實體 (支援跨場景查找)
    const scene = game.scenes.get(sceneId);
    const tokenDoc = scene?.tokens.get(tokenId);

    if (tokenDoc) {
        result.tokenDoc = tokenDoc;
        result.speaker.alias = tokenDoc.name;
        result.isLinked = tokenDoc.actorLink; // 直接讀取屬性

        if (tokenDoc.actor) {
            result.actorDoc = tokenDoc.actor;
            result.speaker.actor = tokenDoc.actor.id;
        }
    }

    return result;
}

/**
 * 將 Hex 顏色轉為 RGBA 字串
 * @param {String} hex - 色碼 (例如 "#000000")
 * @param {Number} opacity - 透明度 (0 ~ 1)
 * @returns {String} "rgba(...)" 字串
 */
export function hexToRgba(hex, opacity) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * 處理系統相容性的 Hook 觸發邏輯
 * @param {ApplicationV2} app - 呼叫此函式的應用程式實例 (FloatingChat)
 * @param {ChatMessage} message - 訊息文件
 * @param {HTMLElement} htmlElement - 訊息的原生 DOM 元素
 */
export function triggerRenderHooks(app, message, htmlElement) {
    // 1. 取得設定：決定隔離模式與參數型別
    const cloneMode = game.settings.get(MODULE_ID, "hookCompatibilityMode") === "clone";
    const argType = game.settings.get(MODULE_ID, "hookArgumentType") || "jquery";

    // 2. 準備基底元素 (決定要不要 Clone)
    // 由於 htmlElement 已經在 enrichMessageHTML 中被確保為原生 DOM，可以使用原生的 cloneNode(true) 進行深層複製
    let baseElement = cloneMode ? htmlElement.cloneNode(true) : htmlElement;

    // 根據設定，觸發對應世代的 Hook
    if (argType === "native") {
        // 現代版本，傳遞原生 DOM，並使用 V13 全新的 Hook 名稱
        Hooks.callAll("renderChatMessageHTML", message, baseElement, message.system || {});
    } else {
        // 傳統相容，傳遞 jQuery 物件，使用舊的 Hook 名稱
        Hooks.callAll("renderChatMessage", message, $(baseElement), message.system || {});
    }
}


/**
 * ============================================
 * UI 工具與格式化 (UI Utilities & Formatting)
 * ============================================
 */

/**
 * 在 Textarea 游標處插入 HTML 標籤
 * @param {HTMLTextAreaElement} textarea - 目標輸入框
 * @param {String} startTag - 起始標籤
 * @param {String} endTag - 結束標籤
 */
export function insertTextFormat(textarea, startTag, endTag) {
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;

    const selectedText = text.substring(start, end);
    const beforeText = text.substring(0, start);
    const afterText = text.substring(end);

    textarea.value = beforeText + startTag + selectedText + endTag + afterText;
    textarea.focus();

    if (start === end) {
        textarea.setSelectionRange(start + startTag.length, start + startTag.length);
    } else {
        textarea.setSelectionRange(start + startTag.length, end + startTag.length);
    }
}

/**
 * 輸入框自動長高邏輯
 * @param {HTMLTextAreaElement} textarea - 目標輸入框
 * @param {Number} maxPixelHeight - 最大高度限制 (px)
 */
export function autoResizeTextarea(textarea, maxPixelHeight) {
    if (!textarea) return;

    textarea.style.height = "auto";
    const scrollHeight = textarea.scrollHeight;

    if (scrollHeight > maxPixelHeight) {
        textarea.style.height = `${maxPixelHeight}px`;
        textarea.style.overflowY = "auto";
    } else {
        textarea.style.height = `${scrollHeight}px`;
        textarea.style.overflowY = "hidden";
    }
}

/**
 * 套用視窗背景樣式與使用者顏色
 * @param {HTMLElement} element - 視窗 DOM 元素
 * @param {User} user - 目前使用者物件
 */
export function applyWindowStyles(element, user) {
    if (!element) return;

    const colorHex = game.settings.get(MODULE_ID, "backgroundColor");
    const windowOpacity = game.settings.get(MODULE_ID, "backgroundOpacity");
    const messageOpacity = game.settings.get(MODULE_ID, "messageOpacity");

    // 設定 CSS 變數背景色 (純色，無透明度)
    // 但因為將透明度拆分，將它與 rgba 結合給根背景使用，同時保留原始色碼變數以供參考
    const rgba = hexToRgba(colorHex, windowOpacity);

    element.style.setProperty("--YCIO-bg", rgba);
    // 個別元件(如輸入框、標題列)如果需要繼承視窗透明度可使用這個變數 (不過在此情境下可以直接在根節點處理背景)
    element.style.setProperty("--YCIO-window-opacity", windowOpacity);
    // 給訊息泡泡專用的透明度變數
    element.style.setProperty("--YCIO-message-opacity", messageOpacity);

    // 訊息文字顏色覆蓋
    const messageTextColor = game.settings.get(MODULE_ID, "messageTextColor");
    element.style.setProperty("--YCIO-message-text-color", messageTextColor);

    // 自訂訊息背景色覆蓋
    const enableCustomBg = game.settings.get(MODULE_ID, "enableCustomMessageBg");
    if (enableCustomBg) {
        const customBgColor = game.settings.get(MODULE_ID, "customMessageBgColor");
        element.style.setProperty("--YCIO-custom-message-bg", customBgColor);
    } else {
        // 必須移除變數，因為 CSS 變數即使設為空字串仍被視為「已設定」
        element.style.removeProperty("--YCIO-custom-message-bg");
    }

    // 移除全局的 element.style.opacity = opacity 
    element.style.opacity = "";

    // 設定玩家顏色變數 (V13 使用 .css 取得色碼 string)
    const userColor = user.color?.css ?? "#f5f5f5";
    element.style.setProperty("--user-color", userColor);
}

/**
 * ============================================
 * 邏輯判斷 (Logic Predicates)
 * ============================================
 */

/**
 * 判斷訊息是否應該播放通知音效，邏輯：排除自己、檢查路徑、檢查 OOC 設定
 * @param {ChatMessage} message - 訊息物件
 * @returns {boolean} 是否播放
 */
export function shouldPlayNotification(message) {
    // 1. 自己的訊息不播放
    if (message.isAuthor) return false;

    // 2. 檢查是否有設定音效檔案
    const soundPath = game.settings.get(MODULE_ID, "notificationSoundPath");
    if (!soundPath) return false;

    // 3. OOC 判斷
    const isOOC = !message.speaker.token;
    const playOnOOC = game.settings.get(MODULE_ID, "playOnOOC");

    if (isOOC && !playOnOOC) return false;

    // 4. 場景權限檢查：若訊息來自某場景，但玩家無權看到該場景（看不到該分頁），則不播放
    if (!isOOC && message.speaker.scene) {
        const scene = game.scenes.get(message.speaker.scene);
        if (scene && !scene.visible && !game.user.isGM) return false;
    }

    return true;
}

/**
 * 判斷訊息該歸類到哪個分頁 ID
 * @param {ChatMessage} message - 訊息物件
 * @returns {String} 分頁 ID ("ooc" 或場景 ID)
 */
export function getMessageRouteId(message) {
    if (!message.speaker.token) return "ooc";
    return message.speaker.scene || "ooc";
}

/**
 * 判斷訊息是否在指定分頁可見
 * @param {ChatMessage} message - 訊息物件
 * @param {String} activeTabId - 目前啟用的分頁 ID
 * @returns {boolean} 是否可見
 */
export function isMessageVisibleInTab(message, activeTabId) {
    if (!message.visible) return false;

    const msgSceneId = message.speaker.scene;
    const msgTokenId = message.speaker.token;

    if (activeTabId === "ooc") {
        return !msgTokenId;
    } else {
        return msgSceneId === activeTabId && !!msgTokenId;
    }
}

/**
 * 生成打字狀態的 HTML 字串
 * @returns {string|null} 回傳 HTML 字串，若無人打字則回傳 null
 */
export function generateTypingStatusHTML() {
    // 1. 取得正在打字的人
    const typingUsers = game.users.filter(u => u.getFlag(FLAG_SCOPE, FLAG_KEY) === true);

    // 2. 取得正在「請等一下」的人
    const waitingUsers = game.users.filter(u => u.getFlag(FLAG_SCOPE, "isWaiting") === true);

    const statusParts = [];

    if (typingUsers.length > 0) {
        const names = typingUsers.map(u => u.name).join(", ");
        const typingText = game.i18n.localize("YCIO.Input.Typing");
        statusParts.push(`${names} ${typingText}`);
    }

    if (waitingUsers.length > 0) {
        const names = waitingUsers.map(u => u.name).join(", ");
        const waitingText = game.i18n.localize("YCIO.Input.IsWaiting");
        statusParts.push(`<span class="YCIO-status-waiting">${names} ${waitingText}</span>`);
    }

    if (statusParts.length > 0) {
        return statusParts.join(" | ");
    }
    return null;
}

/**
 * 解析並替換行內頭像標籤
 * @param {string} content - 原始訊息內容
 * @param {Document} targetDoc - Actor 或 User 文件
 * @returns {string} 替換後的 HTML
 */
export function parseInlineAvatars(content, targetDoc) {
    if (!targetDoc) return content;

    const avatarList = targetDoc.getFlag(MODULE_ID, "avatarList") || [];
    if (avatarList.length === 0) return content;

    //正則表達式字串替換
    return content.replace(/\[\[(.*?)\]\]/g, (match, tagLabel) => {
        const found = avatarList.find(a => a.label === tagLabel);
        if (found) {
            return `<img src="${found.src}" class="YCIO-inline-emote" alt="${tagLabel}">`;
        }
        return match;
    });
}

/**
 * 生成頭像按鈕的 Tooltip HTML
 * @param {boolean} isUnlinked - 是否為未連結 Token
 * @param {string} currentUrl - 當前使用的頭像 URL
 * @returns {string} HTML 字串
 */
export function generateAvatarTooltip(isUnlinked, currentUrl) {
    if (isUnlinked) {
        return `
            <div style="text-align: left;">
                <div style="margin-bottom: 5px; color: #ffcccc;">${game.i18n.localize("YCIO.Avatar.UnlinkedWarning")}</div>
                <img src="${currentUrl}" style="max-width: 100px; max-height: 100px; border: 1px solid #666; border-radius: 4px; background: black;">
            </div>
        `;
    } else {
        return `
            <div style="text-align: left;">
                <div style="margin-bottom: 5px; font-weight: bold;">${game.i18n.localize("YCIO.Avatar.Current")}</div>
                <img src="${currentUrl}" style="max-width: 100px; max-height: 100px; border: 1px solid #666; border-radius: 4px; background: black;">
            </div>
        `;
    }
}