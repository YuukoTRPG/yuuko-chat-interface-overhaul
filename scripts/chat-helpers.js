/**
 * 輔助函式庫 (Helpers)
 * 用於處理資料格式化、邏輯運算等不涉及 UI 渲染的工作
 */

/**
 * 準備發話身份列表 (Speakers)
 * 遍歷場景與 Token，回傳符合下拉選單格式的陣列
 */
import { MODULE_ID } from "./config.js";
import { MessageEditor } from "./message-editor.js";

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
 * --- 取得右鍵選單選項 ---
 * 定義右鍵點擊訊息時的功能：公開、隱藏、刪除
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
          return message?.update({whisper: [], blind: false});
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
          return message?.update({whisper: ChatMessage.getWhisperRecipients("gm").map(u => u.id), blind: false});
        }
      },
      {
        name: "YCIO.Editor.Edit",
        icon: '<i class="fas fa-edit"></i>',
        condition: li => {
          const element = li instanceof jQuery ? li[0] : li;
          const message = game.messages.get(element.dataset.messageId);
          
          // 條件：(我是作者 或 我是GM) 且 訊息不是系統擲骰 (避免改壞擲骰資料)
          // 簡單判斷：沒有 rolls 陣列，或 rolls 為空
          const isRoll = message.rolls.length > 0;
          return (message.isAuthor || game.user.isGM) && !isRoll; 
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

/* ========================================================= */
/* 頭像處理與 HTML 改造 (Avatar & DOM Enrichment)           */
/* ========================================================= */
/**
 * --- 計算當下應該使用哪張頭像 ---
 * 不讀取訊息歷史快照，純粹根據當下的 Actor/User/Token 狀態回傳 URL
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
 * @param {HTMLElement} htmlElement - Foundry 渲染出的原生 DOM
 */
export function enrichMessageHTML(message, htmlElement) {

  // 相容性處理，無論傳進來的是 jQuery 物件還是 HTMLElement (V13標準)，統一轉為原生 DOM
    const element = htmlElement instanceof jQuery ? htmlElement[0] : htmlElement;

    // 1. 取得頭像 (注意：這裡直接呼叫同檔案的函式，不用 this)
    const avatarUrl = getAvatarUrl(message);

    // [修改開始] 判斷是否為無頭像模式
    if (avatarUrl === "__NO_AVATAR__") {
        // A. 無頭像模式
        // 為了讓 CSS 方便處理 (如果需要微調邊距)，我們可以加個 class
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
        // 2. 建立頭像 DOM
        const avatarDiv = document.createElement("div");
        avatarDiv.classList.add("message-avatar");
        const img = document.createElement("img");
        img.src = avatarUrl;
        img.alt = message.speaker.alias || "Avatar";
        avatarDiv.appendChild(img);

        // 3. 建立右側內容容器 (message-body)
        const bodyDiv = document.createElement("div");
        bodyDiv.classList.add("message-body");

        // 4. 移動原本的內容
        const children = Array.from(element.childNodes);
        children.forEach(child => bodyDiv.appendChild(child));

        // 5. 重新組裝
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
 * @param {HTMLElement} htmlElement - 訊息的 DOM 元素
 */
export function triggerRenderHooks(app, message, htmlElement) {
    const mode = game.settings.get(MODULE_ID, "hookCompatibilityMode");
    
    // 將原生 DOM 包裝成 jQuery 物件
    let $html = $(htmlElement);

    // --- 隔離模式 (Clone) ---
    // 專門針對 Shadowrun 5e 這類「全域 + 局部」雙重綁定的系統。
    // 我們傳送一個複製品給 Hook，讓系統去綁定那個不會被使用的複製品，
    // 但第三方模組依然能讀取複製品的資料來顯示特效。
    if (mode === "clone") {
        $html = $html.clone(); // 建立一個隔離的內容
    }

    // 1. 觸發 renderChatMessage
    // 如果是 clone 模式，這裡是把隔離的內容傳出去
    Hooks.call("renderChatMessage", message, $html, message.system || {});
}