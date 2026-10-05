import { hostedSidepanelId, sidepanelHost } from './ui-sidepanel-runtime.js';
import { emit } from './state.js';

const host = sidepanelHost();
const provider = new URLSearchParams(location.search).get('provider');
if (hostedSidepanelId && host) {
  try {
    let receivePath, end, defaults;
    if (provider === 'claude') {
      const panel = await import('./ui-claude-panel.js');
      await panel.toggleClaudePanel();
      receivePath = panel.sendToPanel;
      end = panel.endHostedClaudeSessions;
      defaults = () => ({ project: document.querySelector('#cp-project')?._value || '' });
    } else if (provider === 'codex') {
      const panel = await import('./ui-codex-panel.js');
      const tabs = await import('./cdx/cdx-tabs.js');
      await panel.toggleCodexPanel();
      receivePath = tabs.addPathChip;
      end = () => { while (tabs.allTabs().length) tabs.closeTab(tabs.allTabs().length - 1); };
      defaults = () => ({ project: tabs.activeTab()?.project || '' });
    } else if (provider === 'opencode') {
      const panel = await import('./ocp-v2/ocp-v2-panel.js');
      const store = await import('./ocp-v2/ocp-v2-state.js');
      await panel.toggleOpencodePanel();
      receivePath = panel.attachPathToOpencode;
      end = panel.endHostedOpenCodeSessions;
      defaults = () => ({ project: store.getState().cwd || '' });
    } else throw new Error('Unknown session provider');
    const focus = () => document.querySelector('#cp-input, #cxp-input, .ocpv2-compose textarea')?.focus();
    const title = document.querySelector('.cp-session-label, .cxp-session-label, .ocpv2-session-label');
    const syncTitle = () => host.title(hostedSidepanelId, title?.textContent?.trim());
    if (title) new MutationObserver(syncTitle).observe(title, { childList: true, subtree: true, characterData: true });
    syncTitle();
    host.ready(hostedSidepanelId, { focus, defaults, end, receive(kind, data) {
      if (kind === 'path') return receivePath(data);
      emit(kind === 'image' ? 'wb:send-to-panel' : kind, data);
    } });
  } catch (error) { host.fail(hostedSidepanelId, error.message); }
}
