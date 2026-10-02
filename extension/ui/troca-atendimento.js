// Detecta a troca de card de atendimento a partir dos ids lidos do storage.
//
// Só conta como troca quando existem dois ids válidos e diferentes. Um id
// ausente (null/undefined/"") é tratado como leitura transitória, por exemplo o
// content script lendo o sessionStorage enquanto o React re-renderiza, e NÃO
// reinicia nada: senão um "pisca" do id apagaria uma gravação em andamento.
// O último id válido fica guardado, então A -> (vazio) -> B continua sendo troca
// e A -> (vazio) -> A não é.
export function criarDetectorDeTroca() {
  let idAtual = null;

  // `idAnterior` (oldValue do storage) só serve para inicializar o estado na
  // primeira chamada, quando o painel ainda não viu nenhum id.
  return function atendimentoMudou(idAnterior, idNovo) {
    if (idAtual === null && idAnterior) idAtual = idAnterior;
    if (!idNovo) return false;

    const mudou = idAtual !== null && idAtual !== idNovo;
    idAtual = idNovo;
    return mudou;
  };
}
