# Use your existing browser with SynaBun

Connect Chrome or Edge to let an agent work in a browser profile where you are already signed in.

## Connect the extension

1. On macOS, Windows or Linux, open **Settings → Browser** in SynaBun. Select **Existing browser via extension** and choose **Connect your browser**. The first time, SynaBun downloads the extension from synabun.ai, which takes a moment and needs an internet connection.
2. In the browser you want to connect, open the extensions address shown on the setup page. Turn on **Developer mode**, choose **Load unpacked**, and select the folder SynaBun opened. Use this folder again if you reinstall the extension.
3. Keep the setup page open until it shows **Connected**. For manual pairing, start pairing in Settings and enter the displayed port and code in the extension popup.

The extension connects to SynaBun on this computer at `127.0.0.1`. Setup requires neither a NativeMessagingHosts installation nor an allowed_origins manifest. If your organization blocks unpacked extensions, contact your browser administrator.

## Where the extension comes from

SynaBun Browser Bridge is not part of the SynaBun app or its installers. When you choose **Connect your browser**, SynaBun downloads it from `synabun.ai` over HTTPS and installs it only when the file is exactly the one your SynaBun version expects (its size and SHA-256 are fixed in each SynaBun release). A file that does not match is discarded and nothing is installed.

- **The folder.** The verified extension is unpacked into `browser-extension/unpacked` inside SynaBun's data folder. This is the folder you load in the browser. It stays in place across SynaBun updates.
- **Nothing is downloaded until you ask.** SynaBun starts and works without the extension and without a connection. It downloads the extension only when you start **Connect your browser**.
- **Updates.** When a new SynaBun version needs a newer extension, SynaBun downloads it in the background after it starts and replaces the folder's files. If that download fails, the folder you have keeps working and Settings offers **Try again**. The Neural Interface notification and Assistant banner open **Settings → Browser**, where you can see both versions and the download progress. You can dismiss the notification for the session.

  Once the download is verified, choose **Update now**. SynaBun warns you if a task is running or an agent holds tabs. Version 1.4.0 needs one manual reload. Copy the Chrome or Edge extensions address from Settings, open it in the paired browser, and press **Reload** on SynaBun Browser Bridge. Settings shows **Updated to** with the new version when the browser reconnects. If a one-click reload times out, Settings shows the same manual steps.

  Starting with 1.5.0, the extension icon shows an arrow when an update is ready, and **Review update** in its popup opens the same Settings card.
- **The folder is checked against the release.** Each SynaBun release lists every file of its extension with its SHA-256. The folder counts as up to date only when it holds exactly those files and nothing else. Only the setup page's port in the manifest may differ. A changed, added or deleted file, or a manifest with other permissions, makes SynaBun replace the folder with the verified extension. It uses the verified copy it keeps in `browser-extension/package.zip`, so no connection is needed, and downloads it again when that copy is missing or does not match. The setup port is rewritten only after the folder has passed that check.
- **A safe folder, one writer.** SynaBun uses `browser-extension` only when that folder and the data folder are yours, are not links, and cannot be written by other users. Otherwise it changes nothing there and reports `EXTENSION_FOLDER_UNSAFE`. On Linux, a folder its group can write is accepted when that group is your own private group (common with umask 002). It must be your primary group, carry your user name, list no other members, and be no other account's primary group. SynaBun checks this in `/etc/passwd` and `/etc/group`. If those files cannot be read, or your account comes from LDAP or another directory and is not listed there, the folder is refused and the message says why. On macOS a folder its group can write is always refused, because its groups, such as `staff`, are shared. Changes run under an operating-system lock, so two SynaBun servers that share a data folder take turns.
- **Replacing the folder.** The new folder is written beside the old one and recorded in `browser-extension/transaction.json`. Then the old folder is renamed aside and the new one is moved into its place. This is the same on every system, and SynaBun starts no other program to do it. For the short moment between those two renames, the path the browser loads is empty. If the old folder cannot be moved, for example because the browser holds it open on Windows, the update waits and the old folder stays as it was. Files are never overwritten one by one. If SynaBun is stopped part-way, its next start finishes or reverses the step from that record. An old folder goes back only if the record shows it was the verified extension.
- **Reload after a repair.** When SynaBun replaces files in the folder that were not the verified extension, even at the same version, your browser keeps running the old files until the extension is reloaded. Settings and the setup page then ask you to choose **Reload** on SynaBun Browser Bridge in `chrome://extensions` (`edge://extensions` in Edge), whether or not the extension is connected. They keep asking across restarts, and if the setup port changes meanwhile, the repair is still what they ask about. Once you have reloaded it, choose **I reloaded the extension** in **Settings → Browser**. Only that click clears the request. The setup page does not clear it, even when it sees the extension, because the old copy has the same version and would answer the page in the same way.
- **What that confirmation cannot prove.** A changed extension with access to all sites can run scripts on any page in that browser, SynaBun's own Settings included, so no confirmation inside the browser is fully tamper-proof. The confirmation stops an old copy from clearing the warning by itself, simply by still running. If you suspect the extension was changed, remove it from the browser, then choose **Connect your browser** again.
- **Your pairing is kept.** The extension keeps the same identity in every version, so an update does not ask you to pair again. When only the setup page's port changes, Settings asks you to reload the extension until the setup page sees it running on the new port.

