import type { JSX } from "react";
import type { ExperiencesPageData } from "../page-data.js";
import type { FooterInfo } from "./shared.js";
import { PageHeader, ProposalFooter } from "./shared.js";

export function ExperiencesPage(props: { data: ExperiencesPageData; footer: FooterInfo }): JSX.Element {
  const { data, footer } = props;
  return (
    <section className="tp-page tp-experiences" data-page-id="experiences">
      <div className="tp-page__inner">
        <PageHeader eyebrow={data.eyebrow} headline={data.headline} />
        <div className="tp-exp-note">
          <p className="tp-label">{data.note.title}</p>
          <p className="tp-muted-note">{data.note.text}</p>
        </div>
        <div className="tp-exp-grid">
          {data.cards.map((card) => (
            <article key={card.id} className="tp-exp-card">
              <h3 className="tp-exp-card__title">{card.title}</h3>
              {card.text ? <p className="tp-exp-card__text">{card.text}</p> : null}
            </article>
          ))}
        </div>
      </div>
      <ProposalFooter footer={footer} />
    </section>
  );
}
