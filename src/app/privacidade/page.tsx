/**
 * Política de privacidade — página pública.
 *
 * Existe porque o Google exige uma URL de política acessível SEM login para
 * publicar o app OAuth. Também é o que a tela de consentimento mostra a quem
 * for conectar a própria caixa de e-mail, então o texto precisa responder o que
 * essa pessoa realmente quer saber: o que o sistema lê, o que guarda, e como
 * ela corta o acesso.
 *
 * Fica em `/privacidade`, liberada no middleware. Atrás da sessão, o Google
 * receberia o HTML do login e recusaria a publicação.
 */
import { APP_NAME } from '@/lib/branding';

export const metadata = {
  title: 'Política de Privacidade',
  robots: { index: true, follow: true },
};

export default function PrivacidadePage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-12 text-[14px] leading-relaxed text-text-secondary">
      <h1 className="mb-1 text-[22px] font-semibold text-text-primary">Política de Privacidade</h1>
      <p className="mb-8 text-[12px] text-text-muted">
        {APP_NAME} — sistema de atendimento e gestão de contatos
      </p>

      <Secao titulo="Quem somos">
        O {APP_NAME} é um sistema de atendimento usado por empresas para conversar com seus
        clientes por WhatsApp e e-mail e organizar esses atendimentos. Cada empresa contratante
        opera a própria instalação, com os próprios dados, separada das demais.
      </Secao>

      <Secao titulo="Que dados o sistema trata">
        <ul className="ml-4 list-disc space-y-1">
          <li><strong className="text-text-primary">Mensagens e contatos</strong> das conversas de atendimento — texto, mídia, telefone e nome exibido.</li>
          <li><strong className="text-text-primary">Dados da conta de quem usa o sistema</strong> — nome, e-mail e função dentro da empresa.</li>
          <li><strong className="text-text-primary">E-mails</strong>, quando o usuário conecta voluntariamente uma conta do Google.</li>
        </ul>
      </Secao>

      <Secao titulo="Conexão com a sua conta do Google">
        <p className="mb-3">
          A conexão é opcional e feita por você, pelo login do Google. O sistema{' '}
          <strong className="text-text-primary">nunca recebe nem armazena a sua senha</strong>.
        </p>
        <p className="mb-3">Pedimos apenas três permissões, e para os seguintes usos:</p>
        <ul className="ml-4 list-disc space-y-1">
          <li><code className="text-text-primary">gmail.send</code> — enviar e-mails que você escreve dentro do sistema, com o seu endereço como remetente.</li>
          <li><code className="text-text-primary">gmail.readonly</code> — ler as respostas dos seus contatos, para que apareçam junto do atendimento.</li>
          <li><code className="text-text-primary">userinfo.email</code> — identificar qual endereço foi conectado.</li>
        </ul>
        <p className="mt-3">
          Não pedimos permissão para apagar e-mails, e o sistema não apaga nada da sua caixa.
          O token de acesso é guardado criptografado e usado somente para as ações acima.
        </p>
        <p className="mt-3">
          O uso de dados recebidos das APIs do Google segue a{' '}
          <a href="https://developers.google.com/terms/api-services-user-data-policy"
            className="underline" target="_blank" rel="noreferrer">
            Política de Dados do Usuário dos Serviços de API do Google
          </a>, incluindo os requisitos de Uso Limitado.
        </p>
      </Secao>

      <Secao titulo="Com quem os dados são compartilhados">
        Não vendemos e não cedemos dados a terceiros para publicidade. Os dados ficam
        acessíveis apenas à empresa contratante e à sua equipe de atendimento, e a provedores
        de infraestrutura necessários para o serviço funcionar (hospedagem e banco de dados).
      </Secao>

      <Secao titulo="Como revogar o acesso">
        <p className="mb-2">A qualquer momento, por duas vias independentes:</p>
        <ul className="ml-4 list-disc space-y-1">
          <li>Dentro do sistema, em <strong className="text-text-primary">Configurações → E-mail → desconectar</strong>, o que apaga o token do nosso banco.</li>
          <li>
            Na sua conta Google, em{' '}
            <a href="https://myaccount.google.com/permissions" className="underline" target="_blank" rel="noreferrer">
              myaccount.google.com/permissions
            </a>, o que corta o acesso do lado do Google.
          </li>
        </ul>
      </Secao>

      <Secao titulo="Retenção e exclusão">
        Os dados são mantidos enquanto durar a relação com a empresa contratante. Titulares de
        dados podem solicitar acesso, correção ou exclusão pelos canais da empresa que opera a
        instalação, conforme a Lei Geral de Proteção de Dados (LGPD).
      </Secao>

      <Secao titulo="Contato">
        Dúvidas sobre esta política ou sobre seus dados devem ser dirigidas à empresa que opera
        esta instalação do {APP_NAME}, pelo canal de atendimento por onde você foi contatado.
      </Secao>

      <p className="mt-10 text-[12px] text-text-muted">
        Ao usar o sistema ou conectar uma conta, você concorda com esta política.
      </p>
    </main>
  );
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="mb-2 text-[15px] font-semibold text-text-primary">{titulo}</h2>
      <div>{children}</div>
    </section>
  );
}
