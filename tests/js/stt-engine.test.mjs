// Motor de transcrição (spec: tasks/stt-on-device/spec.md), exercitado pelo
// content_script.js real com SpeechRecognition falso e relógio controlado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { carregar, adiada } from './harness-stt.mjs';

const CICLO = 8000; // um ciclo "normal" de silêncio: bem acima do mínimo de 500 ms

// Termina o ciclo corrente como o Chrome faria depois de `ms` de duração
async function fimDeCiclo(s, { erro, ms = CICLO } = {}) {
  await s.avancar(ms);
  if (erro) s.errar(erro);
  s.terminar();
}

// ---------- reinício (S8, S10, S17) ----------

test('onend reinicia no mesmo tick e preserva o texto acumulado (consulta longa)', async () => {
  const s = carregar();
  await s.iniciar();
  s.falar('primeira parte');

  await fimDeCiclo(s, { ms: 14 * 60_000 + 20_000 }); // limite do serviço na nuvem
  assert.equal(s.chamadas.start, 2, 'start() chamado dentro do onend, sem timer');
  assert.equal(s.modosDeStart.at(-1), false, 'continua na nuvem');

  s.falar('segunda parte');
  assert.equal(s.ultimoTexto(), 'primeira parte segunda parte ');
});

test('silêncio longo: 20 ciclos de no-speech reiniciam sem erro e sem perder texto', async () => {
  const s = carregar();
  await s.iniciar();
  s.falar('antes da pausa');

  for (let i = 0; i < 20; i++) await fimDeCiclo(s, { erro: 'no-speech' });

  assert.equal(s.chamadas.start, 21);
  assert.ok(!s.statuses().some((m) => m.status === 'erro'), 'no-speech nunca vira erro');
  s.falar('depois da pausa');
  assert.equal(s.ultimoTexto(), 'antes da pausa depois da pausa ');
});

test('texto interino não entra no acumulado', async () => {
  const s = carregar();
  await s.iniciar();
  s.falarInterino('palavra solta');
  assert.equal(s.ultimoTexto(), 'palavra solta');
  await fimDeCiclo(s);
  s.falar('frase final');
  assert.equal(s.ultimoTexto(), 'frase final ');
});

// ---------- modo inicial (S1, S2, S4, S5) ----------

test('padrão: sem sttModo=auto fica na nuvem e nem consulta o on-device', async () => {
  const s = carregar({ available: 'available', install: async () => true });
  await s.iniciar();
  assert.equal(s.chamadas.available, 0);
  assert.deepEqual([...s.modosDeStart], [false]);
  assert.equal(s.ultimoStatus().status, 'ouvindo_nuvem');
});

for (const [disp, localEsperado, installs] of [
  ['available', true, 0],
  ['downloadable', false, 1],
  ['downloading', false, 1],
  ['unavailable', false, 0],
]) {
  test(`disponibilidade "${disp}" → processLocally=${localEsperado}, install ${installs}x`, async () => {
    const s = carregar({ available: disp, install: () => new Promise(() => { }), preferencia: 'auto' });
    await s.iniciar();
    assert.deepEqual([...s.modosDeStart], [localEsperado]);
    assert.equal(s.chamadas.install, installs);
    assert.equal(s.ultimoStatus().status, localEsperado ? 'ouvindo_local' : 'ouvindo_nuvem');
  });
}

test('install roda no máximo uma vez por página, mesmo com várias gravações', async () => {
  const s = carregar({ available: 'downloading', install: () => new Promise(() => { }), preferencia: 'auto' });
  await s.iniciar();
  s.enviar('CANCEL_RECORDING');
  await s.iniciar();
  assert.equal(s.chamadas.install, 1);
});

test('API de disponibilidade ausente, que lança ou que trava: cai para a nuvem sem exceção', async () => {
  const ausente = carregar({ preferencia: 'auto' });
  await ausente.iniciar();
  assert.deepEqual([...ausente.modosDeStart], [false]);

  const lanca = carregar({ available: () => { throw new Error('boom'); }, preferencia: 'auto' });
  await lanca.iniciar();
  assert.deepEqual([...lanca.modosDeStart], [false]);

  const trava = carregar({ available: () => new Promise(() => { }), preferencia: 'auto' });
  await trava.enviar('START_RECORDING');
  await trava.assentar();
  assert.equal(trava.chamadas.start, 0, 'ainda esperando a consulta');
  await trava.avancar(300);
  assert.deepEqual([...trava.modosDeStart], [false], 'após o timeout, inicia na nuvem');
});

