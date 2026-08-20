// Escopo protegido (IIFE) para blindar as variáveis globais e impedir o erro
// "Identifier has already been declared" quando o Chrome injetar o script duas vezes
(function() {
  // Evita execução duplicada caso injetado múltiplas vezes no mesmo contexto
  if (window.copilotoScribeInjetado) return;
  window.copilotoScribeInjetado = true;

  // Variáveis globais para armazenar os dados e sobreviver à troca de abas do React (SPA)
  let pacienteGlobal = {
    id: "Aguardando navegação...",
    nome: "Aguardando navegação...",
    cpf: "000.000.000-00",
    idade: 0
  };
  let atendimentosGlobais = [];

// Recupera dados antigos caso a página tenha sido recarregada (F5) direto na tela de vídeo
  chrome.storage.local.get(['dadosBrutosDaTela'], (result) => {
      if(result && result.dadosBrutosDaTela) {
          try {
              let parseado = JSON.parse(result.dadosBrutosDaTela);
              if (parseado && parseado.paciente && parseado.paciente.nome !== "Aguardando navegação...") {
                  pacienteGlobal = parseado.paciente;
                  atendimentosGlobais = parseado.atendimentos || [];
                  console.log("[Copiloto] Histórico restaurado da memória local com sucesso (Sobreviveu ao F5).");
              }
          } catch(e) {}
      }
  });

// Verifica a URL da página (Como a Vercel pode esconder a URL base no SPA, rodamos independente da rota)
// Simula a extração de dados da tela. O ideal aqui no futuro é ler o DOM de verdade
function extrairDadosDoDOM() {
  // 1. Extrair Dados do Paciente (Atualiza apenas se a aba 'Consulta' estiver aberta com os dados)
  try {
    const ps = document.querySelectorAll('p.text-muted');
    
    let dataNascimentoStr = null;
    let nomeEncontrado = null;

    for (const p of ps) {
      if (p.innerText.includes("Data de Nascimento:")) {
         dataNascimentoStr = p.innerText.split("Data de Nascimento:")[1].trim(); // ex: "22/11/1978"
         
         // Para evitar pegar um "h5" errado da tela, procuramos o Nome exatamente dentro do mesmo bloco da Data de Nascimento
         const containerPai = p.closest('.flex-grow-1') || p.parentElement.parentElement;
         if (containerPai) {
             const h5 = containerPai.querySelector('h5');
             if (h5) {
                 nomeEncontrado = h5.innerText.trim();
             }
         }
         break;
      }
    }

    // Só atualiza os dados na memória se achou a Data de Nascimento (Garante que estamos na aba certa)
    if (dataNascimentoStr) {
       if (nomeEncontrado && nomeEncontrado !== "Paciente") {
           pacienteGlobal.nome = nomeEncontrado;
           pacienteGlobal.id = nomeEncontrado;
       }

       const partes = dataNascimentoStr.split("/");
       if (partes.length === 3) {
          const dataNasc = new Date(partes[2], partes[1] - 1, partes[0]);
          const hoje = new Date();
          let idade = hoje.getFullYear() - dataNasc.getFullYear();
          const m = hoje.getMonth() - dataNasc.getMonth();
          if (m < 0 || (m === 0 && hoje.getDate() < dataNasc.getDate())) {
              idade--;
          }
          pacienteGlobal.idade = idade;
       }
    }
  } catch (e) {
    console.error("[Copiloto] Erro ao buscar paciente:", e);
  }

  // 2. Extrair o Histórico de Atendimentos
  try {
    // Encontra todos os "resumos" (cabeçalhos) dos Accordions do Material-UI
    const resumos = document.querySelectorAll('.MuiAccordionSummary-content');
    
    // Fallback: se não achar pelo MuiAccordionSummary, tenta achar as datas que você me passou
    let elementsBase = resumos;
    if (elementsBase.length === 0) {
      elementsBase = document.querySelectorAll('strong.text-dark');
    }
    
    // Se encontrou dados de histórico na tela, vamos montar a lista
    if (elementsBase.length > 0) {
        const atendimentos = [];

        elementsBase.forEach(el => {
          let resumo = el;
          // Se caiu no fallback das datas, precisamos subir alguns nós para pegar a barra inteira
          if (resumos.length === 0) {
              resumo = el.parentElement.parentElement;
          }

          const dataHoraEl = resumo.querySelector('strong.text-dark');
          const especialidadeEl = resumo.querySelector('.badge.bg-secondary');
          const profissionalEl = resumo.querySelector('.badge.bg-info');

          let dataHora = dataHoraEl ? dataHoraEl.innerText.trim() : "Data Indisponível";
          let especialidade = especialidadeEl ? especialidadeEl.innerText.replace('Especialidade:', '').trim() : "";
          let profissionalNome = profissionalEl ? profissionalEl.innerText.replace('Profissional de Saúde:', '').trim() : "";

          let anamnese = "Card fechado na interface. Expanda para ler.";
          let hipotese = "Indisponível";
          let conduta = "Indisponível";
          let observacoes = "Indisponível";

          // Tratamento robusto para não quebrar a página se as tags não existirem
          try {
            const accordionPai = resumo.closest('.MuiAccordion-root');
            
            if (accordionPai) {
               const textoGeral = accordionPai.innerText || "";
               
               const extractSection = (regexStart, regexEnd) => {
                  const startMatch = textoGeral.match(regexStart);
                  if (!startMatch) return "";
                  const startIndex = startMatch.index + startMatch[0].length;
                  let endIndex = textoGeral.length;
                  if (regexEnd) {
                     const endMatch = textoGeral.substring(startIndex).match(regexEnd);
                     if (endMatch) endIndex = startIndex + endMatch.index;
                  }
                  return textoGeral.substring(startIndex, endIndex).trim();
               };

               // Só extrai se achar a palavra chave, caso contrário assume que o card tá fechado
               if (textoGeral.toUpperCase().includes("ANAMNESE")) {
                 anamnese = extractSection(/ANAMNESE/i, /HIPÓTESE DIAGNÓSTICA/i) || anamnese;
                 hipotese = extractSection(/HIPÓTESE DIAGNÓSTICA/i, /CONDUTA MÉDICA/i) || hipotese;
                 conduta = extractSection(/CONDUTA MÉDICA/i, /OBSERVAÇÕES ADICIONAIS/i) || conduta;
                 observacoes = extractSection(/OBSERVAÇÕES ADICIONAIS/i, null) || observacoes;
               }
            }
          } catch (errInner) {
             console.warn("[Copiloto] Erro lendo detalhes de uma consulta:", errInner);
          }

          atendimentos.push({
             data_hora: dataHora,
             especialidade: especialidade,
             profissional_nome: profissionalNome,
             profissional_crm: "",
             anamnese: anamnese,
             hipotese_diagnostica: hipotese,
             conduta_medica: conduta,
             observacoes_adicionais: observacoes
          });
        });

        // Resolve o problema do React renderizar os mesmos cards duplicados (Desktop vs Mobile ocultos)
        // Usamos um Map para remover duplicatas baseando-se na data_hora única
        const mapaUnicos = new Map();
        atendimentos.forEach(a => {
            if (a.data_hora !== "Data Indisponível") {
                mapaUnicos.set(a.data_hora, a);
            }
        });
        
        const atendimentosDesduplicados = Array.from(mapaUnicos.values());

        // Atualiza o histórico global na memória APENAS se encontrou novos atendimentos na tela
        if (atendimentosDesduplicados.length > 0) {
            atendimentosGlobais = atendimentosDesduplicados;
        }
    }
  } catch(e) {
     console.error("[Copiloto] Erro varrendo histórico:", e);
  }

  // Retorna os dados UNIFICADOS da memória (sobrevivem à troca de abas)
  return JSON.stringify({
    paciente: pacienteGlobal,
    atendimentos: atendimentosGlobais,
    alergias: []
  });
}

// Força a abertura das sanfonas do Material-UI para o React renderizar os textos ocultos
function autoExpandirHistorico() {
  try {
    // Busca todos os botões de Accordion que estão com aria-expanded="false" (Fechados) 
    // e que o nosso script ainda não marcou como lido.
    const botoesFechados = document.querySelectorAll('.MuiAccordionSummary-root[aria-expanded="false"]:not([data-copiloto-lido="true"])');
    
    if (botoesFechados.length > 0) {
      console.log(`[Copiloto] Auto-expandindo ${botoesFechados.length} cartões de histórico para o robô ler...`);
      botoesFechados.forEach(btn => {
        // Dispara o clique nativo
        btn.click();
        // Marca pra não ficar clicando toda hora num loop infinito caso o médico queira fechar depois
        btn.setAttribute('data-copiloto-lido', 'true');
      });
    }
  } catch (e) {
    console.error("[Copiloto] Erro ao tentar expandir histórico:", e);
  }
}

// Como o site é um SPA (Single Page Application - React/NextJS), a URL muda mas a página não recarrega.
// Para resolver isso, usamos um pequeno monitor (polling) que sempre envia o que está na tela pro Storage
let timerVigilante = null;

function atualizarContexto() {
  try {
    // 0. Engana o React forçando a abertura dos históricos para ler os textos ocultos
    autoExpandirHistorico();

    // 1. Extrai o dado do DOM
    const dadosBrutos = extrairDadosDoDOM();

    // 2. Salva no banco de dados local do Chrome apenas se tivermos dados reais,
    // para não apagar o histórico se o médico der F5 na tela de vídeo onde não tem dados do paciente visualmente.
    if (pacienteGlobal.nome !== "Aguardando navegação...") {
        chrome.storage.local.set({ dadosBrutosDaTela: dadosBrutos });
    }
  } catch (e) {
    if (e.message && e.message.includes("Extension context invalidated")) {
        console.warn("[Copiloto] A extensão foi atualizada. Desligando scripts órfãos.");
        if (timerVigilante) clearInterval(timerVigilante);
    } else {
        console.error("[Copiloto] Erro ao extrair dados da página:", e);
    }
  }
}
    
// ============================================
// ESCRIBA AI - Reconhecimento de Voz (Mic do Jitsi)
// ============================================
let recognition = null;
let transcricaoAcumulada = "";
let gravando = false;

// Inicializa a API nativa do navegador
if ('webkitSpeechRecognition' in window) {
  recognition = new webkitSpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'pt-BR';

  recognition.onresult = function(event) {
    if (!gravando) return; // Trava de segurança para ignorar áudio residual

    let textoInterino = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        transcricaoAcumulada += event.results[i][0].transcript + " ";
      } else {
        textoInterino += event.results[i][0].transcript;
      }
    }
    
    // Manda em tempo real pro painel lateral
    chrome.runtime.sendMessage({
        action: "UPDATE_TRANSCRIPT", 
        text: transcricaoAcumulada + textoInterino
    }).catch(() => {});
  };

  recognition.onerror = function(event) {
    console.error("[Copiloto Scribe] Erro no microfone:", event.error);
    if (event.error === 'not-allowed') gravando = false;
  };
}

