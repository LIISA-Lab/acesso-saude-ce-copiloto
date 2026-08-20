// Força o carregamento do content script avisando o background (fallback de injeção)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes("teleatendimento.vercel.app")) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['scripts/content_script.js']
    }).catch(err => console.error("Erro ao forçar injeção:", err));
  }
});

// Abre o Side Panel quando o ícone da extensão é clicado
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});