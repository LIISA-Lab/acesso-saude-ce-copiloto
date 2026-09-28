// Força o carregamento do content script avisando o background (fallback de injeção)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes("teleatendimento-git-preview-carlos-projects-90dab6f9.vercel.app")) {
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
      if (aba.url && aba.url.includes("teleatendimento-git-preview-carlos-projects-90dab6f9.vercel.app")) {
        chrome.scripting.executeScript({
          target: { tabId: aba.id },
          files: ['scripts/content_script.js']
        }).catch(err => console.error("Erro ao injetar:", err));
      }
    });
  });
});

// Responde "quem sou eu" para o content script: ele não tem acesso direto a chrome.tabs,
// então pergunta ao background, que enxerga o ID da aba de quem enviou a mensagem (sender.tab.id).
// Isso é essencial para o content script gravar seus dados numa chave DE STORAGE PRÓPRIA POR ABA,
// evitando que duas abas/atendimentos abertos ao mesmo tempo sobrescrevam os dados um do outro.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "GET_TAB_ID") {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return true;
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