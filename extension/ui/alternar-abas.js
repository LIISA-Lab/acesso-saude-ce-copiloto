let emTeleconsulta = false;
let abaAtual = 'chat';

// Atualiza a visibilidade das abas e áreas de acordo com o estado atual
function atualizarTab() {
    const escriba = document.getElementById('scribeBox'); 
    const tabs = document.getElementById('tabs');
    if ( !escriba || !tabs ) return;

    const mostrarChat = !emTeleconsulta || abaAtual === 'chat';

    tabs.style.display = emTeleconsulta ? '' : 'none';
    escriba.style.display = (emTeleconsulta && abaAtual === 'escriba') ? '' : 'none';
    document.getElementById('chatContainer').style.display = mostrarChat ? '' : 'none';
    document.getElementById('inputArea').style.display = mostrarChat ? '' : 'none';
}

// Função para mostrar ou ocultar a caixa de escrita
function mostrarEscriba(visivel) {
    emTeleconsulta = visivel;
    atualizarTab();
}

// Alterna entre as abas de chat e escriba
function trocarAba(aba) {
    abaAtual = aba;
    document.getElementById('btn-chat').classList.toggle('selected', abaAtual === 'chat');
    document.getElementById('btn-escriba').classList.toggle('selected', abaAtual === 'escriba');
    atualizarTab();
}

// Diz se a URL é a da videochamada, onde o Escriba deve aparecer
function urlDoEscriba(url) {
  return url?.includes(TELEATENDIMENTO_URL + '/video-conference');
}

// Mostra ou oculta a caixa de escrita dependendo da URL da aba do teleatendimento
chrome.storage.session.get('urlTeleatendimento', ({ urlTeleatendimento }) => {
  mostrarEscriba(urlDoEscriba(urlTeleatendimento));
});

// Atualiza a visibilidade do escriba quando a URL da aba do teleatendimento muda
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.urlTeleatendimento) {
    mostrarEscriba(urlDoEscriba(changes.urlTeleatendimento.newValue));
  }
});

// Atualiza a visibilidade do escriba quando a aba do teleatendimento muda
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-chat').addEventListener('click', () => trocarAba('chat'));
    document.getElementById('btn-escriba').addEventListener('click', () => trocarAba('escriba'));
    atualizarTab();
})