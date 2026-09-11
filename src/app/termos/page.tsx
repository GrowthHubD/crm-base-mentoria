/**
 * Termos de uso — página pública.
 *
 * Mesma razão da política de privacidade: o Google exige a URL acessível sem
 * login para publicar o app OAuth. Fica em `/termos`, liberada no middleware.
 */
import { APP_NAME } from '@/lib/branding';

export const metadata = {
  title: 'Termos de Uso',
  robots: { index: true, follow: true },
};

export default function TermosPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-12 text-[14px] leading-relaxed text-text-secondary">
      <h1 className="mb-1 text-[22px] font-semibold text-text-primary">Termos de Uso</h1>
      <p className="mb-8 text-[12px] text-text-muted">
        {APP_NAME} — sistema de atendimento e gestão de contatos
      </p>

      <Secao titulo="Objeto">
        Estes termos regem o uso do {APP_NAME}, sistema de atendimento que centraliza conversas
        de WhatsApp e e-mail e organiza o acompanhamento comercial. O acesso é concedido pela
        empresa contratante às pessoas da sua equipe.
      </Secao>

      <Secao titulo="Conta e acesso">
        <ul className="ml-4 list-disc space-y-1">
          <li>O acesso é pessoal e intransferível; credenciais não devem ser compartilhadas.</li>
          <li>A empresa contratante é responsável por conceder e revogar acessos da sua equipe.</li>
          <li>Suspeita de uso indevido deve ser comunicada imediatamente ao administrador da instalação.</li>
        </ul>
      </Secao>

      <Secao titulo="Uso aceitável">
        <p className="mb-2">É vedado usar o sistema para:</p>
        <ul className="ml-4 list-disc space-y-1">
          <li>Envio de mensagens não solicitadas em massa (spam) ou qualquer prática que viole os termos do WhatsApp ou do Google.</li>
          <li>Coleta ou tratamento de dados pessoais sem base legal, em desacordo com a LGPD.</li>
          <li>Conteúdo ilícito, fraudulento, discriminatório ou que viole direitos de terceiros.</li>
        </ul>
        <p className="mt-3">
          O uso de canais não oficiais de mensageria está sujeito às regras do provedor
          correspondente, e o bloqueio de um número por essas regras é de responsabilidade de
          quem o opera.
        </p>
      </Secao>

      <Secao titulo="Contas de e-mail conectadas">
        A conexão de uma conta do Google é voluntária e serve para enviar e receber e-mails
        dentro do sistema, com o endereço do próprio usuário. O acesso pode ser revogado a
        qualquer momento, pelo sistema ou pela conta Google, sem prejuízo do restante do serviço.
        Ver a{' '}
        <a href="/privacidade" className="underline">Política de Privacidade</a> para o
        detalhamento das permissões.
      </Secao>

      <Secao titulo="Disponibilidade">
        O serviço é fornecido no estado em que se encontra. Manutenções, indisponibilidades de
        provedores externos (mensageria, e-mail, hospedagem) e interrupções programadas podem
        ocorrer. Não há garantia de disponibilidade ininterrupta.
      </Secao>

      <Secao titulo="Limitação de responsabilidade">
        O {APP_NAME} não responde por perdas decorrentes de uso indevido do sistema, de bloqueio
        de contas por provedores externos, ou de conteúdo enviado pelos usuários. A
        responsabilidade pelo conteúdo das mensagens é de quem as envia.
      </Secao>

      <Secao titulo="Alterações">
        Estes termos podem ser atualizados. Mudanças relevantes são comunicadas à empresa
        contratante, e o uso continuado após a atualização caracteriza concordância.
      </Secao>

      <Secao titulo="Contato">
        Dúvidas devem ser dirigidas à empresa que opera esta instalação do {APP_NAME}.
      </Secao>
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
