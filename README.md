[English](./README.md) | [繁體中文](./README-zh-tw.md) 

---

# Yuuko's Chat Interface Overhaul

A Foundry VTT module created to enhance the text-based TTRPG playing experience. Key features include scene-based chat tabs, speaker avatar management, simple text message formatting and editing, and chat log export.

This is something written by a TTRPG player who misses the text chat functionality of DodontoF (どどんとふ) too much.

https://github.com/user-attachments/assets/663b184d-619a-4c9f-a43c-83436fde18b1

## Features

* **Chat Tabs**: Scene-based chat tabs, allowing players to clearly know which scene's conversation is currently taking place.
    * **Recommended Synergy**: Recommended to be used with [Monk's Scene Navigation](https://foundryvtt.com/packages/monks-scene-navigation) for individual player scene visibility permission management, to achieve better tab permission separation. (We can finally have secret little rooms limited to specific players!)
* **Speaker Avatar Management**: After uploading images, you can select alternative speaker avatars in the module's avatar selector, providing quick avatar switching and the functionality to insert them as inline emotes.
* **New Text Message Notification**: Includes customizable sound notifications and visual red dot indicators on tabs.
* **Chat Log Export**: Can export text message log files that are easy to read and save.
* **Typing Indicator**: Real-time display of who is currently typing.
* **"Please Wait a Moment" Button**: Makes typing over each other no longer a problem, press the button to let everyone know they should wait for you.
* **One-Click Speaker Censoring**: Text session players love taking screenshots, one button saves you from manually censoring speakers one by one.


## Installation

You can install this module using the Manifest URL provided in FVTT.

1. Open the Foundry VTT Setup menu.
2. Click on the "Add-on Modules" tab.
3. Click the "Install Module" button.
4. Paste the URL below into the "Manifest URL" field:
   ```text
   https://github.com/YuukoTRPG/yuuko-chat-interface-overhaul/releases/latest/download/module.json
   ```
5. Click "Install".

## Compatibility

This module has only been tested in `Foundry VTT Version 13`, compatibility with other versions is not guaranteed.

For some systems and modules that modify message styling, there may be visual display issues.

## Bug Reporting

If you find any issues while using this module, you can submit an issue on this repository, and please try to provide the following information:
1. Your FVTT and module version.
2. Details of the issue, screenshots or videos are even better.
3. Steps to reproduce the issue.
4. Any error messages in the browser developer tools console (F12).

Yuuko is making this module in her spare time, so it might not be addressed immediately. If you have an urgent need, you can contact Yuuko via the following channels or email (yuukotrpg@gmail.com).

### Known Issues
- When used with `Dice So Nice`, the "Display chat message immediately" setting in `Dice So Nice` must be enabled, otherwise dice roll results will not be displayed.

## Contact
<a href="https://www.facebook.com/YuukoTRPG" target="_blank" rel="noopener noreferrer">
    <img src="https://cdn.simpleicons.org/facebook" alt="Facebook" width="32" height="32" 
         style="background-color: silver; padding: 4px; border-radius: 8px;">
</a>
<a href="https://x.com/YuukoTrpg" target="_blank" rel="noopener noreferrer">
    <img src="https://cdn.simpleicons.org/x" alt="X" width="32" height="32" 
         style="background-color: silver; padding: 4px; border-radius: 8px;">
</a>
<a href="https://www.threads.com/@yuuko_trpg" target="_blank" rel="noopener noreferrer">
    <img src="https://cdn.simpleicons.org/threads" alt="Threads" width="32" height="32" 
         style="background-color: silver; padding: 4px; border-radius: 8px;">
</a>
<a href="https://www.plurk.com/victor324" target="_blank" rel="noopener noreferrer">
    <img src="https://cdn.simpleicons.org/plurk" alt="Plurk" width="32" height="32" 
         style="background-color: silver; padding: 4px; border-radius: 8px;">
</a>
<a href="https://linktr.ee/yuuko_trpg" target="_blank" rel="noopener noreferrer">
    <img src="https://cdn.simpleicons.org/linktree" alt="Linktree" width="32" height="32" 
         style="background-color: silver; padding: 4px; border-radius: 8px;">
</a>

- <img src="https://cdn.simpleicons.org/discord" alt="Discord" width="16" height="16"> Discord: `yuuko_trpg`
- Email: `yuukotrpg@gmail.com`

Yuuko's native language is Traditional Chinese, and can also slowly read English and Japanese, but cannot read other languages.

## Support
Though not necessary, if you like this module and it helps your TTRPG experience, you can support Yuuko through the following channels, Yuuko would be very grateful.

<table>
  <tr>
    <td align="center" style="border: none;">
      <a href="https://www.patreon.com/YuukoTRPG" target="_blank">
        <img src="https://cdn.simpleicons.org/Patreon/FFFFFF" alt="Patreon" width="48" height="48">
      </a>
    </td>
    <td style="border: none;">
      <a href="https://www.patreon.com/YuukoTRPG" target="_blank" style="text-decoration: none; color: inherit;">
        <h2>Patreon</h2>
      </a>
    </td>
  </tr>
</table>

## AI Usage Statement

This module uses AI assistance in the following parts:
* **Code**: Some code is AI-assisted generated.
* **Localization**: Except for Traditional Chinese, current language files are all translated by AI.

## License

This module is published under the [MIT License](./LICENSE).

---
