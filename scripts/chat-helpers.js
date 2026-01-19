/**
 * 輔助函式庫 (Helpers)
 * 用於處理資料格式化、邏輯運算等不涉及 UI 渲染的工作
 */

/**
 * 準備發話身份列表 (Speakers)
 * 遍歷場景與 Token，回傳符合下拉選單格式的陣列
 */
import { MODULE_ID } from "./config.js";

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
        label: `${game.i18n.localize("YCIO.Speaker.OOC")} (${game.user.name})`,
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

    // 1. 檢查 Actor 身上是否有選中特定頭像 (Custom Flag)
    if (speaker.actor) {
        const actor = game.actors.get(speaker.actor);
        if (actor) {
            const customAvatar = actor.getFlag(MODULE_ID, "currentAvatar");
            if (customAvatar) return customAvatar;
        }
    }
    
    // 2. 檢查 User 身上是否有選中特定頭像 (OOC Custom Flag)
    if (!speaker.token && !speaker.actor && message.user) {
         const user = message.user.id ? message.user : game.users.get(message.user);
         if (user) {
             const customAvatar = user.getFlag(MODULE_ID, "currentAvatar");
             if (customAvatar) return customAvatar;
         }
    }
    
    // --- 如果都沒有自選，以下是「預設」邏輯 ---

    // 3. 嘗試從 Token 取得
    if (speaker.token) {
        // A. 嘗試從當前 Canvas 找
        const token = canvas.tokens?.get(speaker.token);
        if (token) return token.document.texture.src;
        
        // B. 嘗試從指定場景找 (跨場景發話)
        if (speaker.scene) {
            const scene = game.scenes.get(speaker.scene);
            const tokenDoc = scene?.tokens.get(speaker.token);
            if (tokenDoc) return tokenDoc.texture.src;
        }
    }

    // 4. 嘗試從 Actor 取得 (Prototype Token 或 Actor Image)
    if (speaker.actor) {
        const actor = game.actors.get(speaker.actor);
        if (actor) return actor.img;
    }

    // 5. 嘗試從 User 取得 (使用者頭像)
    if (message.user) {
        // 相容性處理：有時候 message.user 只是 ID
        const user = message.user.id ? message.user : game.users.get(message.user);
        if (user) return user.avatar;
    }

    // 6. 真的什麼都沒有，回傳神秘人
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
    // 1. 取得頭像 (注意：這裡直接呼叫同檔案的函式，不用 this)
    const avatarUrl = getAvatarUrl(message);

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
    const children = Array.from(htmlElement.childNodes);
    children.forEach(child => bodyDiv.appendChild(child));

    // 5. 重新組裝
    htmlElement.appendChild(avatarDiv);
    htmlElement.appendChild(bodyDiv);
    
    return htmlElement;
}