If you connected with an earlier SynaBun version, your browser may have loaded the extension from a folder inside SynaBun's own install location (a path that contains `node_modules` or the app's resources). That folder no longer contains the extension, so the browser reports it as missing after the update. Choose **Connect your browser** again and load the folder SynaBun shows. It is the same extension.

## Choose what agents can access

**Full control** is the default. An agent can open tabs, use your existing tabs and work on signed-in sites or local development servers. Use **Take back** in the popup to regain control of a tab.

Choose **Only sites and tabs I share** in **Settings → Browser → Agent access** or in the popup to limit access. Share the site and tab from the popup, then enable new tabs or downloads if the task needs them. For uploads, place the intended files in the upload folder shown in Settings and pass their absolute paths to `browser_upload`. The Chrome extension reads them through the local bridge because its service worker has no direct filesystem access. It uses the existing isolated content script to set the input and fire its input and change events. This needs no debugger permission.

**Disconnect** pauses access across restarts. **Revoke pairing** ends the pairing. After an update, follow the prompt in **Settings → Browser**.

## Read pages without page scripts

SynaBun Browser Bridge 1.5.0 reads pages with fixed readers that ship inside the extension. They need no **Allow User Scripts** and no debugger, and they add no permission: reload the extension once after the update and they are on.

- `browser_content` returns a page's text, or its main content as Markdown, with the same `maxChars` and `offset` paging as SynaBun's own browser. A long article is read page by page: each cut page ends with the offset to continue from.
- `browser_snapshot` keeps whole paragraphs and headings, and pages a long page with `offset` (the snapshot says where to continue).
- The site extractors (`browser_extract_*`), `browser_fb_composer_state`, `youtube_channel` and the channel lookup of the other YouTube Studio tools use readers built from the same scripts SynaBun's own browser runs. `browser_extract_tiktok_profile` with `signedIn` reads which TikTok account is signed in.
- `browser_wait` waits for the `load`, `domcontentloaded` and `networkidle` states.

A reader is chosen by its name only, from a fixed list in the extension. It reads what the page shows and changes nothing on it; a feed extractor also scrolls its feed. Agents cannot send code to it. Readers follow the same access rules as every other tool: only an agent's own tab, only pages the access mode allows, never SynaBun's own pages or the browser's pages.

## Let agents run page scripts

