import { initPwaInstall, isStandalone, requestPwaInstall } from './pwa-install.js';

if (isStandalone()) location.replace('/');
else {
  const pt = navigator.language.toLowerCase().startsWith('pt');
  const copy = pt ? {
    'install-title': 'Instale o SynaBun como app',
    'install-intro': 'O servidor está rodando em segundo plano. Confirme a instalação uma vez no navegador para abrir o SynaBun em sua própria janela.',
    'install-chromium': 'Chrome ou Edge: escolha Instalar como app abaixo ou a opção Instalar app no menu do navegador.',
    'install-safari': 'Safari no macOS: escolha Arquivo → Adicionar ao Dock. Mantenha o nome SynaBun.',
    'install-later': 'Após instalar, abra novamente o iniciador nativo do SynaBun. Ele inicia ou reutiliza o servidor e abre o PWA instalado. Fechar a janela mantém o servidor ativo. Use Apps → Stop Server para pará-lo.',
    'install-button': 'Instalar como app', 'install-continue': 'Continuar para o SynaBun',
  } : {};
  if (pt) document.documentElement.lang = 'pt-BR';
  for (const [id, text] of Object.entries(copy)) document.getElementById(id).textContent = text;
  const status = document.getElementById('install-status');
  const instructions = pt
    ? 'Use a opção Instalar app do Chrome/Edge ou Arquivo → Adicionar ao Dock no Safari. A instalação exige sua confirmação no navegador.'
    : 'Use Chrome/Edge’s Install app menu or Safari’s File → Add to Dock. Installation requires your browser confirmation.';
  initPwaInstall({ changed: value => {
    status.textContent = value === 'installed'
      ? (pt ? 'Instalado. Abra novamente o iniciador do SynaBun para usar o PWA.' : 'Installed. Reopen the SynaBun launcher to use the PWA.')
      : (pt ? 'Pronto para instalar. Escolha Instalar como app.' : 'Ready to install. Choose Install as App.');
  } });
  document.getElementById('install-button').addEventListener('click', async () => {
    try {
      const result = await requestPwaInstall();
      status.textContent = result === 'accepted'
        ? (pt ? 'Confirmação aceita. O navegador está concluindo a instalação.' : 'Confirmation accepted. The browser is completing installation.')
        : instructions;
    } catch { status.textContent = instructions; }
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