// Escuta os comandos do Painel Lateral
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START_RECORDING") {
    gravando = false;
    if (recognition) {
        try { recognition.abort(); } catch(e){} // Mata qualquer gravação fantasma antiga
    }
    
    transcricaoAcumulada = "";
    gravando = true;
    
    // Dá um tempinho de 100ms pro abort funcionar antes de reiniciar
    setTimeout(() => {
        if (recognition && gravando) {
            try { recognition.start(); } catch(e){}
        }
    }, 100);
    sendResponse({status: "started"});
  } 
  
  else if (request.action === "STOP_RECORDING") {
    gravando = false;
    if (recognition) {
        recognition.onresult = null; // Cega o microfone de enviar dados novos imediatamente
        try { recognition.stop(); } catch(e) {}
        try { recognition.abort(); } catch(e) {} // Força a parada imediata
    }
    sendResponse({status: "stopped"});
  } 
  
  return true; 
});

// Roda a extração pela primeira vez imediatamente, aguardando o tempo do React montar a tela
console.log("[Copiloto] Content Script INJETADO com sucesso na página!");
setTimeout(atualizarContexto, 1500);

  timerVigilante = setInterval(atualizarContexto, 2000);

})(); // Fim do escopo protegido

console.log("[Copiloto] Monitor de prontuário ativo na página.");
