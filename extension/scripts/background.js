// Força o carregamento do content script avisando o background (fallback de injeção)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes("teleatendimento.vercel.app")) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['scripts/content_script.js']
    }).catch(err => console.error("Erro ao forçar injeção:", err));
  }
});

// Injetando o content script em todas as abas abertas com a URL específica quando a extensão é instalada
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({}, (abas) => {
    abas.forEach(aba => {
      if (aba.url && aba.url.includes("teleatendimento.vercel.app")) {
        chrome.scripting.executeScript({
          target: { tabId: aba.id },
          files: ['scripts/content_script.js']
        }).catch(err => console.error("Erro ao injetar:", err));
      }
    });
  });
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