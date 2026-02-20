import { MODULE_ID } from "./config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * 頭像選擇器視窗
 */
export class AvatarSelector extends HandlebarsApplicationMixin(ApplicationV2) {

    constructor(targetDocument, options = {}) {
        super(options);
        // targetDocument 可能是 Actor (角色) 或 User (OOC)
        this.target = targetDocument;

        // --- 讀取並還原視窗位置 ---
        const savedPos = game.settings.get(MODULE_ID, "avatarSelectorPosition");
        if (savedPos && !foundry.utils.isEmpty(savedPos)) {
            if (Number.isFinite(savedPos.left)) this.position.left = Math.max(1, savedPos.left);
            if (Number.isFinite(savedPos.top)) this.position.top = Math.max(1, savedPos.top);
            if (Number.isFinite(savedPos.width)) this.position.width = savedPos.width;
            if (Number.isFinite(savedPos.height)) this.position.height = savedPos.height;
        }

        // --- 防抖動儲存視窗位置與大小 ---
        this._savePositionDebounced = foundry.utils.debounce((pos) => {
            game.settings.set(MODULE_ID, "avatarSelectorPosition", pos);
        }, 500);
    }

    static DEFAULT_OPTIONS = {
        id: "YCIO-avatar-selector",
        classes: ["YCIO-avatar-selector-window"],
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

    /**
     * 覆寫 setPosition 自動存檔
     */
    setPosition(position = {}) {
        const newPosition = super.setPosition(position);
        this._savePositionDebounced(newPosition);
        return newPosition;
    }

    /**
     * ============================================
     * 資料準備 (Context Preparation)
     * ============================================
     */
    async _prepareContext(_options) {
        const savedAvatars = this.target.getFlag(MODULE_ID, "avatarList") || [];
        const currentAvatar = this.target.getFlag(MODULE_ID, "currentAvatar") || "";

        // 3. 取得預設頭像 (保持你原本的邏輯)
        let defaultAvatar = "icons/svg/mystery-man.svg";
        if (this.target.documentName === "Actor") {
            // 讀取 config 的設定
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

            // 根據設定決定用Token或角色
            if (useToken) defaultAvatar = tokenImg || actorImg;
            else defaultAvatar = actorImg || tokenImg;

        } else if (this.target.documentName === "User") {
            defaultAvatar = this.target.avatar;
        }

        return {
            avatars: savedAvatars,
            currentAvatar: currentAvatar,
            defaultAvatar: defaultAvatar,
            targetName: this.target.name,
            isGM: game.user.isGM
        };
    }

    /**
     * ============================================
     * 渲染後處理 (Event Binding)
     * ============================================
     */
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

        // --- 修正：拖曳排序功能 (Drag & Drop) ---
        const draggables = this.element.querySelectorAll('.avatar-card.draggable-item');

        draggables.forEach(card => {
            // 1. 開始拖曳
            card.addEventListener('dragstart', ev => {
                ev.dataTransfer.effectAllowed = "move";
                ev.dataTransfer.setData("text/plain", card.dataset.index);

                // 關鍵修正：使用 setTimeout 延遲樣式套用
                // 讓瀏覽器先抓取「原本不透明」的卡片作為殘影，之後再把卡片變半透明
                setTimeout(() => card.classList.add('dragging'), 0);
            });

            // 2. 拖曳結束 (無論成功與否都會觸發)
            card.addEventListener('dragend', ev => {
                card.classList.remove('dragging');
                // 清除所有卡片的 drag-over 樣式，防止殘留
                draggables.forEach(c => c.classList.remove('drag-over'));
            });

            // 3. 經過目標 (允許放置)
            card.addEventListener('dragover', ev => {
                ev.preventDefault(); // 必須有這行才能觸發 drop
                ev.dataTransfer.dropEffect = "move";

                // 補強：確保在 dragenter 沒觸發到的情況下也能顯示樣式
                if (!card.classList.contains('dragging')) {
                    card.classList.add('drag-over');
                }
            });

            // 4. 進入目標
            card.addEventListener('dragenter', ev => {
                if (!card.classList.contains('dragging')) {
                    card.classList.add('drag-over');
                }
            });

            // 5. 離開目標 (關鍵修正：防閃爍)
            card.addEventListener('dragleave', ev => {
                // 如果滑鼠只是移到了卡片內部的子元素 (如圖片、輸入框)，不視為離開
                if (card.contains(ev.relatedTarget)) return;

                card.classList.remove('drag-over');
            });

            // 6. 放下 (Drop)
            card.addEventListener('drop', async ev => {
                ev.preventDefault();
                // 放下時立刻移除樣式
                card.classList.remove('drag-over');

                const fromIndex = parseInt(ev.dataTransfer.getData("text/plain"));
                const toIndex = parseInt(card.dataset.index);

                // 檢查數據有效性
                if (isNaN(fromIndex) || isNaN(toIndex) || fromIndex === toIndex) return;

                // 呼叫排序邏輯
                await this._reorderAvatars(fromIndex, toIndex);
            });
        });
    }

