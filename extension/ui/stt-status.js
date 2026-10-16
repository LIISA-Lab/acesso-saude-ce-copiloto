// Traduz o SCRIBE_STATUS do motor de transcrição (stt_engine.js) para o que o
// painel mostra. `modo` alimenta o indicador Local/Nuvem; `erro: true` pede
// destaque e o aviso de que o texto já transcrito continua disponível.
const MOTIVOS = {
  permissao_negada: "Permita o uso do microfone para este site e grave novamente.",
  microfone: "Não foi possível acessar o microfone. Verifique se ele está conectado e liberado.",
  rede: "Sem conexão com o serviço de voz. Verifique a internet.",
  servico_indisponivel: "O serviço de reconhecimento de voz está indisponível neste navegador. Use o Google Chrome.",
  nao_suportado: "Este navegador não suporta reconhecimento de voz. Use o Google Chrome.",
};

export function descreverStatusStt(status, motivo) {
  switch (status) {
    case 'ouvindo_local': return { modo: 'Local', erro: false, texto: null };
    case 'ouvindo_nuvem': return { modo: 'Nuvem', erro: false, texto: null };
    case 'erro': {
      const base = MOTIVOS[motivo] || "A transcrição foi interrompida.";
      return { modo: null, erro: true, texto: `${base} O que já foi transcrito foi mantido; clique em parar para usá-lo.` };
    }
    default: return { modo: null, erro: false, texto: null };
  }
}
