import Link from "next/link";
import { ArrowLeft, CheckCircle, InstagramLogo, ShieldCheck } from "@/components/icons";
import { BrandMark } from "@/components/brand-mark";
import { PRIVACY_POLICY_CONFIG } from "./config";

const sections = [
  {
    id: "escopo",
    eyebrow: "01 · Escopo",
    title: "A quem este aviso se aplica",
    body: [
      "Este aviso descreve, em linguagem direta, como o AtendON pode tratar dados pessoais quando uma pessoa usa o painel ou interage com uma empresa que utiliza o serviço.",
      "O AtendON é uma plataforma de atendimento e operação. A empresa que usa o serviço pode decidir quais dados coleta, para quais finalidades e por quanto tempo os conserva. As informações apresentadas pela empresa em seus próprios avisos de privacidade devem orientar as decisões de tratamento que ela realiza como controladora."
    ]
  },
  {
    id: "dados",
    eyebrow: "02 · Dados",
    title: "Quais dados podem ser tratados",
    body: [
      "Dependendo da configuração e da interação, podem existir dados de cadastro e contato (como nome, telefone, e-mail e identificadores de conta), conteúdo de conversas, anexos, registros de atendimento, dados de agenda e informações técnicas de acesso, segurança e auditoria.",
      "O serviço busca tratar apenas os dados necessários para as finalidades informadas. Dados sensíveis ou informações de terceiros devem ser inseridos somente quando houver necessidade e fundamento adequado para a operação."
    ]
  },
  {
    id: "finalidades",
    eyebrow: "03 · Uso",
    title: "Para que os dados são usados",
    body: [
      "As finalidades possíveis incluem operar o atendimento solicitado, organizar conversas e agenda, permitir que equipes autorizadas acompanhem solicitações, manter a segurança, prevenir abuso, cumprir obrigações aplicáveis e melhorar a confiabilidade do serviço.",
      "Conforme a operação e a finalidade, o tratamento poderá se apoiar, quando aplicável, na execução de contrato ou de procedimentos relacionados, no cumprimento de obrigação legal ou regulatória, no legítimo interesse com medidas de equilíbrio e salvaguardas, ou no consentimento quando exigido. A empresa usuária deve informar as bases e finalidades que orientam suas próprias decisões de controladora."
    ]
  },
  {
    id: "instagram",
    eyebrow: "04 · Instagram Direct",
    title: "Quando a conversa chega pela Meta",
    body: [
      "Se uma empresa conectar uma conta profissional do Instagram ao AtendON, o serviço poderá receber e enviar mensagens diretas em nome dessa conta, além dos identificadores e metadados necessários para manter a conexão e entregar a conversa à equipe autorizada.",
      "A Meta também trata dados sob suas próprias políticas e termos. A pessoa pode revogar a autorização nas configurações da Meta ou interromper a conversa, conforme os recursos disponíveis. Revogar a autorização na Meta não é o mesmo que pedir exclusão dos dados que já chegaram ao AtendON; para isso, siga a seção de exclusão abaixo.",
      "O acesso por Instagram Direct depende da configuração, das permissões e das regras vigentes da Meta."
    ]
  },
  {
    id: "papeis",
    eyebrow: "05 · Papéis",
    title: "Quem decide sobre o tratamento",
    body: [
      "Em regra, a empresa que usa o AtendON define as finalidades e os meios relacionados aos dados dos seus clientes e contatos, podendo atuar como controladora. O AtendON pode operar a plataforma e tratar esses dados em nome dessa empresa, conforme o arranjo contratual aplicável.",
      "O papel de cada parte pode mudar conforme o produto, a operação e a finalidade. Para decisões tomadas pela empresa usuária, consulte também o aviso de privacidade dessa empresa."
    ]
  },
  {
    id: "compartilhamento",
    eyebrow: "06 · Compartilhamento",
    title: "Com quem os dados podem ser compartilhados",
    body: [
      "O acesso pode ser disponibilizado a usuários e administradores autorizados do workspace, a fornecedores que apoiem hospedagem, armazenamento, segurança, comunicação ou manutenção do serviço, à Meta quando a integração com Instagram estiver ativa e a autoridades quando houver obrigação legal.",
      "A categoria de fornecedor, a finalidade e as salvaguardas aplicáveis dependem da operação vigente. Para informações sobre um tratamento ou compartilhamento específico, entre em contato pelo canal indicado neste aviso."
    ]
  },
  {
    id: "seguranca",
    eyebrow: "07 · Segurança",
    title: "Como protegemos as informações",
    body: [
      "O serviço busca aplicar controles técnicos e organizacionais compatíveis com o risco, como controle de acesso, segregação de permissões, registros de auditoria e proteção de credenciais e tokens. Nenhum ambiente é completamente imune a incidentes.",
      "A resposta a incidentes considera a natureza do evento, os riscos envolvidos e as obrigações aplicáveis, inclusive quanto a comunicações necessárias."
    ]
  },
  {
    id: "transferencias",
    eyebrow: "08 · Localização",
    title: "Transferências internacionais",
    body: [
      "Se a infraestrutura ou algum fornecedor estiver fora do Brasil, poderá ocorrer transferência internacional de dados. Nessa hipótese, serão consideradas as exigências e salvaguardas aplicáveis ao tratamento. Para saber mais sobre um caso específico, entre em contato pelo canal de privacidade."
    ]
  },
  {
    id: "retencao",
    eyebrow: "09 · Ciclo de vida",
    title: "Por quanto tempo guardamos os dados",
    body: [
      "Os dados são mantidos enquanto necessários à prestação do serviço, ao cumprimento de obrigações legais, ao exercício regular de direitos, à auditoria e à segurança. A retenção também pode depender do contrato e do tipo de dado.",
      "O sistema não possui uma política geral automatizada de expurgo para conversas, mídias, leads e logs. Portanto, não prometemos um prazo fixo automático. Após um pedido válido, os dados podem ser excluídos ou anonimizados quando cabível, sujeitos às preservações legais, contratuais, de auditoria e de segurança aplicáveis."
    ]
  }
] as const;

