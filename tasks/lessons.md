# Lições do projeto

## Desempenho percebido também é correção funcional

- Quando o usuário reforçar lentidão, tratar carga do banco, volume de rede e
  quantidade de elementos renderizados como partes do mesmo problema.
- Em telas filtráveis, nunca manter na renderização um payload cuja identidade,
  unidade, conexão ou consulta não corresponda ao escopo atual.
- Cancelamento sozinho não basta. Toda resposta assíncrona também precisa validar
  a chave do escopo e a sequência antes de alterar cache ou estado.
- Em fluxos protegidos de mensagens, aplicar primeiro melhorias no caminho de
  leitura e provar os contratos antes de alterar ingestão, webhook ou identidade.
- A conta Acme usa credencial Cloudflare própria, separada da Growth Hub;
  confirmar o account ID antes de qualquer deploy para evitar publicar no lugar errado.
