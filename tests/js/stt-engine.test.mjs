// Motor de transcrição (spec: tasks/stt-on-device/spec.md), exercitado pelo
// content_script.js real com SpeechRecognition falso e relógio controlado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { carregar } from './harness-stt.mjs';

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

// ---------- erros bloqueantes (S12) ----------

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
  assert.equal(s.ultimoStatus().status, 'ouvindo');
});

// ---------- STOP e CANCEL (S15, S16, S18) ----------

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

test('START avisa o painel que está ouvindo e CANCEL volta para parado', async () => {
  const s = carregar();
  await s.iniciar();
  assert.equal(s.ultimoStatus().status, 'ouvindo');
  await s.enviar('CANCEL_RECORDING');
  assert.equal(s.ultimoStatus().status, 'parado');
});
