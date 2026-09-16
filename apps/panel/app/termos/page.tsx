import Link from "next/link";
import { ArrowLeft, CheckCircle } from "@phosphor-icons/react/dist/ssr";
import { BrandMark } from "@/components/brand-mark";
import { PRIVACY_POLICY_CONFIG } from "../privacidade/config";

const sections = [
  {
    id: "aceitacao",
    eyebrow: "01 · Aceitação",
    title: "Aceitação destes termos",
    body: [
      "Estes termos regulam o uso do AtendON, plataforma de atendimento e operação que permite a empresas centralizar e responder conversas, inclusive por WhatsApp e Instagram Direct, e organizar atendimento, agenda e informações relacionadas.",
      "Ao criar uma conta, acessar o painel ou usar qualquer funcionalidade do AtendON, a empresa e a pessoa que a representa declaram ter lido, compreendido e aceitado estes termos. Quem aceita em nome de uma empresa declara ter poderes para vinculá-la."
    ]
  },
  {
    id: "servico",
    eyebrow: "02 · Serviço",
    title: "O que o AtendON oferece",
    body: [
      "O AtendON opera um painel e uma infraestrutura de mensageria que conecta canais de atendimento da empresa (como WhatsApp e Instagram Direct) a uma central única, com recursos de organização de conversas, agenda, automações e apoio de inteligência artificial conforme o plano contratado.",
      "O serviço pode ser alterado, ampliado ou descontinuado, no todo ou em parte, para manter segurança, conformidade ou viabilidade operacional, com aviso razoável quando a mudança afetar materialmente o uso já contratado."
    ]
  },
  {
    id: "conta",
    eyebrow: "03 · Conta",
    title: "Conta, acesso e responsabilidades",
    body: [
      "A empresa é responsável por manter suas credenciais e as de sua equipe em sigilo, por configurar corretamente permissões de acesso e por toda atividade realizada na conta, inclusive por usuários que ela convidar ou autorizar.",
      "A empresa deve informar dados de cadastro verdadeiros e mantê-los atualizados, e deve notificar o AtendON em caso de uso não autorizado ou suspeita de comprometimento de credenciais."
    ]
  },
  {
    id: "uso-aceitavel",
    eyebrow: "04 · Uso aceitável",
    title: "Uso aceitável da plataforma",
    body: [
      "É proibido usar o AtendON para enviar mensagens não solicitadas em violação a normas aplicáveis ou às políticas dos canais integrados (incluindo as regras da Meta para WhatsApp e Instagram), para fins ilícitos, para assediar, enganar ou explorar terceiros, para transmitir malware, para contornar limites técnicos do serviço ou para tratar dados de terceiros sem base legal adequada.",
      "O AtendON pode suspender ou encerrar contas que violem este uso aceitável, priorizando, quando possível, aviso prévio e oportunidade de regularização, exceto em casos de risco grave, iminente ou de exigência legal."
    ]
  },
  {
    id: "conteudo",
    eyebrow: "05 · Conteúdo",
    title: "Conteúdo e dados inseridos pela empresa",
    body: [
      "A empresa é responsável pelo conteúdo que insere ou transmite pelo AtendON, inclusive mensagens, contatos, anexos e configurações de automação, e declara ter os direitos e a base legal necessários para tratá-los, inclusive quanto a dados pessoais de seus próprios clientes e contatos.",
      "O AtendON trata esses dados como operador, seguindo as instruções contratuais da empresa e a política de privacidade publicada, sem se apropriar do conteúdo além do necessário para prestar e manter o serviço."
    ]
  },
  {
    id: "integracoes",
    eyebrow: "06 · Integrações",
    title: "Integrações com WhatsApp, Instagram e Meta",
    body: [
      "O uso de canais integrados, como WhatsApp e Instagram Direct, depende da disponibilidade, das regras e das políticas vigentes dos respectivos provedores, inclusive da Meta. O AtendON não controla essas políticas e pode precisar ajustar recursos para permanecer em conformidade com elas.",
      "A empresa é responsável por manter suas contas nesses canais em conformidade com os termos desses provedores. Interrupções, limitações ou revogações de acesso impostas pelo provedor do canal não são causadas nem garantidas pelo AtendON."
    ]
  },
  {
    id: "planos",
    eyebrow: "07 · Planos e pagamento",
    title: "Planos, cobrança e cancelamento",
    body: [
      "O acesso a recursos pagos depende de plano contratado, cujas condições comerciais, valores e forma de cobrança são informados no momento da contratação ou em proposta específica. Atrasos ou inadimplência podem levar à suspensão do acesso a recursos pagos, com aviso prévio quando possível.",
      "A empresa pode cancelar sua assinatura conforme as condições informadas na contratação. O cancelamento não gera, por si só, direito à exclusão retroativa de cobranças já vencidas, ressalvadas garantias legais aplicáveis."
    ]
  },
  {
    id: "disponibilidade",
    eyebrow: "08 · Disponibilidade",
    title: "Disponibilidade e limitação de responsabilidade",
    body: [
      "O AtendON busca manter o serviço disponível e funcional, mas não garante operação ininterrupta ou livre de falhas, inclusive por fatores fora de seu controle, como instabilidade de provedores de infraestrutura, canais de mensageria ou serviços de terceiros integrados.",
      "Na máxima medida permitida pela legislação aplicável, o AtendON não responde por danos indiretos, lucros cessantes ou perda de dados decorrentes de uso indevido da plataforma, indisponibilidade de terceiros ou descumprimento destes termos pela empresa usuária, sem prejuízo de responsabilidades que não possam ser limitadas por lei."
    ]
  },
  {
    id: "propriedade",
    eyebrow: "09 · Propriedade intelectual",
    title: "Propriedade intelectual",
    body: [
      "O AtendON, sua marca, código, design e demais elementos de propriedade intelectual pertencem a seu titular e são licenciados à empresa apenas para uso do serviço conforme estes termos, sem transferência de titularidade.",
      "A empresa mantém a titularidade sobre seu próprio conteúdo e dados inseridos na plataforma."
    ]
  },
  {
    id: "rescisao",
    eyebrow: "10 · Rescisão",
    title: "Suspensão e encerramento",
    body: [
      "Qualquer parte pode encerrar o uso do serviço conforme as condições contratuais aplicáveis. O AtendON pode suspender ou encerrar o acesso em caso de violação relevante destes termos, risco de segurança, exigência legal ou inadimplência não regularizada, buscando, quando cabível, aviso prévio.",
      "O encerramento não afeta obrigações já vencidas nem direitos e deveres que, por sua natureza, devam subsistir após o fim do uso do serviço."
    ]
  },
  {
    id: "alteracoes",
    eyebrow: "11 · Alterações",
    title: "Mudanças nestes termos",
    body: [
      "Estes termos podem ser atualizados quando o serviço, a operação ou as exigências aplicáveis mudarem. A versão vigente é publicada nesta página com sua data de atualização. Mudanças relevantes poderão também ser comunicadas pelos canais disponíveis, quando aplicável."
    ]
  },
  {
    id: "lei",
    eyebrow: "12 · Lei aplicável",
    title: "Lei aplicável e foro",
    body: [
      "Estes termos são regidos pela legislação brasileira. Eventuais controvérsias serão submetidas ao foro competente conforme a legislação aplicável, ressalvada a opção por foros de proteção previstos em lei quando cabível."
    ]
  }
] as const;