const rights = [
  "confirmação da existência de tratamento e acesso aos dados",
  "correção de dados incompletos, inexatos ou desatualizados",
  "anonimização, bloqueio ou eliminação quando cabível",
  "informação sobre compartilhamentos e revisão de decisões automatizadas, quando aplicável"
];

export default function PrivacyPage() {
  return (
    <main className="min-h-dvh bg-[var(--bg)] text-[var(--text)]">
      <div className="mx-auto max-w-6xl px-5 py-6 sm:px-8 sm:py-10">
        <header className="flex items-center justify-between gap-4 border-b border-[var(--border)] pb-5">
          <Link className="flex items-center gap-2 text-[var(--text)] no-underline" href="/" aria-label="AtendON">
            <BrandMark className="h-6 w-7" />
            <span className="text-sm font-semibold tracking-tight">AtendON</span>
          </Link>
          <Link className="hub-link static" href="/login"><ArrowLeft size={16} aria-hidden="true" />Voltar ao login</Link>
        </header>

        <div className="grid gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-16 lg:py-16">
          <div>
            <p className="eyebrow">TRANSPARÊNCIA · ATENDIMENTO</p>
            <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">Política de privacidade</h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-[var(--text-secondary)]">Uma visão clara sobre os dados tratados pelo AtendON, inclusive quando o atendimento acontece pelo Instagram Direct.</p>
            <p className="mt-5 text-sm text-[var(--text-muted)]">Em vigor desde 16 de setembro de 2026 · Publicada em 16 de setembro de 2026</p>

            <section className="mt-10 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] p-5 sm:p-6" aria-labelledby="responsavel-title">
              <div className="flex gap-4">
                <span className="mt-0.5 text-[var(--warning-text)]"><ShieldCheck size={24} aria-hidden="true" /></span>
                <div>
                  <p className="eyebrow text-[var(--warning-text)]">Responsável pelo tratamento</p>
                  <h2 id="responsavel-title" className="mt-2 text-xl font-semibold tracking-tight">Informações do responsável</h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">Dados de identificação e contato para solicitações relacionadas a esta política.</p>
                  <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                    <div><dt className="font-medium text-[var(--text-muted)]">Responsável</dt><dd className="mt-1 font-medium">{PRIVACY_POLICY_CONFIG.responsibleName}</dd></div>
                    <div><dt className="font-medium text-[var(--text-muted)]">CNPJ</dt><dd className="mt-1 font-medium">{PRIVACY_POLICY_CONFIG.registration}</dd></div>
                    <div><dt className="font-medium text-[var(--text-muted)]">Localização</dt><dd className="mt-1 font-medium">{PRIVACY_POLICY_CONFIG.location}</dd></div>
                    <div><dt className="font-medium text-[var(--text-muted)]">Canal para direitos e exclusão</dt><dd className="mt-1 font-medium"><a className="underline underline-offset-4" href={`mailto:${PRIVACY_POLICY_CONFIG.contactChannel}`}>{PRIVACY_POLICY_CONFIG.contactChannel}</a></dd></div>
                  </dl>
                </div>
              </div>
            </section>

            <div className="mt-12 space-y-10">
              {sections.map((section) => (
                <section key={section.id} id={section.id} className="scroll-mt-6 border-b border-[var(--border-subtle)] pb-10" aria-labelledby={`${section.id}-title`}>
                  <p className="eyebrow">{section.eyebrow}</p>
                  <h2 id={`${section.id}-title`} className="mt-2 text-2xl font-semibold tracking-tight">{section.title}</h2>
                  <div className="mt-4 max-w-3xl space-y-4 text-[15px] leading-7 text-[var(--text-secondary)]">{section.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
                </section>
              ))}

              <section id="direitos" className="border-b border-[var(--border-subtle)] pb-10" aria-labelledby="direitos-title">
                <p className="eyebrow">10 · Seus direitos</p>
                <h2 id="direitos-title" className="mt-2 text-2xl font-semibold tracking-tight">Como exercer seus direitos</h2>
                <p className="mt-4 max-w-3xl text-[15px] leading-7 text-[var(--text-secondary)]">Nos termos da legislação aplicável, a pessoa titular pode solicitar, entre outros direitos:</p>
                <ul className="mt-4 grid max-w-3xl gap-3 text-[15px] leading-7 text-[var(--text-secondary)]">{rights.map((right) => <li key={right} className="flex gap-3"><CheckCircle className="mt-1 shrink-0 text-[var(--primary-text)]" size={17} aria-hidden="true" />{right}</li>)}</ul>
                <p className="mt-5 max-w-3xl text-[15px] leading-7 text-[var(--text-secondary)]">O pedido deve ser encaminhado pelo canal oficial indicado no bloco acima. Poderemos solicitar informações necessárias para confirmar a identidade e localizar o tratamento, sem exigir dados além do necessário.</p>
              </section>

              <section id="exclusao" className="border-b border-[var(--border-subtle)] pb-10" aria-labelledby="exclusao-title">
                <p className="eyebrow">11 · Exclusão</p>
                <h2 id="exclusao-title" className="mt-2 text-2xl font-semibold tracking-tight">Como solicitar exclusão</h2>
                <p className="mt-4 max-w-3xl text-[15px] leading-7 text-[var(--text-secondary)]">Para pedir a exclusão de dados relacionados ao AtendON ou à conexão com Instagram, envie um e-mail para <a className="font-medium text-[var(--text)] underline underline-offset-4" href={`mailto:${PRIVACY_POLICY_CONFIG.contactChannel}`}>{PRIVACY_POLICY_CONFIG.contactChannel}</a>, preferencialmente com o assunto <strong>Solicitação de exclusão de dados — AtendON</strong>.</p>
                <p className="mt-4 max-w-3xl text-[15px] leading-7 text-[var(--text-secondary)]">Informe apenas o necessário para localizar a conta ou conversa, como nome da conta, workspace, identificador da conexão ou período aproximado. Podemos pedir confirmação mínima de identidade para evitar exclusões indevidas; não envie senha, token ou dados excessivos. Confirmaremos o recebimento e, quando o pedido for concluído, a medida adotada ou a justificativa para eventual preservação legal, contratual, de auditoria ou de segurança.</p>
              </section>

              <section id="menores" className="border-b border-[var(--border-subtle)] pb-10" aria-labelledby="menores-title">
                <p className="eyebrow">12 · Proteção</p>
                <h2 id="menores-title" className="mt-2 text-2xl font-semibold tracking-tight">Crianças e adolescentes</h2>
                <p className="mt-4 max-w-3xl text-[15px] leading-7 text-[var(--text-secondary)]">O serviço não é direcionado a crianças. Se você entender que dados de uma criança ou adolescente foram tratados de forma inadequada, use o canal do responsável indicado acima e descreva a situação sem enviar dados desnecessários.</p>
              </section>

              <section id="atualizacoes" aria-labelledby="atualizacoes-title">
                <p className="eyebrow">13 · Atualizações</p>
                <h2 id="atualizacoes-title" className="mt-2 text-2xl font-semibold tracking-tight">Mudanças neste aviso</h2>
                <p className="mt-4 max-w-3xl text-[15px] leading-7 text-[var(--text-secondary)]">Este aviso poderá ser atualizado quando o serviço, a integração ou as exigências aplicáveis mudarem. A versão vigente será publicada nesta página com sua data de atualização. Quando necessário, mudanças relevantes também poderão ser comunicadas pelos canais disponíveis.</p>
              </section>
            </div>
          </div>

          <aside className="lg:sticky lg:top-6 lg:self-start" aria-label="Nesta página">
            <div className="border-t border-[var(--border)] pt-4">
              <p className="eyebrow">NESTA PÁGINA</p>
              <nav className="mt-4 grid gap-2 text-sm" aria-label="Seções da política">
                {[...sections.map(({ id, title }) => ({ id, title })), { id: "direitos", title: "Seus direitos" }, { id: "exclusao", title: "Como solicitar exclusão" }, { id: "menores", title: "Crianças e adolescentes" }, { id: "atualizacoes", title: "Mudanças neste aviso" }].map((item) => <a key={item.id} className="text-[var(--text-secondary)] underline decoration-[var(--border-strong)] underline-offset-4 hover:text-[var(--text)]" href={`#${item.id}`}>{item.title}</a>)}
              </nav>
            </div>
            <div className="mt-8 border-t border-[var(--border)] pt-4 text-sm leading-6 text-[var(--text-muted)]">
              <InstagramLogo size={22} className="mb-3 text-[var(--primary-text)]" aria-hidden="true" />
              <p>Integrações de terceiros têm políticas próprias. Consulte também as informações apresentadas pela Meta durante a autorização.</p>
            </div>
          </aside>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--border)] pt-5 text-xs text-[var(--text-muted)]">
          <span>AtendON · política publicada</span>
          <Link className="text-[var(--text-secondary)] underline underline-offset-4" href="/login">Acesso ao painel</Link>
        </footer>
      </div>
    </main>
  );
}