    /**
     * ============================================
     * 操作邏輯 (Actions)
     * ============================================
     */

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

        // 通知主視窗 (如果有的話) 重繪輸入框附近的頭像預覽
        Hooks.callAll("YCIO_AvatarChanged");
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
                // console.log(`YCIO | 更新註解 [${index}]: ${newLabel}`); // 除錯 Log
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
     * 處理頭像陣列的重新排序
     */
    async _reorderAvatars(fromIndex, toIndex) {
        const currentList = this.target.getFlag(MODULE_ID, "avatarList") || [];

        // 防呆檢查
        if (!currentList[fromIndex]) return;

        // 陣列操作：取出 -> 插入
        const itemToMove = currentList.splice(fromIndex, 1)[0]; // 移除來源
        currentList.splice(toIndex, 0, itemToMove);            // 插到目標位置

        // 存檔並重繪
        await this.target.setFlag(MODULE_ID, "avatarList", currentList);
        this.render();
    }

    /**
     * 確認按鈕 (關閉視窗)
     */
    static onConfirm(event, target) {
        this.close();
    }
}

/**
 * ============================================
 * 行內頭像插入器 (Inline Picker)
 * ============================================
 */
export class InlineAvatarPicker extends HandlebarsApplicationMixin(ApplicationV2) {

    constructor(avatars, callback, options = {}) {
        super(options);
        this.avatars = avatars; // 過濾好的頭像列表
        this.callback = callback; // 點擊後的回呼函式

        // 讀取並還原視窗位置
        const savedPos = game.settings.get(MODULE_ID, "inlinePickerPosition");
        if (savedPos && !foundry.utils.isEmpty(savedPos)) {
            if (Number.isFinite(savedPos.left)) this.position.left = Math.max(1, savedPos.left);
            if (Number.isFinite(savedPos.top)) this.position.top = Math.max(1, savedPos.top);
            if (Number.isFinite(savedPos.width)) this.position.width = savedPos.width;
            if (Number.isFinite(savedPos.height)) this.position.height = savedPos.height;
        }

        // 防抖動儲存視窗位置 (500ms)
        this._savePositionDebounced = foundry.utils.debounce((pos) => {
            game.settings.set(MODULE_ID, "inlinePickerPosition", pos);
        }, 500);
    }

    static DEFAULT_OPTIONS = {
        id: "YCIO-inline-picker",
        classes: ["YCIO-inline-picker"],
        tag: "div",
        window: {
            title: "YCIO.Picker.Title", // 記得在語言檔加入這個 key，或暫時顯示 "選擇表符"
            resizable: true,
            width: 340,
            height: "auto",
            icon: "far fa-smile"
        },
        position: { width: 340, height: "auto" }
    };

    static PARTS = {
        form: { template: "modules/yuuko-chat-interface-overhaul/templates/inline-avatar-picker.hbs" }
    };

    /**
     * 覆寫 setPosition 以便在移動/縮放時自動存檔
     */
    setPosition(position = {}) {
        const newPosition = super.setPosition(position);
        this._savePositionDebounced(newPosition);
        return newPosition;
    }

    /**
     * 準備資料
     */
    async _prepareContext(_options) {
        return { avatars: this.avatars };
    }

    /**
     * 綁定點擊事件
     */
    _onRender(context, options) {
        super._onRender(context, options);

        // 綁定點擊事件
        this.element.querySelectorAll(".picker-item").forEach(btn => {
            btn.addEventListener("click", (ev) => {
                const label = btn.dataset.label;

                // 執行回呼 (插入文字)
                if (this.callback) this.callback(label);

                // 關閉視窗
                this.close();
            });
        });
    }
}