use crate::domain::patient::Historico;
use regex::Regex;

pub struct Sanitizer;

impl Sanitizer {
    /// Sanitiza o histórico removendo ou ofuscando dados sensíveis (PII)
    pub fn sanitizar_historico(historico: &mut Historico) {
        // Ofuscar CPF (mantém apenas últimos 2 dígitos para conferência)
        historico.paciente.cpf = Self::ofuscar_cpf(&historico.paciente.cpf);

        // Ocultar nome completo (manter apenas primeiro nome)
        historico.paciente.nome = Self::extrair_primeiro_nome(&historico.paciente.nome);

        // Pode-se expandir para buscar e ofuscar nomes de terceiros nas condutas usando Regex, etc.
        let rgx_nome =
            Regex::new(r"Acompanhante: ([A-Z][a-z]+(?: [a-z]+)?(?: [A-Z][a-z]+)+)").unwrap();
        for atendimento in &mut historico.atendimentos {
            atendimento.conduta_medica = rgx_nome
                .replace_all(&atendimento.conduta_medica, "Acompanhante: [REMOVIDO]")
                .to_string();
            atendimento.anamnese = rgx_nome
                .replace_all(&atendimento.anamnese, "Acompanhante: [REMOVIDO]")
                .to_string();
        }
    }

    fn ofuscar_cpf(cpf: &str) -> String {
        let cpf_numeros: String = cpf.chars().filter(|c| c.is_ascii_digit()).collect();
        if cpf_numeros.len() == 11 {
            format!("***.***.***-{}", &cpf_numeros[9..11])
        } else {
            "[CPF_INVALIDO]".to_string()
        }
    }

    fn extrair_primeiro_nome(nome_completo: &str) -> String {
        nome_completo
            .split_whitespace()
            .next()
            .unwrap_or("[NOME_NÃO_INFORMADO]")
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::patient::{Atendimento, Paciente};

    fn setup_historico() -> Historico {
        Historico {
            paciente: Paciente {
                id: "12345".to_string(),
                nome: "João da Silva Sauro".to_string(),
                cpf: "123.456.789-00".to_string(),
                idade: 45,
            },
            atendimentos: vec![Atendimento {
                data_hora: "2026-07-14 - 11:20".to_string(),
                especialidade: "INFECTOLOGIA".to_string(),
                profissional_nome: "Melissa Medeiros".to_string(),
                profissional_crm: Some("7038".to_string()),
                anamnese: "Paciente relata sintomas. Acompanhante: Maria da Silva".to_string(),
                hipotese_diagnostica: "A00.9 - Cólera Não Especificada".to_string(),
                conduta_medica: "Prescrito soro. Acompanhante: Joao de Sousa".to_string(),
                observacoes_adicionais: None,
            }],
            alergias: vec!["Dipirona".to_string()],
        }
    }

    #[test]
    fn test_ofuscar_cpf() {
        assert_eq!(Sanitizer::ofuscar_cpf("123.456.789-00"), "***.***.***-00");
        assert_eq!(Sanitizer::ofuscar_cpf("12345678911"), "***.***.***-11");
        assert_eq!(Sanitizer::ofuscar_cpf("123"), "[CPF_INVALIDO]");
    }

    #[test]
    fn test_extrair_primeiro_nome() {
        assert_eq!(Sanitizer::extrair_primeiro_nome("João da Silva"), "João");
        assert_eq!(Sanitizer::extrair_primeiro_nome("Maria"), "Maria");
    }

    #[test]
    fn test_sanitizar_historico() {
        let mut hist = setup_historico();
        Sanitizer::sanitizar_historico(&mut hist);

        assert_eq!(hist.paciente.nome, "João");
        assert_eq!(hist.paciente.cpf, "***.***.***-00");
        assert!(
            hist.atendimentos[0]
                .anamnese
                .contains("Acompanhante: [REMOVIDO]")
        );
        assert!(
            hist.atendimentos[0]
                .conduta_medica
                .contains("Acompanhante: [REMOVIDO]")
        );
    }
}
