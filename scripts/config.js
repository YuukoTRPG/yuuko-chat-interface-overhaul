// --- 常數 ---
export const MODULE_ID = "yuuko-chat-interface-overhaul"; // 統一名稱
export const FLAG_SCOPE = MODULE_ID;
export const FLAG_KEY = "isTyping";

/**
 * 模組設定註冊 (Settings Registration)
 */
export function registerSettings() {

    // --- 隱藏設定 ---
    // 1. 主聊天視窗位置
    game.settings.register(MODULE_ID, "floatingChatPosition", {
        scope: "client",
        config: false,
        type: Object,
        default: {} 
    });

    // 2. 頭像選擇器位置
    game.settings.register(MODULE_ID, "avatarSelectorPosition", {
        scope: "client",
        config: false,
        type: Object,
        default: {}
    });

    // 3. 行內頭像選擇器位置
    game.settings.register(MODULE_ID, "inlinePickerPosition", {
        scope: "client",
        config: false,
        type: Object,
        default: {}
    });

    // 4.文字顏色選擇器最後選的顏色
    game.settings.register(MODULE_ID, "lastUsedTextColor", {
        scope: "client",      // 存在玩家端
        config: false,        // 不顯示在設定選單
        type: String,
        default: "#000000"    // 預設黑色
    });
    

    // 自訂視窗標題 (GM Only)
    game.settings.register(MODULE_ID, "windowTitle", {
        name: "YCIO.Settings.WindowTitle.Name",
        hint: "YCIO.Settings.WindowTitle.Hint",
        scope: "world",     // world = GM 權限，全體同步
        config: true,       // 顯示在設定選單中
        type: String,
        default: "",        // 預設為空 (代表使用預設標題)
        onChange: () => {
             // 標題改變通常需要重繪視窗，這裡我們先發送通知提醒
             ui.notifications.info(game.i18n.localize("YCIO.Settings.WindowTitle.Changed"));
        }
    });

    // 浮動聊天窗背景顏色 (Client)
    game.settings.register(MODULE_ID, "backgroundColor", {
        name: "YCIO.Settings.BackgroundColor.Name",
        hint: "YCIO.Settings.BackgroundColor.Hint",
        scope: "client",    // client = 玩家個人設定
        config: true,
        type: String,
        default: "#000000",
        inputType: "color", // FVTT 會自動生成顏色選擇器
        onChange: () => Hooks.callAll("YCIO_UpdateStyle") // 觸發自定義 Hook
    });

    // 浮動聊天窗背景透明度 (Client)
    game.settings.register(MODULE_ID, "backgroundOpacity", {
        name: "YCIO.Settings.BackgroundOpacity.Name",
        hint: "YCIO.Settings.BackgroundOpacity.Hint",
        scope: "client",
        config: true,
        type: Number,
        default: 0.8,
        range: {            // 顯示為滑桿
            min: 0.1,
            max: 1,
            step: 0.05
        },
        onChange: () => Hooks.callAll("YCIO_UpdateStyle") // 觸發自定義 Hook
    });

    // 預設頭像來源 (Client)
    game.settings.register(MODULE_ID, "useTokenAvatarDefault", {
        name: "YCIO.Settings.UseTokenAvatar.Name",
        hint: "YCIO.Settings.UseTokenAvatar.Hint",
        scope: "client",    // 玩家個人設定
        config: true,       // 顯示在選單
        type: Boolean,      // 勾選框
        default: false,     // 預設未勾選 (即預設使用 Actor 圖片)
        onChange: () => {
             // 當設定變更時，如果頭像選擇視窗剛好是開著的，就重繪它以即時反映變更
             // 使用 V13 標準方式尋找 AppV2 實例，遍歷所有應用程式實例，找到 ID 符合的並重繪
             for (const app of foundry.applications.instances.values()) {
                 if (app.id === "YCIO-avatar-selector") {
                     app.render();
                 }
             }
        }
    });
    
    console.log("YCIO | 設定 (Settings) 已註冊");
}