export default function TermsPage() {
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
            <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">Termos de uso</h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-[var(--text-secondary)]">As condições para usar o AtendON, inclusive quando o atendimento acontece por WhatsApp ou Instagram Direct.</p>
            <p className="mt-5 text-sm text-[var(--text-muted)]">Em vigor desde 16 de setembro de 2026 · Publicado em 16 de setembro de 2026</p>

            <section className="mt-10 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] p-5 sm:p-6" aria-labelledby="responsavel-title">
              <div className="flex gap-4">
                <div>
                  <p className="eyebrow text-[var(--warning-text)]">Responsável pelo serviço</p>
                  <h2 id="responsavel-title" className="mt-2 text-xl font-semibold tracking-tight">Informações do responsável</h2>
                  <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                    <div><dt className="font-medium text-[var(--text-muted)]">Responsável</dt><dd className="mt-1 font-medium">{PRIVACY_POLICY_CONFIG.responsibleName}</dd></div>
                    <div><dt className="font-medium text-[var(--text-muted)]">CNPJ</dt><dd className="mt-1 font-medium">{PRIVACY_POLICY_CONFIG.registration}</dd></div>
                    <div><dt className="font-medium text-[var(--text-muted)]">Localização</dt><dd className="mt-1 font-medium">{PRIVACY_POLICY_CONFIG.location}</dd></div>
                    <div><dt className="font-medium text-[var(--text-muted)]">Canal de contato</dt><dd className="mt-1 font-medium"><a className="underline underline-offset-4" href={`mailto:${PRIVACY_POLICY_CONFIG.contactChannel}`}>{PRIVACY_POLICY_CONFIG.contactChannel}</a></dd></div>
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

              <section id="contato" aria-labelledby="contato-title">
                <p className="eyebrow">13 · Contato</p>
                <h2 id="contato-title" className="mt-2 text-2xl font-semibold tracking-tight">Dúvidas sobre estes termos</h2>
                <p className="mt-4 max-w-3xl text-[15px] leading-7 text-[var(--text-secondary)]">Para dúvidas sobre estes termos, entre em contato pelo canal indicado no bloco acima. Para questões de privacidade e exclusão de dados, consulte a <Link className="font-medium text-[var(--text)] underline underline-offset-4" href="/privacidade">política de privacidade</Link>.</p>
              </section>
            </div>
          </div>

          <aside className="lg:sticky lg:top-6 lg:self-start" aria-label="Nesta página">
            <div className="border-t border-[var(--border)] pt-4">
              <p className="eyebrow">NESTA PÁGINA</p>
              <nav className="mt-4 grid gap-2 text-sm" aria-label="Seções dos termos">
                {[...sections.map(({ id, title }) => ({ id, title })), { id: "contato", title: "Dúvidas sobre estes termos" }].map((item) => <a key={item.id} className="text-[var(--text-secondary)] underline decoration-[var(--border-strong)] underline-offset-4 hover:text-[var(--text)]" href={`#${item.id}`}>{item.title}</a>)}
              </nav>
            </div>
            <div className="mt-8 border-t border-[var(--border)] pt-4 text-sm leading-6 text-[var(--text-muted)]">
              <CheckCircle size={22} className="mb-3 text-[var(--primary-text)]" aria-hidden="true" />
              <p>Integrações de terceiros têm termos próprios. Consulte também as informações apresentadas pela Meta durante a autorização.</p>
            </div>
          </aside>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--border)] pt-5 text-xs text-[var(--text-muted)]">
          <span>AtendON · termos publicados</span>
          <Link className="text-[var(--text-secondary)] underline underline-offset-4" href="/login">Acesso ao painel</Link>
        </footer>
      </div>
    </main>
  );
}
