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

    // 4. 訊息編輯視窗位置
    game.settings.register(MODULE_ID, "messageEditorPosition", {
        scope: "client",
        config: false,
        type: Object,
        default: {}
    });

    // 5.文字顏色選擇器最後選的顏色
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

    // 淨化發言者名稱 (清理其他系統/模組塞入的頭像或徽章)
    game.settings.register(MODULE_ID, "cleanMessageSender", {
        name: "YCIO.Settings.CleanSender.Name",
        hint: "YCIO.Settings.CleanSender.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        // 補充邏輯：如果當前系統是 D&D 5e或某些其他系統，預設值就是 true，否則為 false
        default: ["dnd5e"].includes(game.system.id),
        onChange: () => {
             // 建議提示重整，因為這會影響已經渲染出的聊天訊息 DOM
             ui.notifications.info(game.i18n.localize("YCIO.Settings.CleanSender.Changed"));
        }
    });

    // 決定訊息物件要傳遞原生 DOM 或 jQuery 物件
    game.settings.register(MODULE_ID, "hookArgumentType", {
    name: "YCIO.Settings.HookArgumentType.Name",
    hint: "YCIO.Settings.HookArgumentType.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
        "jquery": "YCIO.Settings.HookArgumentType.Choices.jQuery",
        "native": "YCIO.Settings.HookArgumentType.Choices.native"
    },
    default: "native",
    requiresReload: true,
    onChange: () => {
             ui.notifications.info(game.i18n.localize("YCIO.Settings.HookArgumentType.Changed"));
    }
    });

    // 訊息渲染模式的設定，renderChatLog/renderChatMessage/停用Hook
    game.settings.register(MODULE_ID, "hookCompatibilityMode", {
        name: "YCIO.Settings.HookMode.Name",
        hint: "YCIO.Settings.HookMode.Hint",
        scope: "world",
        config: true,
        default: "standard", // 預設使用標準模式
        requiresReload: true,
        type: String,
        choices: {
            "standard": "YCIO.Settings.HookMode.Standard", // "標準 (D&D 5e, PF2e) - 僅觸發 renderChatMessage",
            "clone": "YCIO.Settings.HookMode.Clone"        // "隔離 (SR 5e) - 使用 DOM 副本觸發 Hook"
        },
        onChange: () => {
             ui.notifications.info(game.i18n.localize("YCIO.Settings.HookMode.Changed"));
        }
    });
    
    console.log("YCIO | 設定 (Settings) 已註冊");
}

// ================
// 設定介面排版
// ================
Hooks.on("renderSettingsConfig", (app, html, data) => {
    // 確保取得正確的 DOM 根節點 (相容 FVTT 不同的渲染模式)
    const root = app.element ? app.element : (html instanceof HTMLElement ? html : document);

    /**
     * 定義專門用來插入標題的輔助函數
     * @param {string} settingKey - 設定的鍵值 (例如 "hookArgumentType")
     * @param {string} title - 你想要顯示的標題文字
     * @param {string} icon - FontAwesome 圖示 (例如 "fas fa-plug")
     */
    const injectHeader = (settingKey, title, icon) => {
        // 直接組合出 FVTT 生成的 ID
        const targetId = `settings-config-yuuko-chat-interface-overhaul.${settingKey}`;
        const inputElement = root.querySelector(`[id="${targetId}"]`);
        
        if (!inputElement) {
            //console.warn(`YCIO Debug | 找不到設定項: ${settingKey}，跳過排版。`);
            return;
        }

        const formGroup = inputElement.closest(".form-group");
        if (!formGroup) return;

        // 防呆：如果這個標題已經被插入過了，就不要重複插入
        if (formGroup.previousElementSibling && formGroup.previousElementSibling.classList.contains("ycio-setting-header")) {
            return;
        }

        // 在該設定項之前插入大標題與分隔線
        formGroup.insertAdjacentHTML("beforebegin", `
            <div class="ycio-setting-header" style="margin-top: 25px; margin-bottom: 10px; border-bottom: 2px solid var(--color-border-light);">
                <h3 style="margin: 0; padding-bottom: 5px; color: var(--color-text-highlight); font-family: var(--font-primary); font-size: 1.25rem;">
                    <i class="${icon}"></i> ${title}
                </h3>
            </div>
        `);
    };

    // 開始執行排版，可以自由增加或修改這裡的項目
    // 在「自訂視窗標題」前面加上【介面與視覺設定】標題
    injectHeader("windowTitle", "介面與視覺設定", "fas fa-desktop");
    // 在「系統相容性」前面加上【進階與相容性設定】標題
    injectHeader("hookArgumentType", "進階與相容性設定", "fas fa-cogs");

    //console.log("YCIO Debug | 設定介面排版注入完成。");
});