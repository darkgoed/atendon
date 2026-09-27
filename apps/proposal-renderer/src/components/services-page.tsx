import type { JSX } from "react";
import type { ServicesPageData } from "../page-data.js";
import type { FooterInfo } from "./shared.js";
import { PageHeader, ProposalFooter } from "./shared.js";

const IMPORTANTE_NOTE =
  "IMPORTANTE: hospedagens, voos e traslados estão sujeitos à disponibilidade e serão confirmados no momento da reserva.";

export function ServicesPage(props: { data: ServicesPageData; footer: FooterInfo }): JSX.Element {
  const { data, footer } = props;
  return (
    <section className="tp-page tp-services" data-page-id="services">
      <div className="tp-page__inner">
        <PageHeader eyebrow={data.eyebrow} headline={data.headline} subtitle={data.subtitle} />
        <div className="tp-services__grid">
          <div>
            {data.leftGroups.map((group, index) => (
              <div key={index} className="tp-inclusion-group">
                <p className="tp-label">{group.section}</p>
                <ul className="tp-inclusion-list">
                  {group.items.map((item, itemIndex) => (
                    <li key={itemIndex}>
                      <span className="tp-check">✓</span>
                      <strong>{item.title}</strong>
                      {item.detail ? <span> — {item.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div>
            {data.summary ? (
              <div className="tp-summary-card">
                <p className="tp-summary-card__label">{data.summary.title}</p>
                {data.summary.rows.map((row, index) => (
                  <div key={index} className="tp-summary-row">
                    <span className="tp-summary-row__key">{row.key}</span>
                    <span className="tp-summary-row__value">{row.value}</span>
                  </div>
                ))}
                {data.summary.total ? (
                  <div className="tp-summary-total">
                    <span className="tp-summary-total__key">{data.summary.total.key}</span>
                    <span className="tp-summary-total__value">{data.summary.total.value}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
            {data.rightGroups.map((group, index) => (
              <div key={index} className="tp-inclusion-group" style={{ marginTop: index === 0 ? "5.2mm" : undefined }}>
                <p className="tp-label">{group.section}</p>
                <ul className="tp-inclusion-list">
                  {group.items.map((item, itemIndex) => (
                    <li key={itemIndex}>
                      <span className="tp-check">✓</span>
                      <strong>{item.title}</strong>
                      {item.detail ? <span> — {item.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {data.exclusions.length > 0 ? (
              <div className="tp-inclusion-group tp-exclusion-list" style={{ marginTop: "5.2mm" }}>
                <p className="tp-label">NÃO INCLUÍDO</p>
                <ul className="tp-inclusion-list">
                  {data.exclusions.map((item, index) => (
                    <li key={index}>
                      <span className="tp-check">✕</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="tp-exp-note">
              <p className="tp-label">IMPORTANTE</p>
              <p className="tp-muted-note">
                {data.warnings.length > 0 ? data.warnings.join(" ") : IMPORTANTE_NOTE}
              </p>
            </div>
          </div>
        </div>
      </div>
      <ProposalFooter footer={footer} />
    </section>
  );
}
