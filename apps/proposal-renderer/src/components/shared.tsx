import type { JSX } from "react";
import type { ResolvedPhoto } from "../page-data.js";

/** Rodapé compartilhado: { tripTitle · names } | { dd MMM — dd MMM }. */
export interface FooterInfo {
  left: string;
  right: string;
}

export function ProposalFooter({ footer }: { footer: FooterInfo }): JSX.Element {
  return (
    <footer className="tp-footer">
      <span>{footer.left}</span>
      <span>{footer.right}</span>
    </footer>
  );
}

export function PageHeader(props: {
  eyebrow: string;
  headline: string;
  subtitle?: string;
  rule?: boolean;
}): JSX.Element {
  return (
    <>
      <p className="tp-eyebrow">{props.eyebrow}</p>
      <h2 className="tp-headline">{props.headline}</h2>
      {props.subtitle ? <p className="tp-subtitle">{props.subtitle}</p> : null}
      {props.rule === false ? null : <hr className="tp-rule" />}
    </>
  );
}

/** Parágrafo com destaques **assim** em negrito (ref. Itália: nomes de lugares). Sem HTML cru. */
export function RichParagraph({ text }: { text: string }): JSX.Element {
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  return <p>{parts.map((part, index) => (index % 2 === 1 ? <strong key={index}>{part}</strong> : part))}</p>;
}

export function QuoteBlock({ text }: { text: string }): JSX.Element {
  const short = text.trim().split(/\s+/).length <= 8;
  if (short) {
    return (
      <blockquote className="tp-quote-banner">
        <span>“{text}”</span>
      </blockquote>
    );
  }
  return <blockquote className="tp-quote">“{text}”</blockquote>;
}

export function PhotoWithCaption(props: {
  photo?: ResolvedPhoto;
  className?: string;
  caption?: boolean;
}): JSX.Element {
  const frameClass = props.className ? `tp-photo-frame ${props.className}` : "tp-photo-frame";
  if (!props.photo || !props.photo.src) {
    return (
      <div className={frameClass}>
        <div className="tp-photo" />
      </div>
    );
  }
  const placement = props.photo.placement;
  const style = placement
    ? {
      objectPosition: `${placement.x}% ${placement.y}%`,
      transform: placement.zoom > 100 ? `scale(${placement.zoom / 100})` : undefined
    }
    : undefined;
  return (
    <div className={frameClass}>
      <img className="tp-photo" src={props.photo.src} alt={props.photo.caption ?? ""} style={style} />
    </div>
  );
}

export function PhotoCaption({ text }: { text?: string }): JSX.Element | null {
  if (!text) return null;
  return <p className="tp-photo-caption">{text}</p>;
}

export function StatCell({ value, label }: { value: string; label: string }): JSX.Element {
  return (
    <div className="tp-stat-cell">
      <div className="tp-stat-cell__value">{value}</div>
      <div className="tp-stat-cell__label">{label}</div>
    </div>
  );
}
