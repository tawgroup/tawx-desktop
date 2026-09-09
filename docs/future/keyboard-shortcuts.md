# Keyboard Shortcut Research

This note records primary-source conventions and a proposed shortcut map for the macOS Electron desktop app. It is design input, not a description of implemented behavior. Sources were checked on 2026-09-09.

## Sourced conventions

### macOS and Electron

Apple's keyboard guidance says to use Command as the main modifier for custom macOS shortcuts, Shift for a related secondary command, and Option sparingly for less-common commands. It also says not to repurpose standard shortcuts for unrelated actions. [Apple Human Interface Guidelines: Keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards)

Apple documents these relevant system and app conventions:

- `⌘N` opens a new window in Finder; `⌘F` opens Find; and `⌘,` opens the front app's settings.
- `⌘[` and `⌘]` navigate to the previous and next Finder folders. This is a Finder navigation convention, not a universal previous-item command.
- `⌥⌘S` toggles Finder's sidebar. This is likewise Finder-specific, not a universal sidebar shortcut.
- `⌘Space` is Spotlight, `⌘Tab` switches apps, `⌥⌘Esc` opens Force Quit, and `⌃⌘F` toggles full screen. These combinations must not be assigned to TAWX actions.
- Standard app commands already occupy combinations including `⌘H`, `⌘M`, `⌘Q`, `⌘T`, and `⌘W`.

