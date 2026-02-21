/**
 * 常數設定
 */
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

    // 5. 文字顏色選擇器最後選的顏色
    game.settings.register(MODULE_ID, "lastUsedTextColor", {
        scope: "client",      // 存在玩家端
        config: false,        // 不顯示在設定選單
        type: String,
        default: "#000000"    // 預設黑色
    });

    // --- 操作設定 ---

    // 切換 Enter/Shift+Enter 送出行為 (Client)
    game.settings.register(MODULE_ID, "swapEnterShiftEnter", {
        name: "YCIO.Settings.SwapEnter.Name",
        hint: "YCIO.Settings.SwapEnter.Hint",
        scope: "client",    // 玩家個人設定
        config: true,
        type: Boolean,
        default: false      // 預設未勾選 (Enter 送出)
    });

    // --- 音效設定 ---

    // 通知音效路徑 (World - GM Only)
    game.settings.register(MODULE_ID, "notificationSoundPath", {
        name: "YCIO.Settings.NotificationSound.Name",
        hint: "YCIO.Settings.NotificationSound.Hint",
        scope: "world",     // GM 統一控制
        config: true,
        type: String,
        filePicker: "audio", // V13: 顯示音訊檔案選擇器
        default: `modules/${MODULE_ID}/sounds/page.mp3`, // 預設路徑
        onChange: () => {
            // 僅提示變更
        }
    });

    // 承上一個設定，OOC 是否播放音效 (World - GM Only)
    game.settings.register(MODULE_ID, "playOnOOC", {
        name: "YCIO.Settings.PlayOnOOC.Name",
        hint: "YCIO.Settings.PlayOnOOC.Hint",
        scope: "world",     // GM 統一控制
        config: true,
        type: Boolean,
        default: true       // 預設開啟
    });

    // --- 介面設定 ---

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

    // 是否隱藏原生側邊欄 (World - GM Only)
    game.settings.register(MODULE_ID, "hideNativeSidebar", {
        name: "YCIO.Settings.HideNativeSidebar.Name",
        hint: "YCIO.Settings.HideNativeSidebar.Hint",
        scope: "world",     // GM 統一控制
        config: true,
        type: String,
        choices: {
            "none": "YCIO.Settings.HideNativeSidebar.Choices.None", // 顯示 (預設)
            "all": "YCIO.Settings.HideNativeSidebar.Choices.All",   // 全部隱藏
            "gm": "YCIO.Settings.HideNativeSidebar.Choices.GM"      // 僅 GM 顯示
        },
        default: "none",
        onChange: () => Hooks.callAll("YCIO_UpdateSidebarVisibility") // 觸發主程式的監聽器
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
            min: 0.3,
            max: 1,
            step: 0.05
        },
        onChange: () => Hooks.callAll("YCIO_UpdateStyle") // 觸發自定義 Hook
    });

    // 聊天訊息獨立透明度 (Client)
    game.settings.register(MODULE_ID, "messageOpacity", {
        name: "YCIO.Settings.MessageOpacity.Name",
        hint: "YCIO.Settings.MessageOpacity.Hint",
        scope: "client",
        config: true,
        type: Number,
        default: 1.0,
        range: {            // 顯示為滑桿
            min: 0.5,
            max: 1,
            step: 0.05
        },
        onChange: () => Hooks.callAll("YCIO_UpdateStyle") // 觸發自定義 Hook
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
            // 提示重整，因為這會影響已經渲染出的聊天訊息 DOM
            ui.notifications.info(game.i18n.localize("YCIO.Settings.CleanSender.Changed"));
        }
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

    // --- 相容性設定 ---

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

/**
 * ============================================
 * 設定介面排版
 * ============================================
 */
Hooks.on("renderSettingsConfig", (app, html, data) => {
    // 1. 正確且兼容地取得 DOM 根節點
    // 如果 html 有 .jquery 屬性，代表它是 jQuery 物件，我們取 html[0] (原生的 HTMLElement)
    // 否則直接使用 app.element 或 html 本身
    let domRoot = app.element || (html.jquery ? html[0] : html);

    // 防呆：確保 domRoot 真的是一個可以執行 querySelector 的 DOM 節點
    if (!domRoot || typeof domRoot.querySelector !== "function") {
        domRoot = document;
    }

    /**
     * 定義專門用來插入標題的輔助函數
     * @param {string} settingKey - 設定的鍵值 (例如 "hookArgumentType")
     * @param {string} title - 你想要顯示的標題文字
     * @param {string} icon - FontAwesome 圖示 (例如 "fas fa-plug")
     */
    const injectHeader = (settingKey, title, icon) => {
        // 由於 FVTT V13 和 V12 在繪製設定項目時的 ID 生成方式不同，
        // 同時兼容 name 屬性與 ID 屬性來尋找輸入框是最安全的做法。
        const targetName = `${MODULE_ID}.${settingKey}`;
        const targetId = `settings-config-${MODULE_ID}.${settingKey}`;

        // 2. 尋找目標元素
        const inputElement = domRoot.querySelector(`[name="${targetName}"]`) || domRoot.querySelector(`[id="${targetId}"]`);

        // 3. 嚴格確定元素存在才繼續執行
        if (!inputElement) {
            return;
        }

        const formGroup = inputElement?.closest(".form-group");
        if (!formGroup) return;

        // 防呆：如果這個標題已經被插入過了，就不要重複插入
        if (formGroup.previousElementSibling?.classList?.contains("YCIO-setting-header")) {
            return;
        }

        // 在該設定項之前插入大標題與分隔線
        formGroup.insertAdjacentHTML("beforebegin", `
            <div class="YCIO-setting-header" style="margin-top: 25px; margin-bottom: 10px; border-bottom: 2px solid var(--color-border-light);">
                <h3 style="margin: 0; padding-bottom: 5px; color: var(--color-text-highlight); font-family: var(--font-primary); font-size: 1.25rem;">
                    <i class="${icon}"></i> ${title}
                </h3>
            </div>
        `);
    };

    // 開始執行排版(插入標題)，區分 GM 與玩家視角
    if (game.user.isGM) {
        injectHeader("swapEnterShiftEnter", "操作設定", "fas fa-keyboard");
        injectHeader("notificationSoundPath", "音效設定", "fas fa-music");
        injectHeader("windowTitle", "介面設定", "fas fa-desktop");
        injectHeader("hookArgumentType", "相容性設定", "fas fa-cogs");
    } else {
        // 玩家視角的排版
        injectHeader("swapEnterShiftEnter", "操作設定", "fas fa-keyboard");
        injectHeader("backgroundColor", "介面設定", "fas fa-desktop");
    }

    // console.log("YCIO Debug | 設定介面排版注入完成。");
});