// ---------- hot-swap nuvem → local (S5, S6, S7) ----------

test('baixou o modelo: o próximo onend migra para o local sem perder o texto', async () => {
  const instalacao = adiada();
  const s = carregar({ available: 'downloadable', install: () => instalacao.promessa, preferencia: 'auto' });
  await s.iniciar();
  s.falar('na nuvem');
  assert.deepEqual([...s.modosDeStart], [false]);

  instalacao.resolver(true);
  await s.assentar();
  assert.equal(s.chamadas.start, 1, 'a troca espera o onend: não interrompe a sessão ativa');

  await fimDeCiclo(s);
  assert.deepEqual([...s.modosDeStart], [false, true]);
  assert.equal(s.ultimoStatus().status, 'ouvindo_local');
  s.falar('no local');
  assert.equal(s.ultimoTexto(), 'na nuvem no local ');
});

test('install que nunca resolve: a reconsulta periódica de available() promove o local', async () => {
  let estado = 'downloading';
  const s = carregar({ available: () => Promise.resolve(estado), install: () => new Promise(() => { }), preferencia: 'auto' });
  await s.iniciar();

  await s.avancar(5000);
  await fimDeCiclo(s, { ms: 1 });
  assert.deepEqual([...s.modosDeStart], [false, false], 'ainda baixando');

  estado = 'available';
  await s.avancar(5000);
  await fimDeCiclo(s, { ms: 1 });
  assert.deepEqual([...s.modosDeStart], [false, false, true]);
});

// ---------- downgrade local → nuvem (S11) ----------

test('falha do on-device: volta para a nuvem e não tenta o local de novo na página', async () => {
  const s = carregar({ available: 'available', preferencia: 'auto' });
  await s.iniciar();
  assert.deepEqual([...s.modosDeStart], [true]);

  s.errar('language-not-supported');
  s.terminar(); // sem avançar o relógio: o rebaixamento não conta como ciclo falho
  assert.deepEqual([...s.modosDeStart], [true, false]);
  assert.equal(s.ultimoStatus().status, 'ouvindo_nuvem');

  await fimDeCiclo(s);
  await s.iniciar(); // nova gravação: available continua "available", mas o local está travado
  assert.equal(s.modosDeStart.at(-1), false);
});

// ---------- erros bloqueantes (S11, S12) ----------

for (const [codigo, motivo] of [
  ['not-allowed', 'permissao_negada'],
  ['audio-capture', 'microfone'],
  ['service-not-allowed', 'servico_indisponivel'],
]) {
  test(`${codigo} na nuvem: avisa o painel (${motivo}), para de reiniciar e mantém o texto`, async () => {
    const s = carregar();
    await s.iniciar();
    s.falar('já transcrito');
    s.errar(codigo);
    s.terminar();
    assert.equal(s.chamadas.start, 1);
    assert.equal(s.ultimoStatus().status, 'erro');
    assert.equal(s.ultimoStatus().motivo, motivo);

    const parada = await s.enviar('STOP_RECORDING');
    assert.equal(parada.transcript, 'já transcrito');
  });
}

// ---------- ciclos falhos (S9) ----------

test('5 ciclos falhos seguidos: backoff crescente e depois erro de rede', async () => {
  const s = carregar();
  await s.iniciar();

  for (const [i, espera] of [150, 500, 1000, 2000].entries()) {
    await fimDeCiclo(s, { erro: 'network' });
    assert.equal(s.chamadas.start, i + 1, 'ainda não reiniciou: espera o backoff');
    await s.avancar(espera - 1);
    assert.equal(s.chamadas.start, i + 1);
    await s.avancar(1);
    assert.equal(s.chamadas.start, i + 2);
  }

  await fimDeCiclo(s, { erro: 'network' });
  await s.avancar(10_000);
  assert.equal(s.chamadas.start, 5, 'parou de reiniciar');
  assert.equal(s.ultimoStatus().status, 'erro');
  assert.equal(s.ultimoStatus().motivo, 'rede');
});

