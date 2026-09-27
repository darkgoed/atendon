import type { CSSProperties, JSX } from "react";
import type { ClosingPageData } from "../page-data.js";
import { PageHeader, PhotoWithCaption, QuoteBlock } from "./shared.js";

function InvestmentCard({ investment, payment }: { investment: NonNullable<ClosingPageData["investment"]>; payment?: ClosingPageData["payment"] }): JSX.Element {
  return (
    <div className="tp-investment-card">
      <p className="tp-investment-card__label">{investment.label}</p>
      <p className="tp-investment-card__value">{investment.value}</p>
      <hr className="tp-investment-card__divider" />
      <p className="tp-investment-card__sub">{investment.sub}</p>
      {investment.notes.map((note, index) => (
        <p key={index} className="tp-investment-card__note">{note}</p>
      ))}
      {payment ? (
        <div className="tp-payment tp-payment--inside">
          <p className="tp-investment-card__sub tp-payment__title">{payment.title}</p>
          {payment.rows.map((row, index) => (
            <p key={index} className="tp-payment__row">
              <strong>{row.key}</strong>
              <span>{row.value}</span>
            </p>
          ))}
          {payment.summary ? <p className="tp-payment__row"><span>{payment.summary}</span></p> : null}
        </div>
      ) : null}
    </div>
  );
}

function PaymentTerms({ payment }: { payment: NonNullable<ClosingPageData["payment"]> }): JSX.Element {
  return (
    <div className="tp-payment tp-payment--card">
      <p className="tp-payment__title">{payment.title}</p>
      {payment.rows.map((row, index) => (
        <p key={index} className="tp-payment__row">
          <strong>{row.key}</strong>
          <span>{row.value}</span>
        </p>
      ))}
      {payment.summary ? <p className="tp-payment__row"><span>{payment.summary}</span></p> : null}
    </div>
  );
}

export function CommercialClosing({ data }: { data: ClosingPageData }): JSX.Element {
  const innerStyle: CSSProperties | undefined = data.photo || data.bottomPhoto
    ? {
        paddingTop: data.photo ? "56mm" : "18mm",
        paddingBottom: data.bottomPhoto ? "80mm" : undefined
      }
    : undefined;
  return (
    <section className="tp-page tp-closing" data-page-id="closing">
      {data.photo ? (
        <div className="tp-closing__band">
          <PhotoWithCaption photo={data.photo} />
        </div>
      ) : null}
      {data.bottomPhoto ? (
        <div className="tp-closing__band tp-closing__band--bottom">
          <img className="tp-photo" src={data.bottomPhoto.src} alt="" />
        </div>
      ) : null}
      <div className="tp-page__inner" style={innerStyle}>
        <PageHeader eyebrow={data.eyebrow} headline={data.headline} rule={false} />
        <div className="tp-closing__body tp-body-text">
          {data.body.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
        <div className="tp-closing__grid">
          <div>
            {data.investment ? <InvestmentCard investment={data.investment} payment={data.investment ? data.payment : undefined} /> : null}
            {!data.investment && data.payment ? <PaymentTerms payment={data.payment} /> : null}
          </div>
          <div>
            {data.differentials ? (
              <div className="tp-differentials-card">
                <p className="tp-label">{data.differentials.label}</p>
                <ul className="tp-differentials-list">
                  {data.differentials.items.map((item, index) => (
                    <li key={index}>
                      <span className="tp-check">✓</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
        <div className="tp-next-steps">
          {data.steps.map((step) => (
            <div key={step.number} className="tp-step-card">
              <span className="tp-step-card__number">{step.number}</span>
              <h3 className="tp-step-card__title">{step.title}</h3>
              <p className="tp-step-card__text">{step.text}</p>
            </div>
          ))}
        </div>
        {data.cta ? (
          <div className="tp-cta-banner">
            <span className="tp-cta-banner__quote">“{data.cta.quote}”</span>
            {data.cta.target ? <span className="tp-cta-banner__target">{data.cta.target}</span> : null}
          </div>
        ) : null}
        {data.fineprint ? <p className="tp-closing__fineprint">{data.fineprint}</p> : null}
        {data.creditsHtml ? (
          <p className="tp-credits" dangerouslySetInnerHTML={{ __html: data.creditsHtml }} />
        ) : null}
      </div>
    </section>
  );
}

/* QuoteBlock reusado quando o closing precisar de citação fora do banner. */
export { QuoteBlock };
