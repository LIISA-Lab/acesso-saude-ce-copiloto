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
  // A lógica (reinício automático e erros) vive em stt_engine.js; aqui
  // fica só a cola com o painel lateral.
  const ReconhecimentoCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  const enviarAoPainel = (mensagem) => {
    try {
      chrome.runtime.sendMessage(mensagem).catch(() => { });
    } catch (e) { /* contexto invalidado: o motor para de reiniciar sozinho */ }
  };

  const motorStt = window.__copilotoStt.criarMotorStt({
    criarReconhecimento: ReconhecimentoCtor ? () => new ReconhecimentoCtor() : null,
    contextoValido: () => {
      try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
    },
    aoTexto: (texto) => enviarAoPainel({ action: "UPDATE_TRANSCRIPT", text: texto }),
    aoStatus: ({ status, motivo }) => enviarAoPainel({ action: "SCRIBE_STATUS", status, motivo }),
    log: (msg) => console.log("[Copiloto][Scribe]", msg),
  });

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => motorStt.dispose());
  }

  // Escuta os comandos do Painel Lateral
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_RECORDING") {
      motorStt.iniciar();
      sendResponse({ status: "started" });
    }

    else if (request.action === "STOP_RECORDING") {
      // Resposta assíncrona: o motor espera o resultado final do reconhecedor
      motorStt.parar().then(({ transcript }) => {
        sendResponse({ status: "stopped", transcript });
      });
      return true;
    }

    // Descarta a gravação em andamento (ex.: o médico trocou de atendimento)
    else if (request.action === "CANCEL_RECORDING") {
      motorStt.cancelar();
      sendResponse({ status: "cancelled" });
    }

    return false;
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
