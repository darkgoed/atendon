import type { JSX } from "react";
import type { CoverPageData } from "../page-data.js";
import { PhotoWithCaption, StatCell } from "./shared.js";

export function ProposalCover({ data }: { data: CoverPageData }): JSX.Element {
  // A origem já aparece na linha de embarque; repetir abaixo do título polui a capa.
  const showOrigin = Boolean(data.origin) && !data.dateLine.note;
  return (
    <section className={data.photo?.src ? `tp-page tp-cover tp-cover--${data.coverStyle ?? "classic"}` : "tp-page tp-cover tp-cover--text"} data-page-id="cover">
      {data.photo?.src ? (
        <div className="tp-cover__photo">
          <PhotoWithCaption photo={data.photo} />
        </div>
      ) : null}
      <div className="tp-cover__block">
        <p className="tp-cover__eyebrow">PROPOSTA DE VIAGEM</p>
        <h1 className="tp-cover__title">{data.tripTitle}</h1>
        {showOrigin ? <p className="tp-cover__origin">{data.origin?.toUpperCase()}</p> : null}
        {data.names ? <p className="tp-cover__names">{data.names}</p> : null}
        <div className="tp-cover__stats">
          {data.stats.map((stat) => (
            <StatCell key={stat.label} value={stat.value} label={stat.label} />
          ))}
        </div>
        <p className="tp-cover__dates">
          <strong>{data.dateLine.strong}</strong>
          {data.dateLine.note ? <span> {data.dateLine.note}</span> : null}
        </p>
      </div>
    </section>
  );
}
