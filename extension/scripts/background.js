const site_teleatendimento = "teleatendimento.vercel.app";

// Força a injeção do content script em uma aba específica
function injetarContentScript(tabId) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ['scripts/content_script.js']
  }).catch(err => console.error("Erro ao forçar injeção:", err));
}

// Força o carregamento do content script avisando o background (fallback de injeção)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes(site_teleatendimento)) {
    injetarContentScript(tabId);
    chrome.storage.session.set({ abaTeleatendimento: tabId });
  }
});

// Injetando o content script em todas as abas abertas com a URL específica quando a extensão é instalada
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.clear();
  chrome.tabs.query({}, (abas) => {
    abas.forEach(aba => {
      if (aba.url && aba.url.includes(site_teleatendimento)) {
        injetarContentScript(aba.id);
        chrome.storage.session.set({ abaTeleatendimento: aba.id });
      }
    });
  });
});

// Limpa o storage local quando a aba do teleatendimento é fechada
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { abaTeleatendimento } = await chrome.storage.session.get('abaTeleatendimento');

  if (tabId === abaTeleatendimento) {
    chrome.storage.local.clear();
  }
});


// Abre o Side Panel quando o ícone da extensão é clicado
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Recarrega a extensão quando o painel é fechado
chrome.runtime.onConnect.addListener((porta) => {
  if (porta.name === 'painel') {
    porta.onDisconnect.addListener(() => chrome.runtime.reload());
  }
})