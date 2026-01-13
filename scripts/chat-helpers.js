/**
 * 輔助函式庫 (Helpers)
 * 用於處理資料格式化、邏輯運算等不涉及 UI 渲染的工作
 */

/**
 * 準備發話身份列表 (Speakers)
 * 遍歷場景與 Token，回傳符合下拉選單格式的陣列
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