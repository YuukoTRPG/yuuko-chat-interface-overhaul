const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
import { MODULE_ID } from "./config.js";

/**
 * 關於本模組的資訊對話框
 */
export class AboutDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "YCIO-about-dialog",
        classes: ["YCIO-about-dialog-app"],
        tag: "div",
        position: {
            width: 400,
            height: "auto"
        },
        window: {
            title: "YCIO.About.Title",
            icon: "fas fa-circle-info"
        }
    };

    static PARTS = {
        content: { template: "modules/yuuko-chat-interface-overhaul/templates/about-dialog.hbs" }
    };

    /** @override */
    async _prepareContext(options) {
        const moduleData = game.modules.get(MODULE_ID);

        return {
            moduleTitle: game.i18n.localize("YCIO.About.ModuleName"),
            version: moduleData?.version ?? "unknown",
            lastUpdate: moduleData?.flags?.lastUpdate ?? "unknown",
            isGM: game.user.isGM
        };
    }
}
