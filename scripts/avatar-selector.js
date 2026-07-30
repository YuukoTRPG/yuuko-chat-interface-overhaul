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
            void game.settings.set(MODULE_ID, "avatarSelectorPosition", pos)
                .catch(error => console.error("YCIO | 儲存頭像視窗位置失敗:", error));
        }, 500);

        // 序列化所有 avatarList 寫入，避免不同 UI 操作互相覆蓋。
        this._avatarMutationQueue = Promise.resolve();
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
        const result = super.setPosition(position);
        if (this._savePositionDebounced && this.position) {
            const { left, top, width, height } = this.position;
            this._savePositionDebounced({ left, top, width, height });
        }
        return result;
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
                ev.dataTransfer.setData("text/plain", card.dataset.src);

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

                const fromSrc = ev.dataTransfer.getData("text/plain");
                const toSrc = card.dataset.src;

                // 檢查數據有效性
                if (!fromSrc || !toSrc || fromSrc === toSrc) return;

                // 呼叫排序邏輯
                await this._reorderAvatars(fromSrc, toSrc);
            });
        });
    }

    /**
     * ============================================
     * 操作邏輯 (Actions)
     * ============================================
     */

    /**
     * 將所有頭像 flag 操作排入同一佇列。
     * @param {() => Promise<boolean>} task
     * @returns {Promise<boolean>}
     */
    _queueAvatarTask(task) {
        const operation = this._avatarMutationQueue.then(task);
        this._avatarMutationQueue = operation.catch(error => {
            console.error("YCIO | 更新頭像設定失敗", error);
            ui.notifications.error(game.i18n.localize("YCIO.Avatar.ErrorUpdateList"));
            return false;
        });
        return this._avatarMutationQueue;
    }

    /**
     * 將 avatarList 的讀取、轉換與寫入排入同一佇列。
     * @param {(avatars: Array) => Array|null} transform
     * @returns {Promise<boolean>}
     */
    _queueAvatarMutation(transform) {
        return this._queueAvatarTask(async () => {
            const savedAvatars = this.target.getFlag(MODULE_ID, "avatarList");
            const currentList = Array.isArray(savedAvatars)
                ? savedAvatars.map(avatar => ({ ...avatar }))
                : [];
            const nextList = transform(currentList);
            if (!nextList) return false;

            const currentSelected = this.target.getFlag(MODULE_ID, "currentAvatar");
            const selectedWasRemoved = currentList.some(avatar => avatar.src === currentSelected)
                && !nextList.some(avatar => avatar.src === currentSelected);

            let listWasSaved = false;
            try {
                await this.target.setFlag(MODULE_ID, "avatarList", nextList);
                listWasSaved = true;
                if (selectedWasRemoved) {
                    await this.target.unsetFlag(MODULE_ID, "currentAvatar");
                }
            } finally {
                if (listWasSaved) Hooks.callAll("YCIO_AvatarChanged");
            }

            if (this.rendered) await this.render();
            return true;
        });
    }

    /**
     * 新增頭像：呼叫 FilePicker
     */
    static async onAddAvatar(event, target) {
        const fp = new foundry.applications.apps.FilePicker({
            type: "image",
            callback: async (path) => {
                await this._queueAvatarMutation(currentList => {
                    if (currentList.some(avatar => avatar.src === path)) return null;
                    return [...currentList, { src: path, label: "" }];
                });
            }
        });
        await fp.browse();
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

        const src = target.dataset.src; // 空字串代表預設，有值代表自選
        await this._queueAvatarTask(async () => {
            if (src && src !== "__NO_AVATAR__") {
                const currentList = this.target.getFlag(MODULE_ID, "avatarList") || [];
                if (!currentList.some(avatar => avatar.src === src)) return false;
            }

            await this.target.setFlag(MODULE_ID, "currentAvatar", src);
            if (this.rendered) await this.render(); // 重繪以更新選取狀態 (黃框)

            // 通知主視窗 (如果有的話) 重繪輸入框附近的頭像預覽
            Hooks.callAll("YCIO_AvatarChanged");
            return true;
        });
    }

    /**
     * 刪除頭像
     */
    static async onDeleteAvatar(event, target) {
        // 阻止事件冒泡 (避免觸發選擇)
        event.stopPropagation();
        const src = target.closest(".avatar-card")?.dataset.src;
        if (!src) return;

        await this._queueAvatarMutation(currentList => {
            const index = currentList.findIndex(avatar => avatar.src === src);
            if (index < 0) return null;
            return currentList.filter((_, currentIndex) => currentIndex !== index);
        });
    }

    /**
     * 更新頭像註解
     */
    static async onUpdateLabel(event, target) {
        const src = target.closest(".avatar-card")?.dataset.src;
        const newLabel = target.value;
        if (!src) return;

        await this._queueAvatarMutation(currentList => {
            const index = currentList.findIndex(avatar => avatar.src === src);
            if (index < 0 || currentList[index].label === newLabel) return null;
            return currentList.map((avatar, currentIndex) => (
                currentIndex === index ? { ...avatar, label: newLabel } : avatar
            ));
        });
    }

    /**
     * 處理頭像陣列的重新排序
     */
    async _reorderAvatars(fromSrc, toSrc) {
        await this._queueAvatarMutation(currentList => {
            const fromIndex = currentList.findIndex(avatar => avatar.src === fromSrc);
            const toIndex = currentList.findIndex(avatar => avatar.src === toSrc);
            if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;

            const nextList = [...currentList];
            const [itemToMove] = nextList.splice(fromIndex, 1);
            nextList.splice(toIndex, 0, itemToMove);
            return nextList;
        });
    }

    /**
     * 確認按鈕 (關閉視窗)
     */
    static async onConfirm(event, target) {
        await this._avatarMutationQueue;
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
            void game.settings.set(MODULE_ID, "inlinePickerPosition", pos)
                .catch(error => console.error("YCIO | 儲存表符視窗位置失敗:", error));
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
        const result = super.setPosition(position);
        if (this._savePositionDebounced && this.position) {
            const { left, top, width, height } = this.position;
            this._savePositionDebounced({ left, top, width, height });
        }
        return result;
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
