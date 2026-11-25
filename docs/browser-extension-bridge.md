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
- **Updates.** When a new SynaBun version needs a newer extension, SynaBun downloads it in the background after it starts and replaces the folder's files. If that download fails, the folder you have keeps working and Settings offers **Try again**. Afterwards, choose **Reload** on SynaBun Browser Bridge in the browser's extensions page when Settings prompts you.
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

**Disconnect** pauses access across restarts. **Revoke pairing** ends the pairing. After an update, reload SynaBun Browser Bridge from the browser's extensions page when prompted.

## Let agents run page scripts

`browser_evaluate` runs JavaScript in a tab the agent controls. `browser_wait` can also wait until a page has loaded or its network has gone quiet. Both need SynaBun Browser Bridge 1.4.0 or later and a one-time setup in the browser:

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
| `NETWORK_IDLE_UNAVAILABLE` | Reload the extension so its `webRequest` permission takes effect. Until then, wait for an element or for the `load` state. |
| `PAGE_ERROR` | The script itself failed on the page. Pass one JavaScript expression and wrap statements in a function: `(() => { …; return value; })()`. |
| `BLANK_PAGE` | Navigate the tab to a website before running a script. |

On sites such as Nexus, complete any site challenge yourself. Cloudflare acceptance depends on the site.

## Tool support

Page interactions operate on the top document. Upload selectors also search open shadow roots and same-origin frames. Some controls require manual input. If a tool returns `UNSUPPORTED_IN_EXTENSION_MODE`, consult its row below.

The site extractors and composer-state tools were built for SynaBun's own browser and stay listed as unsupported. Some of them read the page with a script, so they may answer in extension mode once **Allow User Scripts** is on. They have not been validated there.

| Tool | Status | Scope |
| --- | --- | --- |
| browser_batch | Partial | Runs supported steps in sequence. |
| browser_cheatsheet | Supported | Shows tool help. |
| browser_click | Partial | Works with standard controls in the top document. |
| browser_console | Unsupported | Unavailable in extension mode. |
| browser_content | Partial | Works with standard controls in the top document. |
| browser_evaluate | Partial | Runs one JavaScript expression in the controlled tab once **Allow User Scripts** is on. A script can run for up to 30 seconds and return up to 1,000,000 characters of JSON. |
| browser_extract_fb_groups | Unsupported | Unavailable in extension mode. |
| browser_extract_fb_posts | Unsupported | Unavailable in extension mode. |
| browser_extract_ig_feed | Unsupported | Unavailable in extension mode. |
| browser_extract_ig_post | Unsupported | Unavailable in extension mode. |
| browser_extract_ig_profile | Unsupported | Unavailable in extension mode. |
| browser_extract_ig_reels | Unsupported | Unavailable in extension mode. |
| browser_extract_ig_search | Unsupported | Unavailable in extension mode. |
| browser_extract_li_feed | Unsupported | Unavailable in extension mode. |
| browser_extract_li_jobs | Unsupported | Unavailable in extension mode. |
| browser_extract_li_messages | Unsupported | Unavailable in extension mode. |
| browser_extract_li_network | Unsupported | Unavailable in extension mode. |
| browser_extract_li_notifications | Unsupported | Unavailable in extension mode. |
| browser_extract_li_post | Unsupported | Unavailable in extension mode. |
| browser_extract_li_profile | Unsupported | Unavailable in extension mode. |
| browser_extract_li_search_people | Unsupported | Unavailable in extension mode. |
| browser_extract_tiktok_profile | Unsupported | Unavailable in extension mode. |
| browser_extract_tiktok_search | Unsupported | Unavailable in extension mode. |
| browser_extract_tiktok_studio | Unsupported | Unavailable in extension mode. |
| browser_extract_tiktok_videos | Unsupported | Unavailable in extension mode. |
| browser_extract_tweets | Unsupported | Unavailable in extension mode. |
| browser_extract_wa_chats | Unsupported | Unavailable in extension mode. |
| browser_extract_wa_messages | Unsupported | Unavailable in extension mode. |
| browser_fb_composer_state | Unsupported | Unavailable in extension mode. |
| browser_fill | Partial | Works with standard controls in the top document. |
| browser_go_back | Supported | Moves back through the controlled tab’s history. |
| browser_go_forward | Supported | Moves forward through the controlled tab’s history. |
| browser_hover | Partial | Works with standard controls in the top document. |
| browser_navigate | Supported | Opens an address permitted by the current access mode. |
| browser_press | Partial | Works with standard controls in the top document. |
| browser_reload | Supported | Reloads the controlled tab. |
| browser_screenshot | Partial | Captures the visible viewport. Full control may bring the tab to the front. |
| browser_scroll | Partial | Works with standard controls in the top document. |
| browser_select | Partial | Works with standard controls in the top document. |
| browser_session | Supported | Lists, opens or claims tabs according to the current access mode. |
| browser_snapshot | Partial | Lists semantic elements in the top document. |
| browser_type | Partial | Works with standard controls in the top document. |
| browser_upload | Partial | Attaches up to four staged files, up to 50 MiB total. The input’s `accept` filter applies to every file. The result lists each selected file’s name, MIME type and byte size. Check the page for upload progress. |
| browser_wait | Partial | Waits for an element in the top document, a fixed time, or the `load` and `networkidle` page states. `domcontentloaded` is unavailable. |
| browser_x_compose_state | Unsupported | Unavailable in extension mode. |