test('um resultado entre as falhas zera o contador', async () => {
  const s = carregar();
  await s.iniciar();
  for (let i = 0; i < 3; i++) {
    await fimDeCiclo(s, { erro: 'network' });
    await s.avancar(2000);
  }
  s.falar('voltou');
  for (let i = 0; i < 3; i++) {
    await fimDeCiclo(s, { erro: 'network' });
    await s.avancar(2000);
  }
  assert.ok(!s.statuses().some((m) => m.status === 'erro'));
});

test('ciclo curtíssimo sem resultado e sem erro também conta como falho', async () => {
  const s = carregar();
  await s.iniciar();
  s.terminar(); // acabou na hora, sem erro
  assert.equal(s.chamadas.start, 1, 'reinício adiado pelo backoff');
  await s.avancar(150);
  assert.equal(s.chamadas.start, 2);
});

test('start() lançando: tenta de novo em 150 ms', async () => {
  const s = carregar();
  s.config.falhasDeStart = 1;
  await s.iniciar();
  assert.equal(s.chamadas.start, 1);
  await s.avancar(149);
  assert.equal(s.chamadas.start, 1);
  await s.avancar(1);
  assert.equal(s.chamadas.start, 2);
  assert.equal(s.ultimoStatus().status, 'ouvindo_nuvem');
});

// ---------- corridas, STOP e CANCEL (S3, S15, S16, S18) ----------

test('CANCEL ou STOP durante a consulta de disponibilidade: não chega a iniciar', async () => {
  for (const comando of ['CANCEL_RECORDING', 'STOP_RECORDING']) {
    const consulta = adiada();
    const s = carregar({ available: () => consulta.promessa, preferencia: 'auto' });
    await s.enviar('START_RECORDING');
    await s.assentar();
    await s.enviar(comando);
    consulta.resolver('available');
    await s.assentar();
    assert.equal(s.chamadas.start, 0, comando);
  }
});

test('STOP espera o resultado final e devolve o texto + o interino pendente', async () => {
  const s = carregar();
  await s.iniciar();
  s.falar('primeira frase');
  s.falarInterino('meia fra');

  const parada = s.enviar('STOP_RECORDING');
  assert.equal(s.chamadas.stop, 1, 'stop() (e não abort()) para entregar o resultado final');
  s.falar('segunda frase'); // resultado que o Chrome entrega depois do stop()
  s.terminar();

  const resposta = await parada;
  assert.equal(resposta.status, 'stopped');
  assert.equal(resposta.transcript, 'primeira frase segunda frase');
});

test('STOP sem onend: responde após o tempo limite', async () => {
  const s = carregar();
  await s.iniciar();
  s.falar('texto');
  let resposta;
  s.enviar('STOP_RECORDING').then((r) => { resposta = r; });
  await s.avancar(1499);
  assert.equal(resposta, undefined);
  await s.avancar(1);
  assert.equal(resposta.transcript, 'texto');
});

test('resultado de uma gravação antiga é descartado', async () => {
  const s = carregar();
  await s.iniciar();
  const antigo = s.ultima().onresult;
  await s.iniciar(); // nova gravação cria nova instância
  antigo?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'fantasma' }], { isFinal: true })] });
  assert.equal(s.ultimoTexto(), undefined);
  s.falar('real');
  assert.equal(s.ultimoTexto(), 'real ');
});

// ---------- ambiente ----------

test('extensão recarregada (contexto inválido): não reinicia', async () => {
  const s = carregar();
  await s.iniciar();
  s.chrome.runtime.id = undefined;
  await fimDeCiclo(s);
  assert.equal(s.chamadas.start, 1);
});

test('pagehide libera o reconhecimento', async () => {
  const s = carregar();
  await s.iniciar();
  const abortsAntes = s.chamadas.abort;
  s.ouvintesPagina.pagehide();
  assert.ok(s.chamadas.abort > abortsAntes);
});

test('navegador sem reconhecimento de voz: erro nao_suportado, sem exceção', async () => {
  const s = carregar({ suportado: false });
  await s.iniciar();
  assert.equal(s.ultimoStatus().status, 'erro');
  assert.equal(s.ultimoStatus().motivo, 'nao_suportado');
});

test('START avisa o painel do modo e CANCEL volta para parado', async () => {
  const s = carregar();
  await s.iniciar();
  assert.equal(s.ultimoStatus().status, 'ouvindo_nuvem');
  await s.enviar('CANCEL_RECORDING');
  assert.equal(s.ultimoStatus().status, 'parado');
});
