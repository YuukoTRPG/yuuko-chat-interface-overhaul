/**
 * Yuuko's Chat Interface Overhaul - 主程式入口 (Main Entry)
 * 負責模組初始化、生命週期管理以及全域訊息事件的掛鉤。
 */

import { FloatingChat } from "./floating-chat.js";
import { MODULE_ID, registerSettings } from "./config.js";

// 用於儲存視窗實例，讓下方的 Hooks 可以存取它
let floatingChatInstance;

/**
 * Foundry Hooks do not await async callbacks. FloatingChat owns one content
 * queue shared by message mutations, tab changes, history loads and route refreshes.
 */
function queueMessageSync(task) {
    const app = floatingChatInstance;
    if (app?.rendered) void app.queueContentMutation(() => task(app));
}

/**
 * --------------------------------------------
 * 生命週期 Hooks (Lifecycle Hooks)            
 * --------------------------------------------
 */

Hooks.once("init", () => {
    // 初始化 Log
    console.log("YCIO | 模組初始化中 (Init)...");
    registerSettings(); // 註冊設定
});

Hooks.once("ready", async () => {
    console.log("YCIO | 模組準備就緒 (Ready)");
    // 初始化原生側邊欄顯示狀態
    updateNativeSidebarVisibility();
    // 建立視窗實例
    floatingChatInstance = new FloatingChat();
    // 渲染視窗 (參數 true 代表強制顯示)
    try {
        await floatingChatInstance.render(true);
        // 補入初次 render 快照期間建立、當時尚無 DOM 可接收的訊息。
        await floatingChatInstance.reconcileMessages();
    } catch (error) {
        console.error("YCIO | 初始聊天視窗渲染失敗:", error);
        ui.notifications.error(game.i18n.localize("YCIO.Warning.InitialRenderFailed"));
    }
});

/**
 * 更新原生側邊欄的可見度，讀取設定並切換 Body Class
 */
function updateNativeSidebarVisibility() {
    // Lowercase also repairs the legacy invalid default value "All".
    const mode = String(game.settings.get(MODULE_ID, "hideNativeSidebar") || "none").toLowerCase();
    const isGM = game.user.isGM;

    // 判斷是否需要隱藏
    let shouldHide = false;
    if (mode === "all") {
        shouldHide = true;
    } else if (mode === "gm") {
        shouldHide = !isGM; // 如果是 GM 模式，且不是 GM，就隱藏
    }

    // 操作 CSS Class
    if (shouldHide) {
        document.body.classList.add("YCIO-hide-native-ui");
    } else {
        document.body.classList.remove("YCIO-hide-native-ui");
    }
}

/**
 * --------------------------------------------
 * 聊天訊息同步 Hooks (Chat Message Sync)      
 * 負責監聽 Foundry 原生的訊息變動，並同步更新 UI 
 * --------------------------------------------
 */

/**
 * 監聽：新訊息建立 (Create)
 * 當有人發送訊息時，將其插入到自定義視窗中
 */
Hooks.on("createChatMessage", (message, options, userId) => {
    // Debug用
    // console.log("YCIO Debug | 新訊息原始資料:", message);

    // 檢查視窗是否已建立且已渲染 (rendered)，避免報錯
    if (floatingChatInstance?.rendered) {
        // 氣泡提示不等待內容 DOM queue，避免歷史載入阻塞即時 OOC 提示。
        floatingChatInstance.handleOocBubbleMessageCreated(message);
        queueMessageSync(app => app.appendMessage(message));
    }
});

/**
 * 監聽：訊息刪除 (Delete)
 * 當訊息被刪除時，通知視窗移除對應的 DOM 元素
 */
Hooks.on("deleteChatMessage", (message, options, userId) => {
    if (floatingChatInstance?.rendered) {
        // 氣泡不必等待內容 DOM queue；已刪除訊息應立即離開提示層。
        floatingChatInstance.handleOocBubbleMessageDeleted(message.id);
        queueMessageSync(app => app.deleteMessageFromDOM(message.id));
    }
});

/**
 * 監聽：訊息更新 (Update)
 * 例如：內容修改、GM 將訊息設為公開/隱藏等
 */
Hooks.on("updateChatMessage", (message, changes, options, userId) => {
    if (floatingChatInstance?.rendered) {
        // 權限或路由失效時先同步清除，避免長工作佇列延長敏感內容的顯示。
        floatingChatInstance.handleOocBubbleMessageUpdate(message);
        // ChatMessage 更新頻率很低；全量重新判斷路由比維護易漏欄位的白名單可靠。
        queueMessageSync(app => app.updateMessageInDOM(message));
    }
});

// 當 GM 修改 "hideNativeSidebar" 設定時觸發，更新側邊聊天欄顯示
Hooks.on("YCIO_UpdateSidebarVisibility", updateNativeSidebarVisibility);