Source: [Apple Support: Mac keyboard shortcuts](https://support.apple.com/en-us/102650).

Electron represents accelerators as case-insensitive strings containing modifiers and one key joined with `+`. `CommandOrControl` maps to Command on macOS and Control on Windows and Linux; Electron recommends `CommandOrControl` instead of `Command`, and `Alt` instead of `Option`, for portable shortcuts. Local shortcuts belong to application menu items and fire only while the app is focused. Global shortcuts continue to work while the app is unfocused. [Electron: Keyboard Shortcuts](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts) and [Electron: `globalShortcut`](https://www.electronjs.org/docs/latest/api/global-shortcut).

Electron recommends using a standard menu-item `role` when one exists because roles supply platform-appropriate native behavior and labels. An `accelerator` maps a menu item to its keyboard shortcut. [Electron: Menus](https://www.electronjs.org/docs/latest/tutorial/menus).

### First-party product precedents

These are product-specific precedents, not macOS standards:

| Product | Documented behavior | Relevance |
| --- | --- | --- |
| ChatGPT | `⌘K` searches chat history on the web. | Strong direct precedent for app-wide conversation search. [OpenAI: Search chat history](https://help.openai.com/en/articles/10056348-how-do-i-search-my-chat-history-in-chatgpt) |
| ChatGPT for macOS | `⌥Space` opens or refocuses its system-wide Chat Bar; Return submits its prompt. The launcher shortcut is configurable. | Demonstrates a global launcher and Return-to-send, but `⌥Space` should not be copied as an ordinary local shortcut. [OpenAI: How to launch the Chat Bar](https://help.openai.com/en/articles/9295241-chatgpt-macos-app-faq) |
| ChatGPT for macOS | `⌘.` stops a streaming response; `⌘F` finds text within a conversation. | Direct chat precedent for stopping generation while preserving the platform Find command. [OpenAI: macOS app release notes](https://help.openai.com/en/articles/9703738-chatgpt-macos-app-release-notes) |
| Claude Desktop for Mac | Double-tapping Option opens Quick Entry from any app; `⌥Space` is an alternative; the shortcut is configurable. Enter sends from Quick Entry. | Confirms that global AI launchers compete for user-configurable shortcuts and should remain separate from the local app map. [Claude: Use quick entry](https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac) |
| Slack | `⌥↑` and `⌥↓` move to the previous and next conversation; `⇧⌘K` starts composing a message. | Direct chat precedents for conversation movement and composer access. [Slack: Keyboard shortcuts](https://slack.com/help/articles/201374536-Slack-keyboard-shortcuts) |
| Slack | `⇧Return` inserts a new line in the message field; Slack also offers a preference that changes Enter behavior. | Direct messaging precedent for newline behavior. [Slack: Format your messages](https://slack.com/help/articles/202288908-Format-your-messages-in-Slack) |
| Notion | `cmd/ctrl+N` creates a page, `cmd/ctrl+K` or `cmd/ctrl+P` opens search, and `cmd/ctrl+[` / `cmd/ctrl+]` navigates back and forward. It documents `cmd/ctrl` as Command on Mac and Control elsewhere. | Productivity precedents for new-item, search, navigation, and portable labeling. [Notion: Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts) |
| Chrome for Mac | `⌘1` through `⌘8` selects a tab by position, `⌘[` / `⌘]` navigates backward and forward, and `⌥⌘I` opens Developer Tools. | Positional-switching and navigation precedents; `⌥⌘I` is a conflict to avoid in an Electron app. [Google Chrome: Keyboard shortcuts](https://support.google.com/chrome/answer/157179?hl=en&co=GENIE.Platform%3DDesktop) |

No reviewed primary source establishes a general shortcut for an AI mode switch or a context inspector. Those keys therefore need an explicit TAWX design choice rather than being presented as platform conventions.

## TAWX design recommendation

The initial map should contain focused-window application shortcuts only. A system-wide launcher is a separate feature because Electron treats it differently and both ChatGPT and Claude already let users claim global Option-based combinations.

| Action | macOS | Portable fallback | Electron accelerator | Rationale and scope |
| --- | --- | --- | --- | --- |
| New chat | `⌘N` | `Ctrl+N` | `CommandOrControl+N` | Treat a conversation as TAWX's new primary item. This follows Apple's new-window and Notion's new-page conventions. |
| Previous chat | `⌘[` | `Ctrl+[` | `CommandOrControl+[` | Use the established backward-navigation pair. “Previous” means the preceding chat in TAWX's displayed chat order, not browser history. |
| Next chat | `⌘]` | `Ctrl+]` | `CommandOrControl+]` | Symmetric with previous chat. |
| Switch mode | `⌘1`, `⌘2`, … | `Ctrl+1`, `Ctrl+2`, … | `CommandOrControl+1`, etc. | Assign numbers only to visible, stable mode positions and show the number beside each mode. Positional selection follows the Chrome tab precedent without consuming text-editing letters. |
| Focus composer | `⇧⌘K` | `Ctrl+Shift+K` | `CommandOrControl+Shift+K` | Reuse Slack's compose action. It should focus the current chat's composer without creating a chat or discarding a draft. |
| Settings | `⌘,` | `Ctrl+,` | `CommandOrControl+,` | Preserve the explicit macOS Settings convention. |
| Toggle context inspector | `⌥⌘X` | `Ctrl+Alt+X` | `CommandOrControl+Alt+X` | TAWX-specific mnemonic using the `x` in “context.” It avoids `⌥⌘I`, which Chrome assigns to Developer Tools, and avoids `⌘I`, a standard text-formatting command. |
| Toggle sidebar | `⌥⌘S` | `Ctrl+Alt+S` | `CommandOrControl+Alt+S` | Reuse Finder's sidebar combination while acknowledging that Finder, not macOS generally, establishes this precedent. |
| Search chats | `⌘K` | `Ctrl+K` | `CommandOrControl+K` | Follow ChatGPT and Notion app-wide search. Keep `⌘F` / `Ctrl+F` available for finding text in the current conversation. |
| Stop generation | `⌘.` | `Ctrl+.` | `CommandOrControl+.` | Follow ChatGPT's direct streaming-stop precedent. Enable it only while generation is active; otherwise it should do nothing. |
| Send | `Return` | `Enter` | Window/composer handling | Send only when the composer has focus and the draft is sendable. This follows ChatGPT and Claude prompt submission. |
| Newline | `⇧Return` | `Shift+Enter` | Window/composer handling | Follow Slack's message-composer behavior. Do not let the app-menu accelerator consume this text-input operation. |

This set is internally conflict-free: every app-level action has a unique combination, and send/newline are scoped to the focused composer. It also avoids the reviewed system-reserved combinations and leaves standard editing, window, quit, and in-conversation Find commands intact.

### Interaction precedence

Context is part of the contract, not an implementation detail:

1. Native text editing keeps standard editing shortcuts.
2. In the composer, `Return` sends and `⇧Return` inserts a newline.
3. `⌘.` / `Ctrl+.` stops only an active generation.
4. App navigation and view commands then handle their unique accelerators.
5. System-reserved shortcuts remain untouched.

Do not overload Escape as Stop. Reserve Escape for dismissing transient UI in TAWX; `⌘.` already has a direct AI-chat precedent and avoids ambiguous double actions.

## Discoverability recommendation

- Put every app-level shortcut in the native application menu. Electron menu accelerators both expose and activate local shortcuts, so one surface can provide activation and discovery.
- Show mode numbers in the mode control because numbered shortcuts are otherwise not mnemonic.
- Show shortcuts in tooltips for New Chat, Search, Sidebar, Context Inspector, and Stop. The Stop tooltip should appear only while stopping is possible.
- Label the composer affordance “Return to send · Shift-Return for newline” on first use or in its tooltip.
- Add a searchable “Keyboard Shortcuts” entry to Help. If a shortcut overlay is later added, expose it from that menu rather than reserving another undocumented key now.
- Use macOS glyphs (`⌘`, `⌥`, `⇧`) in the Mac UI and Ctrl/Alt text on other platforms; keep Electron accelerator strings out of user-facing labels.

## Decisions to preserve

- `⌘F` remains Find in the current conversation; `⌘K` searches across chats.
- `⌘Space`, `⌘Tab`, `⌥⌘Esc`, and `⌃⌘F` remain owned by macOS.
- `⌥⌘I` remains available for Developer Tools rather than the TAWX context inspector.
- No initial shortcut is global. A future global launcher must be opt-in, customizable, and checked independently against OS and other-app registrations.
- The mode-number mapping must not silently change when modes are hidden, reordered, or made user-configurable; if positions stop being stable, remove the numbered accelerators rather than making them unpredictable.
