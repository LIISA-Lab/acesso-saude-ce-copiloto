// Escopo protegido (IIFE) para blindar as variáveis globais e impedir o erro
// "Identifier has already been declared" quando o Chrome injetar o script duas vezes
(function () {
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
  let total_atendimentosGlobal = 0;
  let ultimo_diagnosticoGlobal = "Nenhum";
  let id_atendimentoGloball = null;

  // Recupera dados antigos caso a página tenha sido recarregada (F5) direto na tela de vídeo
  chrome.storage.local.get(['dadosBrutosDaTela'], (result) => {
    if (result && result.dadosBrutosDaTela) {
      try {
        let parseado = JSON.parse(result.dadosBrutosDaTela);
        if (parseado && parseado.paciente && parseado.paciente.nome !== "Aguardando navegação...") {
          pacienteGlobal = parseado.paciente;
          atendimentosGlobais = parseado.atendimentos || [];
          total_atendimentosGlobal = parseado.total_atendimentos || 0;
          ultimo_diagnosticoGlobal = parseado.ultimo_diagnostico || "Nenhum";
          id_atendimentoGloball = parseado.id_atendimento || null;
          console.log("[Copiloto] Histórico restaurado da memória local com sucesso (Sobreviveu ao F5).");
        }
      } catch (e) { }
    }
  });

  // Converte o timestamp Unix (segundos) do sessionStorage para o formato usado na raspagem
  function formatarDataHora(timestamp) {
    if (!timestamp) return "Data Indisponível";
    const d = new Date(timestamp * 1000);
    return d.toLocaleString('pt-BR');
  }

  // Verifica a URL da página (Como a Vercel pode esconder a URL base no SPA, rodamos independente da rota)
  // Simula a extração de dados da tela. O ideal aqui no futuro é ler o DOM de verdade
  function extrairDadosDoSessionStorage() {
    // 1. Extrair Dados do Paciente (Atualiza apenas se a aba 'Consulta' estiver aberta com os dados)
    try {
      const totalAtendimentos = parseInt(sessionStorage.getItem('n_atendimentos')) || 0;
      const ultimoDiagnostico = sessionStorage.getItem('ultimo_diagnostico') || "Nenhum";
      const idAtendimento = sessionStorage.getItem('ws_agendamento_id') || null;

      if (totalAtendimentos !== total_atendimentosGlobal) {
        total_atendimentosGlobal = totalAtendimentos;
      }
      if (ultimoDiagnostico !== ultimo_diagnosticoGlobal) {
        ultimo_diagnosticoGlobal = ultimoDiagnostico;
      }
      if (idAtendimento !== id_atendimentoGloball) {
        id_atendimentoGloball = idAtendimento;
      }
    } catch (e) {
      console.error("[Copiloto] Erro ao buscar resumo:", e);
    }

    try {
      const nome = sessionStorage.getItem('paciente_nome') || "Aguardando navegação...";
      const idade = parseInt(sessionStorage.getItem('paciente_idade')) || 0;

      if (nome !== pacienteGlobal.nome || idade !== pacienteGlobal.idade) {
        pacienteGlobal.nome = nome;
        pacienteGlobal.idade = idade;
        pacienteGlobal.id = nome;
      };
    } catch (e) {
      console.error("[Copiloto] Erro ao buscar paciente:", e);
    }

    try {
      const historicoBruto = sessionStorage.getItem('historico');

      //Se encontrou dados de histórico na tela, vamos montar a lista
      if (historicoBruto && historicoBruto.length > 0) {
        const historico = JSON.parse(historicoBruto);

        const atendimentos = historico.map(el => ({
          data_hora: formatarDataHora(el.data_hora),
          especialidade: el.medico?.perfil_medico?.especialidade || "Indisponível",
          profissional_nome: el.medico?.nome_completo || "Indisponível",
          profissional_crm: "",
          anamnese: el.prontuario?.anamnese || "Indisponível",
          hipotese_diagnostica: el.prontuario?.diagnosticHypothesis || "Indisponível",
          conduta_medica: el.prontuario?.conduct || "Indisponível",
          observacoes_adicionais: el.prontuario?.observations || "Indisponível",
        }))

        // Atualiza o histórico global na memória APENAS se encontrou novos atendimentos na tela
        if (atendimentos.length > 0) {
          atendimentosGlobais = atendimentos;
        }
      }
    } catch (e) {
      console.warn("[Copiloto] Erro varrendo histórico:", e);
    }

    // Retorna os dados UNIFICADOS da memória (sobrevivem à troca de abas)
    return JSON.stringify({
      paciente: pacienteGlobal,
      atendimentos: atendimentosGlobais,
      alergias: [],
      total_atendimentos: total_atendimentosGlobal,
      ultimo_diagnostico: ultimo_diagnosticoGlobal,
      id_atendimento: id_atendimentoGloball,
    });
  }
  // Como o site é um SPA (Single Page Application - React/NextJS), a URL muda mas a página não recarrega.
  // Para resolver isso, usamos um pequeno monitor (polling) que sempre envia o que está na tela pro Storage
  let timerVigilante = null;

  function atualizarContexto() {
    try {
      // 0. Engana o React forçando a abertura dos históricos para ler os textos ocultos
      // autoExpandirHistorico();

      // 1. Extrai o dado do DOM
      const dadosBrutos = extrairDadosDoSessionStorage();

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

    recognition.onresult = function (event) {
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
      }).catch(() => { });
    };

    recognition.onerror = function (event) {
      console.error("[Copiloto Scribe] Erro no microfone:", event.error);
      if (event.error === 'not-allowed') gravando = false;
    };
  }

  // Escuta os comandos do Painel Lateral
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_RECORDING") {
      gravando = false;
      if (recognition) {
        try { recognition.abort(); } catch (e) { } // Mata qualquer gravação fantasma antiga
      }

      transcricaoAcumulada = "";
      gravando = true;

      // Dá um tempinho de 100ms pro abort funcionar antes de reiniciar
      setTimeout(() => {
        if (recognition && gravando) {
          try { recognition.start(); } catch (e) { }
        }
      }, 100);
      sendResponse({ status: "started" });
    }

    else if (request.action === "STOP_RECORDING") {
      // `gravando = false` já faz o onresult ignorar áudio residual. Não se deve
      // zerar `recognition.onresult` aqui: nada o restaura e a gravação seguinte
      // ficaria para sempre sem transcrição.
      gravando = false;
      if (recognition) {
        try { recognition.stop(); } catch (e) { }
        try { recognition.abort(); } catch (e) { } // Força a parada imediata
      }
      sendResponse({ status: "stopped" });
    }

    // Descarta a gravação em andamento (ex.: o médico trocou de atendimento)
    else if (request.action === "CANCEL_RECORDING") {
      gravando = false;
      transcricaoAcumulada = "";
      if (recognition) {
        try { recognition.abort(); } catch (e) { }
      }
      sendResponse({ status: "cancelled" });
    }

    return true;
  });

  // Roda a extração pela primeira vez imediatamente, aguardando o tempo do React montar a tela
  console.log("[Copiloto] Content Script INJETADO com sucesso na página!");
  atualizarContexto();

  timerVigilante = setInterval(atualizarContexto, 1000);

  // Atualiza na hora quando o médico clica (ex: troca de paciente)
  document.addEventListener('click', () => {
    setTimeout(atualizarContexto, 250);
  });

})(); // Fim do escopo protegido

console.log("[Copiloto] Monitor de prontuário ativo na página.");
