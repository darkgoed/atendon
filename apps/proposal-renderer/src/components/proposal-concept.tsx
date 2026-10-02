import type { JSX } from "react";
import type { ConceptPageData } from "../page-data.js";
import type { FooterInfo } from "./shared.js";
import { PageHeader, PhotoCaption, PhotoWithCaption, ProposalFooter, QuoteBlock, RichParagraph } from "./shared.js";

export function ProposalConcept(props: { data: ConceptPageData; footer: FooterInfo }): JSX.Element {
  const { data, footer } = props;
  return (
    <section className="tp-page tp-concept" data-page-id="concept">
      <div className="tp-page__inner">
        <PageHeader eyebrow={data.eyebrow} headline={data.headline} />
        <div className={data.photo?.src ? "tp-concept__grid" : "tp-concept__grid tp-concept__grid--text"}>
          <div>
            {data.quote ? <QuoteBlock text={data.quote} /> : null}
            <div className="tp-concept__body tp-body-text">
              {data.body.map((paragraph, index) => (
                <RichParagraph key={index} text={paragraph} />
              ))}
            </div>
            {data.moments ? (
              <div className="tp-concept__moments">
                <p className="tp-label">{data.moments.label}</p>
                <p className="tp-concept__moments-list">{data.moments.items.join(" · ")}</p>
              </div>
            ) : null}
          </div>
          {data.photo?.src ? (
            <div>
              <PhotoWithCaption photo={data.photo} className="tp-concept__photo" />
              <PhotoCaption text={data.photo.caption} />
            </div>
          ) : null}
        </div>
        {data.axes.length > 0 ? (
          <div className="tp-concept__axes">
            {data.axes.map((axis, index) => (
              <div key={index} className={`tp-axis-card tp-axis-card--${index % 3}`}>
                <p className="tp-axis-card__label">{axis.label}</p>
                <p className="tp-axis-card__value">{axis.value}</p>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <ProposalFooter footer={footer} />
    </section>
  );
}
