# Use your existing browser with SynaBun

Connect Chrome or Edge to let an agent work in a browser profile where you are already signed in.

## Connect the extension

1. On macOS, Windows or Linux, open **Settings → Browser** in SynaBun. Select **Existing browser via extension** and choose **Connect your browser**.
2. In the browser you want to connect, open the extensions address shown on the setup page. Turn on **Developer mode**, choose **Load unpacked**, and select the folder SynaBun opened. Use this folder again if you reinstall the extension.
3. Keep the setup page open until it shows **Connected**. For manual pairing, start pairing in Settings and enter the displayed port and code in the extension popup.

The extension connects to SynaBun on this computer at `127.0.0.1`. Setup requires neither a NativeMessagingHosts installation nor an allowed_origins manifest. If your organization blocks unpacked extensions, contact your browser administrator.

## Choose what agents can access

**Full control** is the default. An agent can open tabs, use your existing tabs and work on signed-in sites or local development servers. Use **Take back** in the popup to regain control of a tab.

Choose **Only sites and tabs I share** in **Settings → Browser → Agent access** or in the popup to limit access. Share the site and tab from the popup, then enable new tabs or downloads if the task needs them. For uploads, place the intended files in the upload folder shown in Settings.

**Disconnect** pauses access across restarts. **Revoke pairing** ends the pairing. After an update, reload SynaBun Browser Bridge from the browser's extensions page when prompted.

## Troubleshooting

| Message | What to do |
| --- | --- |
| `EXTENSION_NOT_CONNECTED` | Open the paired browser, check that the extension is enabled, and compare the port in its popup with the port in Settings. |
| `PAIRING_EXPIRED` | Start a fresh pairing from Settings. |
| `SITE_NOT_APPROVED` | In restricted mode, share the site in the popup. |
| `NAVIGATION_NOT_COMMITTED` | Check which page the tab shows before retrying. |
| `NO_HISTORY_ENTRY` | The tab has reached the end of its history in that direction. Navigate to the desired page directly. |
| `RESTRICTED_PAGE` or `SYNABUN_PAGE_BLOCKED` | Choose an ordinary website tab. Browser settings, extension pages and SynaBun's control interface are protected. |

On sites such as Nexus, complete any site challenge yourself. Cloudflare acceptance depends on the site.

## Tool support

Page interactions operate on the top document. Some controls require manual input. If a tool returns `UNSUPPORTED_IN_EXTENSION_MODE`, consult its row below.

| Tool | Status | Scope |
| --- | --- | --- |
| browser_batch | Partial | Runs supported steps in sequence. |
| browser_cheatsheet | Supported | Shows tool help. |
| browser_click | Partial | Works with standard controls in the top document. |
| browser_console | Unsupported | Unavailable in extension mode. |
| browser_content | Partial | Works with standard controls in the top document. |
| browser_evaluate | Unsupported | Unavailable in extension mode. |
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
| browser_upload | Partial | Uses up to four files from the upload folder, up to 1 MB total. |
| browser_wait | Partial | Works with standard controls in the top document. |
| browser_x_compose_state | Unsupported | Unavailable in extension mode. |
