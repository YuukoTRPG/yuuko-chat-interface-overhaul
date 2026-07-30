import { InlineAvatarPicker } from "./avatar-selector.js";
import { MODULE_ID } from "./config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function getEditorTextarea(target) {
    return target.closest(".window-content")?.querySelector(".YCIO-chat-entry");
}

function insertTextFormat(textarea, startTag, endTag) {
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = textarea.value.slice(start, end);

    textarea.setRangeText(`${startTag}${selectedText}${endTag}`, start, end);
    textarea.focus();

    const selectionStart = start + startTag.length;
    const selectionEnd = start === end ? selectionStart : end + startTag.length;
    textarea.setSelectionRange(selectionStart, selectionEnd);
}

function isSafeImageSource(source) {
    if (!source || source === "__NO_AVATAR__") return false;
    try {
        const url = new URL(String(source), document.baseURI);
        return ["http:", "https:", "blob:"].includes(url.protocol)
            || (url.protocol === "data:" && /^data:image\//i.test(String(source)));
    } catch (_error) {
        return false;
    }
}

/**
 * ============================================
 * 訊息編輯器 (Message Editor)
 * ============================================
 * 提供右鍵編輯對話內容的功能視窗
 */
export class MessageEditor extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(message) {
        super({ window: { title: game.i18n.localize("YCIO.Editor.WindowTitle") } });
        this.message = message;
        this._originalContent = message.content;
        this._editorContent = null;
        this._saving = false;

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
            void game.settings.set(MODULE_ID, "messageEditorPosition", pos)
                .catch(error => console.error("YCIO | 儲存編輯器位置失敗:", error));
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
            formatBold: MessageEditor.onFormatBold,
            formatItalic: MessageEditor.onFormatItalic,
            formatStrikethrough: MessageEditor.onFormatStrikethrough,
            applyTextColor: MessageEditor.onApplyTextColor,

            // 專屬邏輯
            formatInlineAvatar: MessageEditor.onFormatInlineAvatar,
            updateMessage: MessageEditor.onUpdateMessage,
            cancel: MessageEditor.onCancel
        }
    };

    static PARTS = {
        form: { template: "modules/yuuko-chat-interface-overhaul/templates/chat-editor.hbs" }
    };

    setPosition(position = {}) {
        const result = super.setPosition(position);
        if (this._savePositionDebounced && this.position) {
            const { left, top, width, height } = this.position;
            this._savePositionDebounced({ left, top, width, height });
        }
        return result;
    }

    async _prepareContext(_options) {
        // 先執行還原，讓編輯器顯示 [[標籤]]
        const restoredContent = this._restoreInlineAvatars(this._originalContent);
        this._editorContent = restoredContent;
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
        const colorPicker = this.element.querySelector(".YCIO-chat-text-color-picker, #chat-text-color-picker");

        // 如果找到了，就套用共用 class 與記憶顏色
        if (colorPicker) {
            colorPicker.classList.add("YCIO-chat-text-color-picker");
            if (savedColor) colorPicker.value = savedColor;
        }
    }

    /**
     * 還原邏輯：將 HTML 圖片轉回 [[標籤]]
     * @param {string} content - 含有 HTML 圖片的訊息內容
     * @returns {string} 轉換成標籤的文字
     */
    _restoreInlineAvatars(content) {
        const template = document.createElement("template");
        template.innerHTML = String(content ?? "");

        template.content.querySelectorAll("img.YCIO-inline-emote").forEach(image => {
            const label = image.getAttribute("alt") ?? "";
            image.replaceWith(document.createTextNode(`[[${label}]]`));
        });

        return template.innerHTML;
    }

    /**
     * 解析邏輯：將 [[標籤]] 轉為 HTML 圖片
     * @param {string} content - 含有標籤的純文字內容
     * @returns {string} 轉換成 HTML 圖片的內容
     */
    _parseInlineAvatars(content) {
        // 取得這則訊息原本的發言者 (Actor/User)
        const targetDoc = this._getTargetDoc();
        if (!targetDoc) return content;

        const avatarList = targetDoc.getFlag(MODULE_ID, "avatarList") || [];
        if (!Array.isArray(avatarList) || avatarList.length === 0) return content;

        const avatarsByLabel = new Map();
        for (const avatar of avatarList) {
            if (avatar?.label && isSafeImageSource(avatar.src) && !avatarsByLabel.has(avatar.label)) {
                avatarsByLabel.set(avatar.label, avatar);
            }
        }
        const source = String(content ?? "");
        if (![...avatarsByLabel.keys()].some(label => label && source.includes(`[[${label}]]`))) return content;
        const template = document.createElement("template");
        template.innerHTML = source;
        const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        let replaced = false;

        while (walker.nextNode()) textNodes.push(walker.currentNode);

        textNodes.forEach(textNode => {
            if (textNode.parentElement?.closest("script, style, code, pre")) return;
            const text = textNode.textContent;
            const markers = [];
            let markerStart = text.indexOf("[[");

            while (markerStart >= 0) {
                const markerEnd = text.indexOf("]]", markerStart + 2);
                if (markerEnd < 0) break;
                markers.push({
                    start: markerStart,
                    end: markerEnd + 2,
                    label: text.slice(markerStart + 2, markerEnd)
                });
                markerStart = text.indexOf("[[", markerEnd + 2);
            }

            if (!markers.some(marker => avatarsByLabel.has(marker.label))) return;

            const fragment = document.createDocumentFragment();
            let offset = 0;

            markers.forEach(marker => {
                const avatar = avatarsByLabel.get(marker.label);
                if (!avatar) return;

                fragment.append(document.createTextNode(text.slice(offset, marker.start)));

                const image = document.createElement("img");
                image.setAttribute("src", avatar.src);
                image.classList.add("YCIO-inline-emote");
                image.setAttribute("alt", marker.label);
                fragment.append(image);
                offset = marker.end;
                replaced = true;
            });

            fragment.append(document.createTextNode(text.slice(offset)));
            textNode.replaceWith(fragment);
        });

        return replaced ? template.innerHTML : content;
    }

    /**
     * 取得目標文件：判斷這則訊息是誰發的
     * @returns {Actor|User} 作者的文件物件
     */
    _getTargetDoc() {
        const message = this.message;
        let targetDoc = null;

        // 1. 優先找訊息指定的 Actor
        if (message.speaker.actor) targetDoc = game.actors.get(message.speaker.actor);

        // 2. 其次找訊息指定 Token 的 Actor
        if (!targetDoc && message.speaker.token) {
            const scene = game.scenes.get(message.speaker.scene);
            targetDoc = scene?.tokens.get(message.speaker.token)?.actor
                ?? canvas.tokens?.get(message.speaker.token)?.actor;
        }

        // 3. 最後找訊息的作者 (User)
        if (!targetDoc) targetDoc = message.author ?? message.user;

        return targetDoc;
    }

    /**
     * ============================================
     * UI Actions 回應
     * ============================================
     */

    static async onUpdateMessage(event, target) {
        // 在 ApplicationV2 的 static action 中，this 指向的是應用程式實例 (app)
        const app = this;
        if (app._saving) return;

        const form = target.closest("form");
        const textarea = form?.querySelector("textarea");
        if (!textarea) return;
        const rawContent = textarea.value; // 保留原文前後空白與換行

        // 未編輯時直接關閉，避免 DOM 正規化造成無意義更新。
        if (rawContent === app._editorContent) {
            app.close();
            return;
        }

        // 執行解析：[[標籤]] -> <img ...>
        const finalContent = app._parseInlineAvatars(rawContent);

        if (finalContent === app._originalContent) {
            app.close();
            return;
        }

        const currentMessage = game.messages.get(app.message.id);
        if (!currentMessage || currentMessage.content !== app._originalContent) {
            ui.notifications.warn(game.i18n.localize("YCIO.Editor.Conflict"));
            return;
        }

        app._saving = true;
        try {
            await currentMessage.update({ content: finalContent });
            app.close();
        } catch (error) {
            console.error("YCIO | 更新訊息失敗", error);
            ui.notifications.error(game.i18n.localize("YCIO.Editor.ErrorUpdate"));
        } finally {
            app._saving = false;
        }
    }

    static onCancel(event, target) {
        this.close();
    }

    static onFormatBold(event, target) {
        insertTextFormat(getEditorTextarea(target), "<b>", "</b>");
    }

    static onFormatItalic(event, target) {
        insertTextFormat(getEditorTextarea(target), "<i>", "</i>");
    }

    static onFormatStrikethrough(event, target) {
        insertTextFormat(getEditorTextarea(target), "<s>", "</s>");
    }

    static onApplyTextColor(event, target) {
        const wrapper = target.closest(".window-content");
        const picker = wrapper?.querySelector(".YCIO-chat-text-color-picker");
        const textarea = wrapper?.querySelector(".YCIO-chat-entry");
        if (picker && textarea) {
            insertTextFormat(textarea, `<span style="color:${picker.value}">`, "</span>");
        }
    }

    /**
     * 編輯器專用的表符插入邏輯 
     * @description 因為沒有下拉選單，改為讀取訊息原本的 speaker
     */
    static onFormatInlineAvatar(event, target) {
        const app = this; // ApplicationV2 實例
        const targetDoc = app._getTargetDoc(); //呼叫輔助方法

        if (!targetDoc) return;

        // 讀取列表 (與 FloatingChat 邏輯相同)
        const rawList = targetDoc.getFlag(MODULE_ID, "avatarList") || [];
        const validList = rawList.filter(a => a.label && a.label.trim() !== "");

        if (validList.length === 0) {
            ui.notifications.warn("YCIO.Warning.NoLabeledAvatars", { localize: true });
            return;
        }

        const onPick = (label) => {
            insertTextFormat(getEditorTextarea(target), `[[${label}]]`, "");
        };

        new InlineAvatarPicker(validList, onPick).render(true);
    }
}
