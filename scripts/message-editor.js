import { FloatingChat } from "./floating-chat.js";
import { InlineAvatarPicker } from "./avatar-selector.js";
import { MODULE_ID } from "./config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class MessageEditor extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(message) {
        super({ window: { title: game.i18n.localize("YCIO.Editor.WindowTitle") } });
        this.message = message;

        // 讀取並還原視窗位置
        const savedPos = game.settings.get(MODULE_ID, "messageEditorPosition");
        if (savedPos && !foundry.utils.isEmpty(savedPos)) {
            if (Number.isFinite(savedPos.left)) this.position.left = Math.max(1, savedPos.left);
            if (Number.isFinite(savedPos.top)) this.position.top = Math.max(1, savedPos.top);
            if (Number.isFinite(savedPos.width)) this.position.width = savedPos.width;
            if (Number.isFinite(savedPos.height)) this.position.height = savedPos.height;
        }

        // 防抖動儲存視窗位置與大小
        this._savePositionDebounced = foundry.utils.debounce((pos) => {
            game.settings.set(MODULE_ID, "messageEditorPosition", pos);
        }, 500);
    }
    

    static DEFAULT_OPTIONS = {
        id: "YCIO-message-editor",
        classes: ["YCIO-message-editor"],
        tag: "form",
        window: {
            icon: "fas fa-edit",
            resizable: true,
            width: 400,
            height: "auto"
        },
        position: { width: 400, height: 300 },
        actions: {
            // 直接復用 FloatingChat 的通用邏輯
            formatBold: (e, t) => FloatingChat.onFormatBold(e, t),
            formatItalic: (e, t) => FloatingChat.onFormatItalic(e, t),
            formatStrikethrough: (e, t) => FloatingChat.onFormatStrikethrough(e, t),
            applyTextColor: (e, t) => FloatingChat.onApplyTextColor(e, t),
            
            // 專屬邏輯
            formatInlineAvatar: MessageEditor.onFormatInlineAvatar,
            updateMessage: MessageEditor.onUpdateMessage,
            cancel: MessageEditor.onCancel
        }
    };

    static PARTS = {
        form: { template: "modules/yuuko-chat-interface-overhaul/templates/chat-editor.hbs" }
    };

    setPosition(position={}) {
        const newPosition = super.setPosition(position);
        this._savePositionDebounced(newPosition);
        return newPosition;
    }

    async _prepareContext(_options) {
        // 先執行還原，讓編輯器顯示 [[標籤]]
        const restoredContent = this._restoreInlineAvatars(this.message.content);
        return {
            originalContent: restoredContent
        };
    }

    /**
     * 渲染後的邏輯
     */
    _onRender(context, options) {
        super._onRender(context, options);

        // 讀取儲存在設定中的「上次使用的文字顏色」
        const savedColor = game.settings.get(MODULE_ID, "lastUsedTextColor");

        // 找到編輯器視窗內的顏色選擇器，this.element 在 ApplicationV2 中是 HTML 元素本身
        const colorPicker = this.element.querySelector("#chat-text-color-picker");

        // 如果找到了，就套用顏色
        if (colorPicker && savedColor) {
            colorPicker.value = savedColor;
        }
    }

    // 還原邏輯：將 HTML 圖片轉回 [[標籤]]
    _restoreInlineAvatars(content) {
        // 尋找擁有 class="YCIO-inline-emote" 的 img 標籤，並抓取 alt 屬性中的文字
        const regex = /<img[^>]+class=["']YCIO-inline-emote["'][^>]*alt=["'](.*?)["'][^>]*>/g;
        return content.replace(regex, (match, altText) => {
            return `[[${altText}]]`;
        });
    }

    // 解析邏輯：將 [[標籤]] 轉為 HTML 圖片
    _parseInlineAvatars(content) {
        // 取得這則訊息原本的發言者 (Actor/User)
        const targetDoc = this._getTargetDoc();
        if (!targetDoc) return content;

        const avatarList = targetDoc.getFlag(MODULE_ID, "avatarList") || [];
        if (avatarList.length === 0) return content;

        // 正則替換
        return content.replace(/\[\[(.*?)\]\]/g, (match, tagLabel) => {
            const found = avatarList.find(a => a.label === tagLabel);
            if (found) {
                // 必須加上 class="YCIO-inline-emote" 以便下次還原
                return `<img src="${found.src}" class="YCIO-inline-emote" alt="${tagLabel}">`;
            }
            return match;
        });
    }

    // 取得目標文件：判斷這則訊息是誰發的
    _getTargetDoc() {
        const message = this.message;
        let targetDoc = null;
        
        // 1. 優先找訊息指定的 Actor
        if (message.speaker.actor) targetDoc = game.actors.get(message.speaker.actor);
        
        // 2. 其次找訊息指定 Token 的 Actor
        if (!targetDoc && message.speaker.token) {
            const token = canvas.tokens.get(message.speaker.token);
            targetDoc = token?.actor;
        }
        
        // 3. 最後找訊息的作者 (User)
        if (!targetDoc) targetDoc = message.author ?? message.user;
        
        return targetDoc;
    }

    // --- Actions ---

    static async onUpdateMessage(event, target) {
        // 在 ApplicationV2 的 static action 中，this 指向的是應用程式實例 (app)
        const app = this; 
        
        const form = target.closest("form");
        const textarea = form.querySelector("textarea");
        const rawContent = textarea.value.trim(); // 這是包含 [[標籤]] 的原始文字

        // 執行解析：[[標籤]] -> <img ...>
        const finalContent = app._parseInlineAvatars(rawContent);

        // 如果內容有變 (比較解析後的結果與原本的 HTML)，執行更新
        if (finalContent !== app.message.content) {
            await app.message.update({ content: finalContent });
        }
        
        app.close();
    }

    static onCancel(event, target) {
        this.close();
    }

    // 編輯器專用的表符插入邏輯 (因為沒有下拉選單，改為讀取訊息原本的 speaker)
    static onFormatInlineAvatar(event, target) {
        const app = this; // ApplicationV2 實例
        const targetDoc = app._getTargetDoc(); //呼叫輔助方法

        if (!targetDoc) return;

        // 讀取列表 (與 FloatingChat 邏輯相同)
        const rawList = targetDoc.getFlag(MODULE_ID, "avatarList") || [];
        const validList = rawList.filter(a => a.label && a.label.trim() !== "");

        if (validList.length === 0) {
            ui.notifications.warn("YCIO.Warning.NoLabeledAvatars", {localize: true});
            return;
        }

        const onPick = (label) => {
            // 呼叫 FloatingChat 的通用插入法
            FloatingChat._insertFormat(target, `[[${label}]]`, "");
        };

        new InlineAvatarPicker(validList, onPick).render(true);
    }
}