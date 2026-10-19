// Motor de transcrição contínua do Escriba AI (spec: tasks/stt-on-device/spec.md).
//
// Envolve o SpeechRecognition do Chrome para reiniciar sozinho quando o
// reconhecedor encerra (silêncio, limite do serviço) e limitar ciclos com falha.
// Não conhece o `chrome.*`: tudo que depende do ambiente entra por `opcoes`, o
// que permite testar com fakes. (O modo on-device foi retirado por ora.)
(function () {
  const TRANSITORIOS = new Set(['no-speech', 'aborted']);

  const PADRAO = {
    lang: 'pt-BR',
    retryStartMs: 150,          // S8: start() que lançou (ex.: InvalidStateError)
    backoffMs: [150, 500, 1000, 2000], // S9: entre ciclos falhos consecutivos
    maxCiclosFalhos: 5,         // S9
    cicloMinimoMs: 500,         // S9: ciclo mais curto que isso, sem resultado, é falho
    esperaStopMs: 1500,         // S15: tempo máximo esperando o resultado final após stop()
  };

  function criarMotorStt(opcoes) {
    const cfg = Object.assign({}, PADRAO, opcoes.config);
    const agendar = opcoes.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const cancelar = opcoes.clearTimeout || ((id) => clearTimeout(id));
    const agora = opcoes.now || (() => Date.now());
    const contextoValido = opcoes.contextoValido || (() => true);
    const aoTexto = opcoes.aoTexto || (() => {});
    const aoStatus = opcoes.aoStatus || (() => {});
    const log = opcoes.log || (() => {});

    // --- estado da sessão de gravação ---
    let geracao = 0;          // invalida eventos e awaits de sessões antigas
    let gravando = false;     // a sessão quer continuar ouvindo
    let parando = false;      // stop() pedido, aguardando o resultado final
    let reco = null;
    let cicloAtivo = false;   // start() aceito e onend ainda não chegou
    let ultimoStatus = null;
    let acumulado = '';
    let interino = '';
    let falhas = 0;
    let cicloInicio = 0;
    let cicloTeveResultado = false;
    let cicloErro = null;
    let paradaPendente = null; // { promessa, resolver }
    const timers = new Set();

    function agendarTimer(fn, ms) {
      const id = agendar(() => { timers.delete(id); fn(); }, ms);
      timers.add(id);
      return id;
    }

    function limparTimers() {
      timers.forEach((id) => cancelar(id));
      timers.clear();
    }

    function emitirStatus(status, motivo) {
      if (status === ultimoStatus && !motivo) return;
      ultimoStatus = status;
      try { aoStatus({ status, motivo }); } catch (_) { /* a UI nunca derruba o motor */ }
    }

    function emitirTexto() {
      try { aoTexto(acumulado + interino); } catch (_) { /* idem */ }
    }

    function descartarReconhecimento() {
      if (!reco) return;
      const antigo = reco;
      reco = null;
      cicloAtivo = false;
      antigo.onresult = antigo.onerror = antigo.onend = null;
      try { antigo.abort(); } catch (_) { }
    }

    // ---------- ciclo de reconhecimento ----------

    function novoReconhecimento(g) {
      const r = opcoes.criarReconhecimento();
      r.continuous = true;
      r.interimResults = true;
      r.lang = cfg.lang;
      r.onresult = (ev) => aoResultado(g, ev);
      r.onerror = (ev) => aoErro(g, ev);
      r.onend = () => aoFim(g);
      return r;
    }

    function iniciarCiclo(g, tentativa) {
      if (g !== geracao || !gravando || !reco) return;

      cicloInicio = agora();
      cicloTeveResultado = false;
      cicloErro = null;

      try {
        reco.start();
        cicloAtivo = true;
        emitirStatus('ouvindo');
      } catch (e) {
        // Normalmente o Chrome ainda encerrando a sessão anterior (InvalidStateError).
        if (tentativa === 0) {
          agendarTimer(() => iniciarCiclo(g, 1), cfg.retryStartMs);
        } else {
          log('start() falhou duas vezes: ' + (e && e.message));
          registrarFalhaEReiniciar(g, 'desconhecido');
        }
      }
    }

    function aoResultado(g, ev) {
      if (g !== geracao || (!gravando && !parando)) return;
      cicloTeveResultado = true;
      falhas = 0;

      let parcial = '';
      for (let i = ev.resultIndex; i < ev.results.length; ++i) {
        const texto = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) {
          const limpo = texto.trim();
          if (limpo) acumulado += limpo + ' ';
        } else {
          parcial += texto;
        }
      }
      interino = parcial;
      emitirTexto();
    }

    function aoErro(g, ev) {
      if (g !== geracao) return;
      const codigo = (ev && ev.error) || 'unknown';
      cicloErro = codigo;
      log('erro do reconhecedor: ' + codigo);

      if (TRANSITORIOS.has(codigo)) return;

      if (codigo === 'not-allowed') return bloquear('permissao_negada');
      if (codigo === 'audio-capture') return bloquear('microfone');

      if (codigo === 'service-not-allowed' || codigo === 'language-not-supported') {
        return bloquear('servico_indisponivel');
      }
      // network e demais: contados como ciclo falho no onend.
    }

    function aoFim(g) {
      if (g !== geracao) return;
      cicloAtivo = false;

      if (parando) return finalizarParada();
      if (!gravando) return;

      if (!contextoValido()) {
        // Script órfão (extensão recarregada): não reiniciar.
        log('contexto da extensão invalidado; encerrando o motor');
        return encerrarSessao();
      }

      const duracao = agora() - cicloInicio;
      const falhou =
        (cicloErro !== null && !TRANSITORIOS.has(cicloErro)) ||
        (cicloErro === null && !cicloTeveResultado && duracao < cfg.cicloMinimoMs);

      if (falhou) {
        registrarFalhaEReiniciar(g, cicloErro === 'network' ? 'rede' : 'desconhecido');
      } else {
        iniciarCiclo(g, 0); // S8: no mesmo tick do onend
      }
    }

    function registrarFalhaEReiniciar(g, motivo) {
      falhas++;
      if (falhas >= cfg.maxCiclosFalhos) return bloquear(motivo);
      const atraso = cfg.backoffMs[Math.min(falhas - 1, cfg.backoffMs.length - 1)];
      agendarTimer(() => iniciarCiclo(g, 0), atraso);
    }

    // Erro bloqueante: para de reiniciar, mantém o texto acumulado.
    function bloquear(motivo) {
      gravando = false;
      limparTimers();
      descartarReconhecimento();
      emitirStatus('erro', motivo);
    }

    function encerrarSessao() {
      gravando = false;
      limparTimers();
      descartarReconhecimento();
    }

    function finalizarParada() {
      const pendente = paradaPendente;
      parando = false;
      paradaPendente = null;
      limparTimers();
      const transcricao = (acumulado + interino).trim();
      geracao++; // eventos tardios dessa sessão são descartados (S18)
      descartarReconhecimento();
      emitirStatus('parado');
      if (pendente) pendente.resolver({ transcript: transcricao });
    }

    // ---------- API pública ----------

    function iniciar() {
      const g = ++geracao;
      limparTimers();
      descartarReconhecimento();
      if (paradaPendente) { paradaPendente.resolver({ transcript: '' }); paradaPendente = null; }
      parando = false;
      acumulado = '';
      interino = '';
      falhas = 0;
      ultimoStatus = null;

      if (!opcoes.criarReconhecimento) {
        emitirStatus('erro', 'nao_suportado');
        return;
      }
      gravando = true;
      reco = novoReconhecimento(g);
      iniciarCiclo(g, 0);
    }

    // S15: stop() gracioso; resolve com o texto final + interino pendente.
    function parar() {
      if (paradaPendente) return paradaPendente.promessa;

      if (!gravando && !parando) {
        return Promise.resolve({ transcript: (acumulado + interino).trim() });
      }

      let resolver;
      const promessa = new Promise((r) => { resolver = r; });
      paradaPendente = { promessa, resolver };
      gravando = false;
      parando = true;

      if (!cicloAtivo || !reco) {
        finalizarParada();
      } else {
        try { reco.stop(); } catch (_) { }
        agendarTimer(finalizarParada, cfg.esperaStopMs);
      }
      return promessa;
    }

    // S16: descarta tudo imediatamente.
    function cancelarGravacao() {
      geracao++;
      gravando = false;
      parando = false;
      limparTimers();
      descartarReconhecimento();
      acumulado = '';
      interino = '';
      if (paradaPendente) { paradaPendente.resolver({ transcript: '' }); paradaPendente = null; }
      emitirStatus('parado');
    }

    return {
      iniciar,
      parar,
      cancelar: cancelarGravacao,
      dispose: cancelarGravacao, // S14
      obterTranscricao: () => acumulado + interino,
    };
  }

  globalThis.__copilotoStt = { criarMotorStt, PADRAO };
})();
