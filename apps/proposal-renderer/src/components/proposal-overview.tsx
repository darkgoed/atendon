import type { JSX } from "react";
import type { OverviewPageData } from "../page-data.js";
import type { FooterInfo } from "./shared.js";
import { PageHeader, PhotoCaption, PhotoWithCaption, ProposalFooter } from "./shared.js";

export function ProposalOverview(props: { data: OverviewPageData; footer: FooterInfo }): JSX.Element {
  const { data, footer } = props;
  return (
    <section className="tp-page tp-overview" data-page-id="overview">
      <div className="tp-page__inner">
        <PageHeader eyebrow={data.eyebrow} headline={data.headline} subtitle={data.subtitle} />
        <div className="tp-overview__grid">
          {data.destinations.map((dest) => (
            <article key={dest.id} className="tp-dest-card">
              <PhotoWithCaption photo={dest.photo} className="tp-dest-card__photo" />
              <div className="tp-dest-card__body">
                <p className="tp-dest-card__range">{dest.rangeLabel}</p>
                <h3 className="tp-dest-card__name">{dest.name}</h3>
                {dest.text ? <p className="tp-dest-card__text">{dest.text}</p> : null}
              </div>
            </article>
          ))}
        </div>
        <div className="tp-route-bar">
          <div className="tp-route-bar__row">
            {data.route.cities.map((city, index) => (
              <span key={index} style={{ display: "contents" }}>
                {index > 0 ? <span className="tp-route-bar__link" /> : null}
                <span className="tp-route-bar__city">{city}</span>
              </span>
            ))}
          </div>
          {data.route.transportNote ? <p className="tp-route-bar__note">{data.route.transportNote}</p> : null}
        </div>
        <PhotoCaption text={data.destinations[0]?.photo?.caption} />
      </div>
      <ProposalFooter footer={footer} />
    </section>
  );
}
