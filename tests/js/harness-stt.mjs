// Harness compartilhado: roda stt_engine.js + content_script.js REAIS num contexto vm
// com chrome/SpeechRecognition falsos, relógio e timers controlados pelo teste.
// CONTENT_SCRIPT=<caminho> permite rodar contra outra versão do content script.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.join(aqui, '../../extension/scripts');
const arquivoContentScript = process.env.CONTENT_SCRIPT || path.join(raiz, 'content_script.js');
const arquivoMotor = path.join(raiz, 'stt_engine.js');
const codigoContentScript = fs.readFileSync(arquivoContentScript, 'utf8');
const codigoMotor = fs.readFileSync(arquivoMotor, 'utf8');

const liberarMicrotasks = () => new Promise((r) => setImmediate(r));

// Promessa que o teste resolve à mão
export function adiada() {
  let resolver;
  const promessa = new Promise((r) => { resolver = r; });
  return { promessa, resolver };
}

// opcoes:
//   suportado   (true)   expõe webkitSpeechRecognition
export function carregar(opcoes = {}) {
  const { suportado = true } = opcoes;

  const enviadas = [];
  const logs = [];
  const instancias = [];
  const chamadas = { start: 0, stop: 0, abort: 0 };
  const config = { falhasDeStart: 0 };
  let ouvinte = null;
  const ouvintesPagina = {};

  // --- relógio e timers falsos ---
  let relogio = 1_000_000;
  let proximoId = 1;
  let fila = [];
  const setTimeoutFalso = (fn, ms = 0) => {
    const id = proximoId++;
    fila.push({ id, em: relogio + ms, fn });
    return id;
  };
  const clearTimeoutFalso = (id) => { fila = fila.filter((t) => t.id !== id); };
  class DataFalsa extends Date { static now() { return relogio; } }

  class FakeRecognition {
    constructor() { instancias.push(this); }
    start() {
      chamadas.start++;
      if (config.falhasDeStart > 0) {
        config.falhasDeStart--;
        throw new Error('InvalidStateError');
      }
    }
    stop() { chamadas.stop++; }
    abort() { chamadas.abort++; }
  }
  const chrome = {
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set() {},
      },
    },
    runtime: {
      id: 'extensao-teste',
      onMessage: { addListener: (fn) => { ouvinte = fn; } },
      sendMessage: (msg) => { enviadas.push(msg); return Promise.resolve(); },
    },
  };

  const contexto = {
    console: { log: (...a) => logs.push(a.join(' ')), warn() {}, error() {} },
    setTimeout: setTimeoutFalso,
    clearTimeout: clearTimeoutFalso,
    clearInterval,
    setInterval: () => 0, // sem polling de contexto nos testes
    Date: DataFalsa,
    sessionStorage: { getItem: () => null },
    document: { addEventListener() {} },
    addEventListener: (nome, fn) => { ouvintesPagina[nome] = fn; },
    chrome,
  };
  if (suportado) contexto.webkitSpeechRecognition = FakeRecognition;
  contexto.window = contexto;
  vm.createContext(contexto);
  vm.runInContext(codigoMotor, contexto, { filename: arquivoMotor });
  vm.runInContext(codigoContentScript, contexto, { filename: arquivoContentScript });

  // Envia um comando do painel e devolve a resposta (o STOP responde de forma assíncrona)
  const enviar = (action) => new Promise((resolver) => {
    ouvinte({ action }, {}, resolver);
  });

  // Deixa as promessas pendentes (consulta de disponibilidade etc.) resolverem
  const assentar = async () => { for (let i = 0; i < 5; i++) await liberarMicrotasks(); };

  // Avança relógio e timers falsos, intercalando as microtarefas
  const avancar = async (ms) => {
    const alvo = relogio + ms;
    await assentar();
    for (;;) {
      const devido = fila.filter((t) => t.em <= alvo).sort((a, b) => a.em - b.em || a.id - b.id)[0];
      if (!devido) break;
      fila = fila.filter((t) => t !== devido);
      relogio = Math.max(relogio, devido.em);
      devido.fn();
      await assentar();
    }
    relogio = alvo;
    await assentar();
  };

  const ultima = () => instancias.at(-1);
  const resultado = (texto, isFinal) => Object.assign([{ transcript: texto }], { isFinal });
  const falar = (texto) => ultima().onresult?.({ resultIndex: 0, results: [resultado(texto, true)] });
  const falarInterino = (texto) => ultima().onresult?.({ resultIndex: 0, results: [resultado(texto, false)] });
  const terminar = () => ultima().onend?.();
  const errar = (codigo) => ultima().onerror?.({ error: codigo });

  const textos = () => enviadas.filter((m) => m.action === 'UPDATE_TRANSCRIPT').map((m) => m.text);
  const statuses = () => enviadas.filter((m) => m.action === 'SCRIBE_STATUS');

  return {
    enviar, assentar, avancar, falar, falarInterino, terminar, errar,
    enviadas, logs, instancias, chamadas, config, chrome, contexto, ouvintesPagina,
    ultima, textos, statuses,
    ultimoTexto: () => textos().at(-1),
    ultimoStatus: () => statuses().at(-1),
    // Comando START + espera as promessas pendentes assentarem
    iniciar: async () => { const r = await enviar('START_RECORDING'); await assentar(); return r; },
  };
}
