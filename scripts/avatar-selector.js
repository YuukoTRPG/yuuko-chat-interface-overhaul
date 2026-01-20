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
            width: 420,
            height: 500,
            icon: "fas fa-images"
        },
        position: { width: 600, height: 350 },
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
        // 1. 讀取並遷移資料結構
        // 舊格式: ["url"] -> 新格式: [{src: "url", label: ""}]
        let savedAvatars = this.target.getFlag(MODULE_ID, "avatarList") || [];
        
        // 簡單的遷移邏輯：如果有字串，就轉成物件
        const hasLegacyData = savedAvatars.some(a => typeof a === 'string');
        if (hasLegacyData) {
            savedAvatars = savedAvatars.map(a => typeof a === 'string' ? { src: a, label: "" } : a);
            // 靜默更新資料結構 (不等待)
            this.target.setFlag(MODULE_ID, "avatarList", savedAvatars);
        }

        const currentAvatar = this.target.getFlag(MODULE_ID, "currentAvatar") || "";

        // 3. 取得預設頭像 (保持你原本的邏輯)
        let defaultAvatar = "icons/svg/mystery-man.svg";
        if (this.target.documentName === "Actor") {
             //讀取config的設定
            const useToken = game.settings.get(MODULE_ID, "useTokenAvatarDefault");

            // 預設先拿原型圖片
            let tokenImg = this.target.prototypeToken?.texture?.src;

            // 嘗試尋找場景上的實例：
            // 1. 如果是合成 Actor (Unlinked)，this.target.token 會存在
            // 2. 如果是連結 Actor (Linked)，去場景上的 tokens 找一個屬於此 Actor 的
            const activeTokenDoc = this.target.token || canvas.tokens?.placeables.find(t => t.actor?.id === this.target.id)?.document;

            // 如果找到了場景實例，就用它的圖片 (手動更新後的圖片)
            if (activeTokenDoc) tokenImg = activeTokenDoc.texture.src;
            const actorImg = this.target.img;

            //根據設定決定用Token或角色
            if (useToken) defaultAvatar = tokenImg || actorImg;
            else defaultAvatar = actorImg || tokenImg;

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
    /* 渲染後處理 (Event Binding)                   */
    /* ============================================= */

    _onRender(context, options) {
        super._onRender(context, options);

        // --- 手動綁定輸入框事件 ---
        const inputs = this.element.querySelectorAll(".avatar-label-input");
        inputs.forEach(input => {
            // 1. 點擊輸入框時，阻止冒泡 (避免觸發卡片選擇)
            input.addEventListener("click", ev => ev.stopPropagation());

            // 2. 內容變更時 (失去焦點或 Enter)，觸發存檔
            input.addEventListener("change", ev => AvatarSelector.onUpdateLabel.call(this, ev, input));

            // 3. 按下 Enter 鍵時，強制失去焦點 (這會觸發 change)
            input.addEventListener("keydown", ev => {
                if (ev.key === "Enter") input.blur();
            });
        });
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
                const currentList = this.target.getFlag(MODULE_ID, "avatarList") || [];
                // 檢查是否重複 (比對 src)
                if (!currentList.some(a => a.src === path)) {
                    // 物件結構
                    const newList = [...currentList, { src: path, label: "" }];
                    await this.target.setFlag(MODULE_ID, "avatarList", newList);
                    this.render();
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
        if (event.target.closest(".delete-btn") || event.target.closest("input")) return;

        const activeInput = this.element.querySelector("input:focus");
        if (activeInput) {
            // 強制失去焦點，這會觸發 input 的 'change' 事件，執行 onUpdateLabel
            activeInput.blur(); 
        }
        
        // 等待任何正在進行的存檔動作完成 (防止競態條件)
        if (this._pendingSave) {
            await this._pendingSave;
        }

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
        const index = parseInt(target.dataset.index); // 用 index 刪除比較準確
        
        // 1. 更新列表
        const currentList = this.target.getFlag(MODULE_ID, "avatarList") || [];

        const itemToDelete = currentList[index];
        if (!itemToDelete) return;

        const newList = currentList.filter((_, i) => i !== index);
        await this.target.setFlag(MODULE_ID, "avatarList", newList);

        // 2. 如果刪除的是當前選中的，重置回預設
        const currentSelected = this.target.getFlag(MODULE_ID, "currentAvatar");
        if (currentSelected === itemToDelete.src) {
            await this.target.unsetFlag(MODULE_ID, "currentAvatar");
        }
        // 3. 重新渲染
        this.render();
    }

    /**
     * 更新頭像註解
     */
    static async onUpdateLabel(event, target) {
        const index = parseInt(target.dataset.index);
        const newLabel = target.value;

        // 建立存檔任務
        const saveTask = (async () => {
            const currentList = this.target.getFlag(MODULE_ID, "avatarList") || [];
            
            // 只有當內容真的改變且 index 有效時才存檔
            if (currentList[index] && currentList[index].label !== newLabel) {
                console.log(`YCIO | 更新註解 [${index}]: ${newLabel}`); // 除錯 Log
                currentList[index].label = newLabel;
                await this.target.setFlag(MODULE_ID, "avatarList", currentList);
            }
        })();

        // 掛載任務鎖，讓 onSelectAvatar 可以等待它
        this._pendingSave = saveTask;

        try {
            await saveTask;
        } finally {
            // 任務結束後解鎖
            if (this._pendingSave === saveTask) {
                this._pendingSave = null;
            }
        }
    }

    /**
     * 確認按鈕 (關閉視窗)
     */
    static onConfirm(event, target) {
        this.close();
    }
}