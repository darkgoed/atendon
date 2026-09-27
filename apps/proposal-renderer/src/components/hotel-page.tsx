import type { JSX } from "react";
import type { HotelPageData } from "../page-data.js";
import type { FooterInfo } from "./shared.js";
import { PageHeader, PhotoCaption, PhotoWithCaption, ProposalFooter } from "./shared.js";

function FactCard(props: { label: string; title: string; text?: string; variant?: "primary" | "info" }): JSX.Element {
  const className = props.variant === "info"
    ? "tp-fact-card tp-fact-card--info"
    : props.variant === "primary"
      ? "tp-fact-card tp-fact-card--primary"
      : "tp-fact-card";
  return (
    <div className={className}>
      <p className="tp-fact-card__label">{props.label}</p>
      <h3 className="tp-fact-card__title">{props.title}</h3>
      {props.text ? <p className="tp-fact-card__text">{props.text}</p> : null}
    </div>
  );
}

export function HotelPage(props: { data: HotelPageData; footer: FooterInfo }): JSX.Element {
  const { data, footer } = props;
  return (
    <section className="tp-page tp-hotel" data-page-id={`hotel:${data.hotelId}`}>
      <div className="tp-page__inner">
        <PageHeader eyebrow={data.eyebrow} headline={data.name} subtitle={data.subtitle} />
        <div className="tp-hotel-page__grid">
          <div>
            <PhotoWithCaption photo={data.photo} className="tp-hotel-page__photo" />
            <PhotoCaption text={data.photo?.caption} />
          </div>
          <div>
            {data.description ? <p className="tp-body-text tp-hotel-page__desc">{data.description}</p> : null}
            {data.roomCard ? (
              <FactCard label={data.roomCard.label} title={data.roomCard.title} text={data.roomCard.text} variant="primary" />
            ) : null}
            {data.cancellationCard ? (
              <FactCard label={data.cancellationCard.label} title={data.cancellationCard.title} text={data.cancellationCard.text} variant="info" />
            ) : null}
          </div>
        </div>
        {data.gallery.length > 0 ? (
          <div className="tp-hotel-gallery">
            {data.gallery.map((photo, index) => (
              <div key={index}>
                <PhotoWithCaption photo={photo} />
                <PhotoCaption text={photo.caption} />
              </div>
            ))}
          </div>
        ) : null}
        {data.creditNote ? <p className="tp-muted-note">{data.creditNote}</p> : null}
      </div>
      <ProposalFooter footer={footer} />
    </section>
  );
}
