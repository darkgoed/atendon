import type { JSX } from "react";
import type { FlightsPageData } from "../page-data.js";
import type { FooterInfo } from "./shared.js";
import { PageHeader, PhotoCaption, PhotoWithCaption, ProposalFooter } from "./shared.js";

function FlightBanner(props: { title: string; sub?: string }): JSX.Element {
  return (
    <div className="tp-flight-banner">
      <span className="tp-flight-banner__icon">⚠</span>
      <div>
        <p className="tp-flight-banner__title">{props.title}</p>
        {props.sub ? <p className="tp-flight-banner__sub">{props.sub}</p> : null}
      </div>
    </div>
  );
}

export function FlightsPage(props: { data: FlightsPageData; footer: FooterInfo }): JSX.Element {
  const { data, footer } = props;
  return (
    <section className="tp-page tp-flights" data-page-id="flights">
      <div className="tp-page__inner">
        <PageHeader eyebrow={data.eyebrow} headline={data.headline} subtitle={data.subtitle} />
        {data.notice ? <FlightBanner title={data.notice.title} sub={data.notice.sub} /> : null}
        {data.capture ? (
          <div className="tp-flight-capture">
            <PhotoWithCaption photo={data.capture} />
            <PhotoCaption text={data.capture.caption} />
          </div>
        ) : null}
        <table className="tp-flight-table">
          <thead>
            <tr>
              {data.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>
                    {cellIndex === 3 ? (
                      <>
                        {cell.split(" → ").map((leg, legIndex, all) => (
                          <span key={legIndex}>
                            {leg}
                            {legIndex < all.length - 1 ? <span className="tp-arrow"> → </span> : null}
                          </span>
                        ))}
                      </>
                    ) : (
                      cell
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {data.chips.length > 0 ? (
          <div className="tp-flight-chips">
            {data.chips.map((chip, index) => (
              <div key={index} className={`tp-flight-chip tp-flight-chip--${chip.variant}`}>{chip.text}</div>
            ))}
          </div>
        ) : null}
        {data.footnote ? <p className="tp-muted-note">{data.footnote}</p> : null}
      </div>
      <ProposalFooter footer={footer} />
    </section>
  );
}
