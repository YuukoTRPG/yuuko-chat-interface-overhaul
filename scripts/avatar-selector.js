import { MODULE_ID } from "./config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class AvatarSelector extends HandlebarsApplicationMixin(ApplicationV2) {
    
    constructor(targetDocument, options={}) {
        super(options);
        // targetDocument 可能是 Actor (角色) 或 User (OOC)
        this.target = targetDocument; 
    }

    static DEFAULT_OPTIONS = {
        id: "ycio-avatar-selector",
        classes: ["avatar-selector-window"],
        tag: "div",
        window: {
            title: "YCIO.Avatar.WindowTitle",
            resizable: true,
            width: 400,
            height: 400,
            icon: "fas fa-images"
        },
        position: { width: 400, height: 350 },
        actions: {
            addAvatar: AvatarSelector.onAddAvatar,
            selectAvatar: AvatarSelector.onSelectAvatar,
            deleteAvatar: AvatarSelector.onDeleteAvatar,
            confirm: AvatarSelector.onConfirm
        }
    };

    static PARTS = {
        form: { template: "modules/yuuko-chat-interface-overhaul/templates/avatar-selector.hbs" }
    };

    /* ============================================= */
    /* 資料準備                                      */
    /* ============================================= */

    async _prepareContext(_options) {
        // 1. 讀取儲存的頭像列表 (Array)
        const savedAvatars = this.target.getFlag(MODULE_ID, "avatarList") || [];
        
        // 2. 讀取當前選中的頭像 (String URL)
        // 如果為空字串或 undefined，代表使用預設圖
        const currentAvatar = this.target.getFlag(MODULE_ID, "currentAvatar") || "";

        // 3. 取得預設頭像 (Token Image 或 Actor Image 或 User Avatar)
        let defaultAvatar = "icons/svg/mystery-man.svg";
        if (this.target.documentName === "Actor") {
            // A. 讀取在 config.js 註冊的設定
            const useToken = game.settings.get(MODULE_ID, "useTokenAvatarDefault");
            
            // 預設先拿原型圖片
            let tokenImg = this.target.prototypeToken?.texture?.src;
            
            // 嘗試尋找場景上的實例：
            // 1. 如果是合成 Actor (Unlinked)，this.target.token 會存在
            // 2. 如果是連結 Actor (Linked)，去場景上的 tokens 找一個屬於此 Actor 的
            const activeTokenDoc = this.target.token || canvas.tokens?.placeables.find(t => t.actor?.id === this.target.id)?.document;
            
            // 如果找到了場景實例，就用它的圖片 (手動更新後的圖片)
            if (activeTokenDoc) {
                tokenImg = activeTokenDoc.texture.src;
            }

            const actorImg = this.target.img;
            // B. 根據設定決定優先順序 (若優先的沒圖，則自動使用另一張當備案)
            if (useToken) {
                // 勾選：Token 優先
                defaultAvatar = tokenImg || actorImg;
            } else {
                // 未勾選：角色圖片優先
                defaultAvatar = actorImg || tokenImg;
            }

        } else if (this.target.documentName === "User") {
            defaultAvatar = this.target.avatar;
        }

        return {
            avatars: savedAvatars,
            currentAvatar: currentAvatar,
            defaultAvatar: defaultAvatar,
            targetName: this.target.name
        };
    }

    /* ============================================= */
    /* 操作邏輯                                      */
    /* ============================================= */

    /**
     * 新增頭像：呼叫 FilePicker
     */
    static async onAddAvatar(event, target) {
        const fp = new FilePicker({
            type: "image",
            callback: async (path) => {
                // 讀取舊列表 -> 加入新路徑 -> 存回 Flag
                const currentList = this.target.getFlag(MODULE_ID, "avatarList") || [];
                if (!currentList.includes(path)) {
                    const newList = [...currentList, path];
                    await this.target.setFlag(MODULE_ID, "avatarList", newList);
                    this.render(); // 重繪介面
                }
            }
        });
        fp.browse();
    }

    /**
     * 選擇頭像：設定 currentAvatar Flag
     */
    static async onSelectAvatar(event, target) {
        // 防止誤觸刪除按鈕
        if (event.target.closest(".delete-btn")) return;

        const src = target.dataset.src; // 空字串代表預設，有值代表自選
        await this.target.setFlag(MODULE_ID, "currentAvatar", src);
        this.render(); // 重繪以更新選取狀態 (黃框)
        
        // 通知主視窗 (如果有的話) 重繪輸入框附近的頭像預覽 (可選)
        // Hooks.callAll("YCIO_AvatarChanged"); 
    }

    /**
     * 刪除頭像
     */
    static async onDeleteAvatar(event, target) {
        // 阻止事件冒泡 (避免觸發選擇)
        event.stopPropagation();
        
        const srcToDelete = target.dataset.src;
        
        // 1. 更新列表
        const currentList = this.target.getFlag(MODULE_ID, "avatarList") || [];
        const newList = currentList.filter(src => src !== srcToDelete);
        await this.target.setFlag(MODULE_ID, "avatarList", newList);

        // 2. 如果刪除的是當前選中的，重置回預設
        const currentSelected = this.target.getFlag(MODULE_ID, "currentAvatar");
        if (currentSelected === srcToDelete) {
            await this.target.unsetFlag(MODULE_ID, "currentAvatar");
        }

        this.render();
    }

    /**
     * 確認按鈕 (關閉視窗)
     */
    static onConfirm(event, target) {
        this.close();
    }
}