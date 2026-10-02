import type { JSX } from "react";
import type { DestinationPageData } from "../page-data.js";
import type { FooterInfo } from "./shared.js";
import { PageHeader, PhotoCaption, PhotoWithCaption, ProposalFooter, QuoteBlock, RichParagraph } from "./shared.js";

function HotelPanel({ hotel }: { hotel: NonNullable<DestinationPageData["hotel"]> }): JSX.Element {
  if (hotel.pending) {
    return (
      <div className="tp-hotel-pending">
        <p className="tp-hotel-panel__eyebrow">{hotel.eyebrow}</p>
        <h3 className="tp-hotel-panel__name">{hotel.name}</h3>
        {hotel.meta ? <p className="tp-hotel-panel__meta">{hotel.meta}</p> : null}
        {hotel.text ? <p className="tp-hotel-panel__text">{hotel.text}</p> : null}
      </div>
    );
  }
  return (
    <div className={hotel.photo?.src ? "tp-hotel-panel" : "tp-hotel-panel tp-hotel-panel--text"}>
      {hotel.photo?.src ? <PhotoWithCaption photo={hotel.photo} className="tp-hotel-panel__photo" /> : null}
      <div className="tp-hotel-panel__body">
        <p className="tp-hotel-panel__eyebrow">{hotel.eyebrow}</p>
        <h3 className="tp-hotel-panel__name">{hotel.name}</h3>
        {hotel.meta ? <p className="tp-hotel-panel__meta">{hotel.meta}</p> : null}
        {hotel.text ? <p className="tp-hotel-panel__text">{hotel.text}</p> : null}
      </div>
    </div>
  );
}

export function DestinationActPage(props: { data: DestinationPageData; footer: FooterInfo }): JSX.Element {
  const { data, footer } = props;
  const side = data.layout === "side";
  const narrative = (
    <>
      {data.quote ? <QuoteBlock text={data.quote} /> : null}
      {data.body && data.body.length > 0 ? (
        <>
          <p className="tp-label">{data.bodyLabel ?? "A EXPERIÊNCIA"}</p>
          <div className="tp-body-text">
            {data.body.map((paragraph, index) => (
              <RichParagraph key={index} text={paragraph} />
            ))}
          </div>
        </>
      ) : null}
      {data.sandCard ? (
        side ? (
          <div className="tp-dest__block-card">
            <p className="tp-dest__block-label">{data.sandCard.label}</p>
            <p className="tp-dest__block-text">{data.sandCard.items.join(" · ")}</p>
          </div>
        ) : (
          <div className="tp-dest__sand-card">
            <p className="tp-label">{data.sandCard.label}</p>
            <p className="tp-dest__sand-list">{data.sandCard.items.join(" · ")}</p>
          </div>
        )
      ) : null}
    </>
  );
  const crono = data.timeline && data.timeline.rows.length > 0 ? (
    <>
      <p className="tp-label">{data.timeline.label}</p>
      <div className="tp-timeline">
        {data.timeline.rows.map((row, index) => (
          <div key={index} className="tp-day">
            <span className="tp-day__pill">{row.dateLabel}</span>
            <div>
              {row.title ? <h4 className="tp-day__title">{row.title}</h4> : null}
              {row.text ? <p className="tp-day__text">{row.text}</p> : null}
            </div>
          </div>
        ))}
      </div>
    </>
  ) : null;
  return (
    <section className={`tp-page tp-destination${side ? " tp-destination--side" : ""}`} data-page-id={`destination:${data.destinationId}`}>
      <div className="tp-page__inner">
        <PageHeader eyebrow={data.eyebrow} headline={data.headline} subtitle={data.subtitle} />
        {side && data.photo?.src ? (
          <div className="tp-dest__side-grid">
            <div>
              <PhotoWithCaption photo={data.photo} className="tp-dest__photo tp-dest__photo--side" />
              <PhotoCaption text={data.photo.caption} />
            </div>
            <div>{narrative}</div>
          </div>
        ) : (
          <>
            {data.photo?.src ? (
              <div>
                <PhotoWithCaption photo={data.photo} className="tp-dest__photo" />
                <PhotoCaption text={data.photo.caption} />
              </div>
            ) : null}
            <div className="tp-dest__cols">
              <div>{narrative}</div>
              <div>{crono}</div>
            </div>
          </>
        )}
        {side && data.timeline && data.timeline.rows.length > 0 ? (
          <div className="tp-day-chips">
            {data.timeline.rows.map((row, index) => (
              <div key={index} className="tp-day-chip">
                <span className="tp-day-chip__date">{row.dateLabel}</span>
                {row.title ? <span className="tp-day-chip__label">{row.title}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
        {data.hotel ? <HotelPanel hotel={data.hotel} /> : null}
        {data.experiences ? (
          <>
            <div className="tp-exp-note">
              <p className="tp-label">{data.experiences.noteTitle}</p>
              <p className="tp-muted-note">{data.experiences.noteText}</p>
            </div>
            <div className="tp-exp-grid">
              {data.experiences.cards.map((card) => (
                <article key={card.id} className="tp-exp-card">
                  <h4 className="tp-exp-card__title">{card.title}</h4>
                  {card.text ? <p className="tp-exp-card__text">{card.text}</p> : null}
                </article>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <ProposalFooter footer={footer} />
    </section>
  );
}
