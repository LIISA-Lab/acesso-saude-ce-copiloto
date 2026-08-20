use crate::domain::patient::{Historico, ResumoClinico};
use std::collections::HashMap;

pub struct Summarizer;

impl Summarizer {
    pub fn gerar_resumo(historico: &Historico) -> ResumoClinico {
        // Encontrar último diagnóstico e conduta (O mais recente é o index 0 na interface)
        let ultimo_diagnostico = historico
            .atendimentos
            .first()
            .map(|a| a.hipotese_diagnostica.clone());
        let ultima_conduta = historico
            .atendimentos
            .first()
            .map(|a| a.conduta_medica.clone());

        ResumoClinico {
            paciente_idade: historico.paciente.idade,
            paciente_id: historico.paciente.id.clone(),
            alergias: historico.alergias.clone(),
            total_atendimentos: historico.atendimentos.len(),
            ultimo_diagnostico,
            ultima_conduta,
            historico_atendimentos: historico.atendimentos.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::patient::{Atendimento, Paciente};

    #[test]
    fn test_gerar_resumo() {
        let historico = Historico {
            paciente: Paciente {
                id: "123".to_string(),
                nome: "Maria".to_string(),
                cpf: "000".to_string(),
                idade: 60,
            },
            atendimentos: vec![
                Atendimento {
                    data_hora: "2023-01-01 - 09:00".to_string(),
                    especialidade: "CARDIOLOGIA".to_string(),
                    profissional_nome: "Dr. João".to_string(),
                    profissional_crm: Some("1234".to_string()),
                    anamnese: "Paciente com pressão alta".to_string(),
                    hipotese_diagnostica: "Hipertensão".to_string(),
                    conduta_medica: "Orientação dieta".to_string(),
                    observacoes_adicionais: None,
                },
                Atendimento {
                    data_hora: "2023-05-01 - 10:30".to_string(),
                    especialidade: "CARDIOLOGIA".to_string(),
                    profissional_nome: "Dr. João".to_string(),
                    profissional_crm: Some("1234".to_string()),
                    anamnese: "Pressão continua alta".to_string(),
                    hipotese_diagnostica: "Hipertensão".to_string(),
                    conduta_medica: "Ajuste medicação".to_string(),
                    observacoes_adicionais: Some("Losartana".to_string()),
                },
                Atendimento {
                    data_hora: "2023-10-01 - 14:00".to_string(),
                    especialidade: "ORTOPEDIA".to_string(),
                    profissional_nome: "Dra. Maria".to_string(),
                    profissional_crm: Some("5678".to_string()),
                    anamnese: "Dor na perna".to_string(),
                    hipotese_diagnostica: "Dor no joelho".to_string(),
                    conduta_medica: "Encaminhado ortopedia".to_string(),
                    observacoes_adicionais: None,
                },
            ],
            alergias: vec!["AAS".to_string()],
        };

        let resumo = Summarizer::gerar_resumo(&historico);

        assert_eq!(resumo.paciente_idade, 60);
        assert_eq!(resumo.total_atendimentos, 3);
        assert_eq!(resumo.alergias, vec!["AAS".to_string()]);
        assert_eq!(resumo.ultimo_diagnostico.unwrap(), "Hipertensão"); // O primeiro do array no teste
        assert_eq!(resumo.ultima_conduta.unwrap(), "Orientação dieta"); // O primeiro do array no teste
    }
}
