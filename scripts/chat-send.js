import { MODULE_ID } from "./config.js";

/** Plain OOC needs its selected speaker before Core evaluates inline rolls.
 * Explicit commands stay with ChatLog.processMessage. Exact targets: 13.351/14.367.
 */
export async function createPlainOOCMessage(content, speaker, nonce, { generation, configuredMode }) {
    const chatData = { user: game.user.id, speaker };
    const selectedSpeaker = foundry.utils.deepClone(speaker);
    if (Hooks.call("chatMessage", ui.chat, content, chatData) === false) return false;
    const data = foundry.utils.deepClone(chatData);
    data.content = content.replace(/\n/g, "<br>");
    data.style = CONST.CHAT_MESSAGE_STYLES.OOC;
    data.speaker = selectedSpeaker;
    foundry.utils.setProperty(data, `flags.${MODULE_ID}.pendingSendNonce`, nonce);
    // In v14 ic + non-Token, omitting mode preserves Hook whisper/blind metadata.
    const options = generation === 14 && configuredMode !== "ic" ? { messageMode: configuredMode } : {};
    return ChatMessage.implementation.create(data, options);
}
