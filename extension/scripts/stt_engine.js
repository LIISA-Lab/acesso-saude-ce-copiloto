// Motor de transcrição contínua do Escriba AI (spec: tasks/stt-on-device/spec.md).
//
// Envolve o SpeechRecognition do Chrome para: reiniciar sozinho quando o
// reconhecedor encerra (silêncio, limite do serviço), limitar ciclos com falha,
// e (opcionalmente) migrar da nuvem para o reconhecimento on-device quando o
// pacote de idioma ficar disponível. Não conhece o `chrome.*`: tudo que depende
// do ambiente entra por `opcoes`, o que permite testar com fakes.
(function () {
  const TRANSITORIOS = new Set(['no-speech', 'aborted']);

  const PADRAO = {
    lang: 'pt-BR',
    timeoutConsultaMs: 300,     // S2: teto para a consulta de disponibilidade
    retryStartMs: 150,          // S8: start() que lançou (ex.: InvalidStateError)
    backoffMs: [150, 500, 1000, 2000], // S9: entre ciclos falhos consecutivos
    maxCiclosFalhos: 5,         // S9
    cicloMinimoMs: 500,         // S9: ciclo mais curto que isso, sem resultado, é falho
    esperaStopMs: 1500,         // S15: tempo máximo esperando o resultado final após stop()
    pollLocalMs: 5000,          // S6: reconsulta do pacote on-device enquanto baixa
  };

  function criarMotorStt(opcoes) {
    const cfg = Object.assign({}, PADRAO, opcoes.config);
    const Ctor = opcoes.Ctor || null; // SpeechRecognition (classe): tem available()/install()
    const agendar = opcoes.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const cancelar = opcoes.clearTimeout || ((id) => clearTimeout(id));
    const agora = opcoes.now || (() => Date.now());
    const contextoValido = opcoes.contextoValido || (() => true);
    const obterPreferencia = opcoes.obterPreferenciaLocal || (() => Promise.resolve(false));
    const aoTexto = opcoes.aoTexto || (() => {});
    const aoStatus = opcoes.aoStatus || (() => {});
    const log = opcoes.log || (() => {});

    // --- estado da sessão de gravação ---
    let geracao = 0;          // invalida eventos e awaits de sessões antigas
    let gravando = false;     // a sessão quer continuar ouvindo
    let parando = false;      // stop() pedido, aguardando o resultado final
    let reco = null;
    let cicloAtivo = false;   // start() aceito e onend ainda não chegou
    let modo = 'nuvem';       // modo do ciclo corrente: 'nuvem' | 'local'
    let ultimoStatus = null;
    let acumulado = '';
    let interino = '';
    let falhas = 0;
    let cicloInicio = 0;
    let cicloTeveResultado = false;
    let cicloErro = null;
    let rebaixou = false;     // o ciclo terminou por downgrade local -> nuvem (não é falha)
    let paradaPendente = null; // { promessa, resolver }
    const timers = new Set();

    // --- estado que vale pela vida da página ---
    let localBloqueado = false; // S11: o local falhou; não tentar de novo
    let installDisparado = false; // S5
    let localPronto = false;

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

    // ---------- disponibilidade on-device ----------

    function comTimeout(promessa, ms, padrao) {
      return new Promise((resolver) => {
        const id = agendar(() => resolver(padrao), ms);
        Promise.resolve(promessa).then(
          (v) => { cancelar(id); resolver(v); },
          () => { cancelar(id); resolver(padrao); },
        );
      });
    }

    function consultarDisponibilidade() {
      if (!Ctor || typeof Ctor.available !== 'function') return Promise.resolve('unavailable');
      let consulta;
      try {
        consulta = Ctor.available({ langs: [cfg.lang], processLocally: true });
      } catch (_) {
        return Promise.resolve('unavailable');
      }
      return comTimeout(consulta, cfg.timeoutConsultaMs, 'unavailable');
    }

    function marcarLocalPronto() {
      if (localBloqueado || localPronto) return;
      localPronto = true;
      log('modelo on-device pronto; o próximo ciclo usará o modo local');
    }

    // S5/S6: instala em segundo plano e reconsulta periodicamente, porque
    // install() pode nunca resolver (relatado no Brave) com o status preso em "downloading".
    function dispararInstall(g) {
      if (installDisparado) return;
      installDisparado = true;

      if (Ctor && typeof Ctor.install === 'function') {
        try {
          Promise.resolve(Ctor.install({ langs: [cfg.lang], processLocally: true }))
            .then((ok) => { if (ok) marcarLocalPronto(); })
            .catch((e) => log('install() rejeitado: ' + (e && e.message)));
        } catch (e) {
          log('install() lançou: ' + (e && e.message));
        }
      }
      agendarPollLocal(g);
    }

    function agendarPollLocal(g) {
      agendarTimer(async () => {
        if (g !== geracao || !gravando || localPronto || localBloqueado) return;
        const disp = await consultarDisponibilidade();
        if (g !== geracao) return;
        if (disp === 'available') marcarLocalPronto();
        else agendarPollLocal(g);
      }, cfg.pollLocalMs);
    }

    // Decide o modo do primeiro ciclo (S1/S2/S5). Sempre resolve: erro vira "nuvem".
    async function escolherModoInicial(g) {
      localPronto = false;
      const quer = await comTimeout(Promise.resolve().then(obterPreferencia), cfg.timeoutConsultaMs, false);
      if (!quer || localBloqueado) return;
      const disp = await consultarDisponibilidade();
      if (g !== geracao) return;
      if (disp === 'available') localPronto = true;
      else if (disp === 'downloadable' || disp === 'downloading') dispararInstall(g);
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

      const usarLocal = localPronto && !localBloqueado;
      modo = usarLocal ? 'local' : 'nuvem';
      if ('processLocally' in reco) {
        try { reco.processLocally = usarLocal; } catch (_) { }
      }

      cicloInicio = agora();
      cicloTeveResultado = false;
      cicloErro = null;
      rebaixou = false;

      try {
        reco.start();
        cicloAtivo = true;
        emitirStatus(modo === 'local' ? 'ouvindo_local' : 'ouvindo_nuvem');
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
      log('erro do reconhecedor: ' + codigo + ' (modo ' + modo + ')');

      if (TRANSITORIOS.has(codigo)) return;

      if (codigo === 'not-allowed') return bloquear('permissao_negada');
      if (codigo === 'audio-capture') return bloquear('microfone');

      if (codigo === 'service-not-allowed' || codigo === 'language-not-supported') {
        if (modo === 'local') {
          // S11: o on-device falhou; o onend seguinte reinicia na nuvem.
          localPronto = false;
          localBloqueado = true;
          rebaixou = true;
          return;
        }
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
      const falhou = !rebaixou && (
        (cicloErro !== null && !TRANSITORIOS.has(cicloErro)) ||
        (cicloErro === null && !cicloTeveResultado && duracao < cfg.cicloMinimoMs)
      );

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

    async function iniciar() {
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

      await escolherModoInicial(g);
      if (g !== geracao || !gravando) return; // S3: STOP/CANCEL/novo START durante a consulta
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
