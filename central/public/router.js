/**
 * Roteador do acesso central.
 *
 * A ÚNICA função desta página é descobrir de qual cliente a pessoa é e mandá-la
 * para o CRM dele. Ela não confere senha, não fala com banco nenhum e não sabe
 * quem são os usuários de ninguém — o Worker que a serve não tem binding de
 * banco, então isso é garantia estrutural e não promessa.
 *
 * A senha é digitada no domínio do próprio cliente, conferida contra o banco
 * dele, e o cookie de sessão nasce preso àquele endereço. É por isso que o
 * login NÃO acontece aqui: uma sessão emitida em `seudominio.com.br` precisaria de
 * cookie no domínio-pai, e cookie de domínio-pai é enviado pelo navegador a
 * TODOS os subdomínios — ou seja, ao CRM de todos os outros clientes.
 *
 * A lista abaixo é pública por natureza: são os endereços que qualquer um
 * alcança digitando. O que ela NÃO contém é usuário, e é esse o ponto — cliente
 * com 3 ou 300 atendentes não muda nada aqui, porque a regra lê o que vem
 * depois do `@`, que é igual para toda a equipe.
 */

/** Clientes ativos. Uma linha por CLIENTE — nunca por usuário. */
const CLIENTES = {
  // acme: 'acme.seudominio.com.br',
};

/**
 * Quem usa e-mail de provedor em vez do acesso do sistema.
 *
 * `fulano@gmail.com` daria "gmail", que não é cliente. Exceção é uma linha, e
 * a existência dela é o motivo de recomendarmos o formato `@empresa.lidy`.
 */
const EXCECOES = {
  // 'fulano@acme.com.br': 'acme',
};

/**
 * Extrai o cliente do acesso digitado.
 *
 * Aceita as duas formas de propósito: `maria@acme.lidy` (o formato do sistema)
 * e `acme` sozinho, porque quem já sabe o nome da empresa não deveria ser
 * obrigado a lembrar do resto.
 */
function resolverCliente(entrada) {
  const valor = entrada.trim().toLowerCase();
  if (!valor) return null;

  if (EXCECOES[valor]) return EXCECOES[valor];

  // Sem `@`: a pessoa digitou o nome da empresa direto.
  if (!valor.includes('@')) {
    return CLIENTES[valor] ? valor : null;
  }

  const dominio = valor.split('@')[1] ?? '';
  // Primeiro rótulo do domínio: `acme.lidy` e `acme.com.br` dão os dois
  // "acme", o que mantém funcionando quem já foi cadastrado com e-mail real
  // da própria empresa.
  const cliente = dominio.split('.')[0];
  return CLIENTES[cliente] ? cliente : null;
}

const form = document.querySelector('#form');
const campo = document.querySelector('#campo');
const input = document.querySelector('#acesso');
const erro = document.querySelector('#erro');
const rotulo = document.querySelector('#rotulo');

function mostrarErro(msg) {
  campo.classList.toggle('invalid', Boolean(msg));
  erro.textContent = msg;
}

input.addEventListener('input', () => {
  if (campo.classList.contains('invalid')) mostrarErro('');
});

form.addEventListener('submit', event => {
  event.preventDefault();
  const cliente = resolverCliente(input.value);

  if (!cliente) {
    // Mensagem única para "não existe" e "formato errado". Distinguir os dois
    // transformaria esta página num verificador de quais empresas são clientes.
    mostrarErro('Não reconhecemos esse acesso. Confira com quem administra o seu CRM.');
    return;
  }

  rotulo.textContent = 'Redirecionando...';
  form.querySelector('.submit-button').disabled = true;

  // O acesso vai junto só para preencher o campo do outro lado — a senha nunca
  // passa por aqui. Vai na query porque é identificador, não segredo.
  const destino = new URL(`https://${CLIENTES[cliente]}/login`);
  if (input.value.includes('@')) destino.searchParams.set('acesso', input.value.trim());
  window.location.href = destino.toString();
});
