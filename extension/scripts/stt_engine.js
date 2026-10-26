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
    // Sessões longas: o Chrome corta a sessão (observado em ~14 min) ou a deixa muda, sem onend
    // nem onerror. Em vez de esperar o corte no meio da fala, o motor renova a sessão por conta própria.
    rotacaoMs: 10 * 60_000,         // a partir daqui renova na primeira pausa
    rotacaoForcadaMs: 12 * 60_000,  // renova mesmo sem pausa
    pausaMs: 2000,                  // silêncio depois do último resultado que conta como pausa
    surdezMs: 15_000,               // fala detectada sem nenhum resultado: sessão muda
    vigiaMs: 1000,                  // período da vigilância
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
    // Medição da lacuna de reinício (sem conteúdo clínico, só tempos)
    let numeroCiclo = 0;
    let fimDoCicloEm = null;   // quando o onend do ciclo anterior chegou
    let startChamadoEm = null; // quando o start() do ciclo corrente foi aceito
    let ultimoResultadoEm = null; // último onresult do ciclo corrente
    let falaDetectadaEm = null;   // onspeechstart sem resultado desde então
    let renovando = false;        // stop() pedido pela renovação preventiva (o onend reinicia)
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

    // ---------- renovação da sessão (sessões longas) ----------

    // Descarta a sessão (que pode estar muda) e abre uma nova. O que ainda era interino
    // seria perdido pelo abort(), então é guardado antes.
    function renovarForcado(g, motivo) {
      if (g !== geracao || !gravando) return;
      log('renovando a sessão (' + motivo + ') após ' + Math.round((agora() - cicloInicio) / 1000) + ' s');
      if (interino.trim()) {
        acumulado += interino.trim() + ' ';
        interino = '';
        emitirTexto();
      }
      descartarReconhecimento();
      reco = novoReconhecimento(g);
      iniciarCiclo(g, 0);
    }

    // Renovação na pausa: stop() entrega o que falta e o onend reinicia como qualquer outro
    // ciclo. Se o onend não vier, força.
    function renovarNaPausa(g) {
      renovando = true;
      log('renovando a sessão numa pausa (' + Math.round((agora() - cicloInicio) / 1000) + ' s de sessão)');
      try { reco.stop(); } catch (_) { }
      agendarTimer(() => { if (renovando) renovarForcado(g, 'onend não veio após o stop'); }, cfg.esperaStopMs);
    }

    function vigiar(g) {
      agendarTimer(() => {
        if (g !== geracao || !gravando) return;
        if (cicloAtivo && !renovando) {
          const t = agora();
          const idade = t - cicloInicio;
          const aPausa = interino === '' && t - (ultimoResultadoEm ?? cicloInicio) >= cfg.pausaMs;
          if (falaDetectadaEm !== null && t - falaDetectadaEm >= cfg.surdezMs) {
            renovarForcado(g, 'fala detectada sem resultado');
          } else if (idade >= cfg.rotacaoForcadaMs) {
            renovarForcado(g, 'limite preventivo');
          } else if (idade >= cfg.rotacaoMs && aPausa) {
            renovarNaPausa(g);
          }
        }
        vigiar(g);
      }, cfg.vigiaMs);
    }

    // ---------- ciclo de reconhecimento ----------

    function novoReconhecimento(g) {
      const r = opcoes.criarReconhecimento();
      r.continuous = true;
      r.interimResults = true;
      r.lang = cfg.lang;
      r.onresult = (ev) => aoResultado(g, ev);
      r.onerror = (ev) => aoErro(g, ev);
      r.onaudiostart = () => aoAudioIniciado(g);
      r.onspeechstart = () => { if (g === geracao && falaDetectadaEm === null) falaDetectadaEm = agora(); };
      r.onend = () => aoFim(g);
      return r;
    }

    function iniciarCiclo(g, tentativa) {
      if (g !== geracao || !gravando || !reco) return;

      cicloInicio = agora();
      cicloTeveResultado = false;
      cicloErro = null;
      ultimoResultadoEm = null;
      falaDetectadaEm = null;
      renovando = false;

      try {
        reco.start();
        cicloAtivo = true;
        numeroCiclo++;
        startChamadoEm = agora();
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

    // O microfone voltou a capturar. Nos reinícios, mede o intervalo sem captura de áudio:
    // do onend do ciclo anterior até aqui (fala nesse intervalo se perde).
    function aoAudioIniciado(g) {
      if (g !== geracao || fimDoCicloEm === null) return;
      const lacuna = agora() - fimDoCicloEm;
      const abertura = startChamadoEm === null ? 0 : agora() - startChamadoEm;
      fimDoCicloEm = null;
      log('ciclo ' + numeroCiclo + ': microfone voltou ' + lacuna + ' ms após o onend '
        + '(start() -> áudio: ' + abertura + ' ms)');
    }

    function aoResultado(g, ev) {
      if (g !== geracao || (!gravando && !parando)) return;
      cicloTeveResultado = true;
      ultimoResultadoEm = agora();
      falaDetectadaEm = null;
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

      // O Chrome encerrou a sessão (não foi um STOP): o que ainda era interino não será
      // finalizado numa sessão futura e se perderia. Guarda no texto acumulado.
      if (interino.trim()) {
        log('sessão encerrada com ' + interino.trim().length + ' caracteres ainda interinos; guardados no texto');
        acumulado += interino.trim() + ' ';
        interino = '';
        emitirTexto();
      }

      const duracao = agora() - cicloInicio;
      fimDoCicloEm = agora();
      log('ciclo ' + numeroCiclo + ' terminou após ' + Math.round(duracao / 1000) + ' s'
        + ' (erro: ' + (cicloErro || 'nenhum') + ', com fala: ' + (cicloTeveResultado ? 'sim' : 'não') + ')');
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
      vigiar(g);
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
