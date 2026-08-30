/**
 * Scene chat-tab collapse state and classification helpers.
 * These helpers only operate on an already permission-filtered Scene list.
 */

export const CHAT_TAB_COLLAPSED_FLAG = "chatTabCollapsed";

/**
 * Only the literal boolean true represents a collapsed Scene tab.
 * @param {Scene} scene
 * @param {string} flagScope
 * @returns {boolean}
 */
export function isSceneChatTabCollapsed(scene, flagScope) {
    return scene?.getFlag?.(flagScope, CHAT_TAB_COLLAPSED_FLAG) === true;
}

/**
 * Partition an already-visible Scene list without changing its order.
 * A collapsed active Scene is temporarily promoted to the primary row.
 * @param {Scene[]} visibleScenes
 * @param {string} activeTabId
 * @param {Set<string>} unreadTabs
 * @param {string} flagScope
 * @returns {{primaryScenes: Object[], collapsedScenes: Object[], collapsedHasUnread: boolean}}
 */
export function partitionSceneChatTabs(visibleScenes, activeTabId, unreadTabs, flagScope) {
    const primaryScenes = [];
    const collapsedScenes = [];

    for (const scene of visibleScenes) {
        const collapsed = isSceneChatTabCollapsed(scene, flagScope);
        const active = scene.id === activeTabId;
        const tab = {
            id: scene.id,
            name: scene.navName || scene.name,
            active,
            hasUnread: unreadTabs.has(scene.id),
            collapsed
        };

        if (collapsed && !active) collapsedScenes.push(tab);
        else primaryScenes.push(tab);
    }

    return {
        primaryScenes,
        collapsedScenes,
        collapsedHasUnread: collapsedScenes.some(scene => scene.hasUnread)
    };
}

function collectChangePaths(value, prefix = "", output = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        if (prefix) output.push(prefix);
        return output;
    }

    const entries = Object.entries(value);
    if (entries.length === 0 && prefix) output.push(prefix);
    for (const [key, child] of entries) {
        const path = prefix ? `${prefix}.${key}` : key;
        collectChangePaths(child, path, output);
    }
    return output;
}

function normalizeUnsetPath(path) {
    return path
        .split(".")
        .map(segment => segment.startsWith("-=") ? segment.slice(2) : segment)
        .join(".");
}

/**
 * Classify a Scene update so collapse-only updates can redraw only the tabs part.
 * Both nested and dotted Foundry update paths are accepted, including -= unset paths.
 * @param {Object} changes
 * @param {string} flagScope
 * @returns {{collapseChanged: boolean, requiresFullRefresh: boolean}}
 */
export function analyzeSceneChatTabUpdate(changes, flagScope) {
    const paths = collectChangePaths(changes).map(normalizeUnsetPath);
    const collapsePath = `flags.${flagScope}.${CHAT_TAB_COLLAPSED_FLAG}`;
    const collapseChanged = paths.includes(collapsePath);
    const hasPath = key => paths.some(path => path === key || path.startsWith(`${key}.`));

    return {
        collapseChanged,
        requiresFullRefresh: hasPath("ownership")
            || hasPath("navigation")
            || hasPath("active")
            || hasPath("name")
            || hasPath("navName")
    };
}

/**
 * Apply a fixed, idempotent collapse intent to a Scene Document.
 * Permission checks and user-facing error handling remain the caller's responsibility.
 * @param {Scene} scene
 * @param {boolean} collapsed
 * @param {string} flagScope
 * @returns {Promise<boolean>} Whether a Document update was requested.
 */
export async function setSceneChatTabCollapsedState(scene, collapsed, flagScope) {
    const current = scene.getFlag(flagScope, CHAT_TAB_COLLAPSED_FLAG);
    if (collapsed) {
        if (current === true) return false;
        await scene.setFlag(flagScope, CHAT_TAB_COLLAPSED_FLAG, true);
        return true;
    }

    if (current === undefined) return false;
    await scene.unsetFlag(flagScope, CHAT_TAB_COLLAPSED_FLAG);
    return true;
}
