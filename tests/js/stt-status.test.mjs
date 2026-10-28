import test from 'node:test';
import assert from 'node:assert/strict';
import { descreverStatusStt } from '../../extension/ui/stt-status.js';

test('ouvindo não é erro e não mostra aviso', () => {
  assert.deepEqual(descreverStatusStt('ouvindo'), { erro: false, texto: null });
});

test('erro traz mensagem por motivo e avisa que o texto foi mantido', () => {
  const r = descreverStatusStt('erro', 'permissao_negada');
  assert.equal(r.erro, true);
  assert.match(r.texto, /microfone/i);
  assert.match(r.texto, /mantido/);
});

test('motivo desconhecido cai numa mensagem genérica', () => {
  assert.match(descreverStatusStt('erro', 'xyz').texto, /interrompida/);
});

test('parado limpa o indicador', () => {
  assert.deepEqual(descreverStatusStt('parado'), { erro: false, texto: null });
});