`browser_evaluate` runs JavaScript in a tab the agent controls. It needs SynaBun Browser Bridge 1.4.0 or later and a one-time setup in the browser (`browser_wait`'s load states need only the Reload of step 1; reading pages needs no setup at all, see [Read pages without page scripts](#read-pages-without-page-scripts)):

1. Open the browser's extensions page (`chrome://extensions`, or `edge://extensions` in Edge) and choose **Reload** on SynaBun Browser Bridge. Version 1.4.0 adds two permissions: `userScripts`, to run a script in a page, and `webRequest`, to see when a tab's requests start and end. The extension never blocks or changes a request and reads no request content.
2. Choose **Details** on the extension and turn on **Allow User Scripts**. In Chrome or Edge before version 138, turn on **Developer mode** at the top of the extensions page instead.
3. Choose **Reload** once more.

Page scripts stay off until you turn on **Allow User Scripts**. Every other tool works without it, and you can turn it off again at any time. A script runs only in a tab the agent controls, on a page the access mode allows, and never on SynaBun's own pages or the browser's pages. It can read what the page's own JavaScript can read, including form values and the site's storage, so leave the switch off if agents should not have that.

Automations that publish on X or pace their social posts are held to the same publish gate and spacing here as in SynaBun's other browsers.

## Troubleshooting

| Message | What to do |
| --- | --- |
| `EXTENSION_NOT_CONNECTED` | Open the paired browser, check that the extension is enabled, and compare the port in its popup with the port in Settings. If the extension is missing from the browser after a SynaBun update, see [Where the extension comes from](#where-the-extension-comes-from). |
| `EXTENSION_DOWNLOAD_OFFLINE` | SynaBun could not reach synabun.ai. Check your internet connection, then choose **Try again**. |
| `EXTENSION_DOWNLOAD_UNAVAILABLE` | synabun.ai did not have the extension your SynaBun version needs. Try again later, or update SynaBun. |
| `EXTENSION_VERIFY_FAILED` | The download was not the file your SynaBun version expects, so SynaBun installed nothing. Choose **Try again**. If it keeps happening, update SynaBun. This check cannot be skipped. |
| `EXTENSION_FOLDER_UNSAFE` | `browser-extension` in SynaBun's data folder, or the data folder itself, is a link, belongs to another user, or can be written by others, so SynaBun changed nothing there. On Linux, a group that is not your own private group counts as others (see [Where the extension comes from](#where-the-extension-comes-from)); the server's log line says which check failed. Fix its owner and permissions, or remove the `browser-extension` folder, then choose **Connect your browser** again. |
| `PAIRING_EXPIRED` | Start a fresh pairing from Settings. |
| `SITE_NOT_APPROVED` | In restricted mode, share the site in the popup. |
| `NAVIGATION_NOT_COMMITTED` | Check which page the tab shows before retrying. |
| `NO_HISTORY_ENTRY` | The tab has reached the end of its history in that direction. Navigate to the desired page directly. |
| `RESTRICTED_PAGE` or `SYNABUN_PAGE_BLOCKED` | Choose an ordinary website tab. Browser settings, extension pages and SynaBun's control interface are protected. |
| `USER_SCRIPTS_DISABLED` | Turn on **Allow User Scripts** in the extension's details, then reload the extension. See [Let agents run page scripts](#let-agents-run-page-scripts). |
| `USER_SCRIPTS_UNSUPPORTED` | Update Chrome or Edge to version 135 or later. |
| `EXTENSION_RELOAD_REQUIRED` | The browser still runs an older copy of the extension. Reload SynaBun Browser Bridge from the browser's extensions page. If Settings says the extension folder is still being updated, wait for that to finish first. |
| `READER_FAILED` | The page changed while it was read, or it is not the page the reader is for. Check the tab, then try again. |
| `INVALID_SELECTOR` | Pass a valid CSS selector to `browser_content`. |
| `SCROLL_TARGET_MISSING` | The extractor's feed is not on the page. Open the right page (for example the chat in WhatsApp Web), then try again. |
| `ACTIVE_TAB_REQUIRED` | Screenshots capture the tab a window is showing. In full control the extension brings the agent's tab forward; in restricted mode, activate the tab yourself or switch to full control. To read a page, use `browser_snapshot` or `browser_content` instead. |
| `OPERATION_FAILED` | The browser refused the operation. The message ends with what the browser said. If a new tab cannot open because no browser window is open, SynaBun now opens a minimized window for it; if that is refused too, open a browser window and try again. |
| `NETWORK_IDLE_UNAVAILABLE` | Reload the extension so its `webRequest` permission takes effect. Until then, wait for an element or for the `load` state. |
| `PAGE_ERROR` | The script itself failed on the page. Pass one JavaScript expression and wrap statements in a function: `(() => { …; return value; })()`. |
| `BLANK_PAGE` | Navigate the tab to a website before running a script. |

On sites such as Nexus, complete any site challenge yourself. Cloudflare acceptance depends on the site.

## Tool support

Page interactions operate on the top document. Upload selectors also search open shadow roots and same-origin frames. Some controls require manual input. If a tool returns `UNSUPPORTED_IN_EXTENSION_MODE`, consult its row below.

The site extractors and `browser_fb_composer_state` use the extension's fixed readers (1.5.0 and later, see [Read pages without page scripts](#read-pages-without-page-scripts)). They read the same page elements as in SynaBun's own browser; how a site changes its pages affects both alike.

| Tool | Status | Scope |
| --- | --- | --- |
| browser_batch | Partial | Runs supported steps in sequence. |
| browser_cheatsheet | Supported | Shows tool help. |
| browser_click | Partial | Works with standard controls in the top document. |
| browser_console | Unsupported | Unavailable in extension mode: reading the console needs the debugger. |
| browser_content | Supported | Text and Markdown of the top document, paged with `maxChars` and `offset`. Needs 1.5.0 for Markdown. |
| browser_evaluate | Partial | Runs one JavaScript expression in the controlled tab once **Allow User Scripts** is on. A script can run for up to 30 seconds and return up to 1,000,000 characters of JSON. |
| browser_extract_fb_groups | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_fb_posts | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_ig_feed | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_ig_post | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_ig_profile | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_ig_reels | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_ig_search | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_li_feed | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_li_jobs | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_li_messages | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_li_network | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_li_notifications | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_li_post | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_li_profile | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_li_search_people | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_tiktok_profile | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_tiktok_search | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_tiktok_studio | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_tiktok_videos | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_tweets | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_wa_chats | Supported | Fixed reader, 1.5.0 and later. |
| browser_extract_wa_messages | Supported | Fixed reader, 1.5.0 and later. |
| browser_fb_composer_state | Supported | Fixed reader, 1.5.0 and later. Advisory reading only. |
| browser_fill | Partial | Works with standard controls in the top document. |
| browser_go_back | Supported | Moves back through the controlled tab’s history. |
| browser_go_forward | Supported | Moves forward through the controlled tab’s history. |
| browser_hover | Partial | Works with standard controls in the top document. |
| browser_navigate | Supported | Opens an address permitted by the current access mode. |
| browser_press | Partial | Works with standard controls in the top document. |
| browser_reload | Supported | Reloads the controlled tab. |
| browser_screenshot | Partial | Captures the visible viewport of the tab a window shows. Full control brings the agent's tab to the front of its window; restricted mode needs the tab to be active. No full-page, element or resized capture, and no capture of a background tab (that needs the debugger). |
| browser_scroll | Partial | Works with standard controls in the top document. |
| browser_select | Partial | Works with standard controls in the top document. |
| browser_session | Supported | Lists, opens or claims tabs according to the current access mode. |
| browser_snapshot | Partial | Lists semantic elements of the top document (mode "ai" only), with whole paragraphs, paged with `offset` in 1.5.0 and later. |
| browser_type | Partial | Works with standard controls in the top document. |
| browser_upload | Partial | Attaches up to four staged files, up to 50 MiB total. The input’s `accept` filter applies to every file. The result lists each selected file’s name, MIME type and byte size. Check the page for upload progress. |
| browser_wait | Supported | Waits for an element in the top document, a fixed time, or the `load`, `networkidle` and (1.5.0) `domcontentloaded` page states. None needs **Allow User Scripts**. |
| browser_x_compose_state | Unsupported | Unavailable in extension mode. |

What still needs SynaBun's own browser (or Allow User Scripts): `browser_evaluate` with arbitrary code (Allow User Scripts), the console, snapshot modes other than "ai", full-page, element, resized and background-tab screenshots, network interception, native file choosers and dialogs, frames other than the top document for page tools, `browser_x_compose_state`, and the GSC and Bluesky tools, whose page scripts have no fixed reader yet.

## Extension versions

| Version | What changed | What the owner does |
| --- | --- | --- |
| 1.5.0 | Fixed page readers: `browser_content` text and Markdown with paging, a paged snapshot with whole paragraphs, the site extractors and YouTube Studio's channel lookup, `browser_wait` `domcontentloaded`. A new tab opens in a minimized window of its own when the browser has no window, and a refusal says what the browser said. Uploaded files get their real type (`video/mp4`, `image/png`, …). No new permission. | Reload the extension. **Allow User Scripts** is not needed for any of this. |
| 1.4.0 | `browser_evaluate` through user scripts and the `load` and `networkidle` waits. Permissions `userScripts` and `webRequest`. | Reload the extension; turn on **Allow User Scripts** only for page scripts. |
