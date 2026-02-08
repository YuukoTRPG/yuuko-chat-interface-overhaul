import { FloatingChat } from "./floating-chat.js";
import { InlineAvatarPicker } from "./avatar-selector.js";
import { MODULE_ID } from "./config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class MessageEditor extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(message) {
        super({ window: { title: game.i18n.localize("YCIO.Editor.WindowTitle") } });
        this.message = message;
    }

    static DEFAULT_OPTIONS = {
        id: "YCIO-message-editor",
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

    async _prepareContext(_options) {
        return {
            originalContent: this.message.content
        };
    }

    // --- Actions ---

    static async onUpdateMessage(event, target) {
        // 取得輸入框內容
        const form = target.closest("form");
        const textarea = form.querySelector("textarea");
        const newContent = textarea.value.trim();

        // 如果內容有變，執行更新
        if (newContent !== this.message.content) {
            await this.message.update({ content: newContent });
        }
        
        this.close();
    }

    static onCancel(event, target) {
        this.close();
    }

    // 編輯器專用的表符插入邏輯 (因為沒有下拉選單，改為讀取訊息原本的 speaker)
    static onFormatInlineAvatar(event, target) {
        const app = this; // ApplicationV2 實例
        const message = app.message;

        // 嘗試從訊息的 speaker 解析 Actor
        let targetDoc = null;
        if (message.speaker.actor) targetDoc = game.actors.get(message.speaker.actor);
        if (!targetDoc && message.speaker.token) {
            const token = canvas.tokens.get(message.speaker.token);
            targetDoc = token?.actor;
        }
        // 如果都不是，Fallback 到發訊者 User
        if (!targetDoc) targetDoc = message.author ?? message.user;

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