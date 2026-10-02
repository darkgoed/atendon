import type { JSX } from "react";
import type { CustomSectionPageData, ResolvedSectionBlock } from "../page-data.js";
import { cardColumns } from "../pages.js";
import type { FooterInfo } from "./shared.js";
import { PhotoCaption, PhotoWithCaption, ProposalFooter, RichParagraph } from "./shared.js";

function Block({ block, narrow }: { block: ResolvedSectionBlock; narrow: boolean }): JSX.Element | null {
  switch (block.type) {
    case "paragraph":
      return <div className="tp-sec-paragraph tp-body-text"><RichParagraph text={block.text} /></div>;
    case "bullets": {
      const marker = (index: number): string => block.style === "check" ? "✓" : block.style === "number" ? String(index + 1).padStart(2, "0") : "•";
      return (
        <div className="tp-sec-bullets">
          {block.title ? <p className="tp-label">{block.title}</p> : null}
          <ul className={`tp-sec-list tp-sec-list--${block.style}`}>
            {block.items.map((item, index) => (
              <li key={index}><span className="tp-sec-list__marker">{marker(index)}</span><span>{item}</span></li>
            ))}
          </ul>
        </div>
      );
    }
    case "cards": {
      const columns = cardColumns(block.items.length, block.columns, narrow ? 54 : 96);
      return (
        <div className="tp-sec-cards" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {block.items.map((item, index) => (
            <div key={index} className="tp-sec-card">
              {item.label ? <p className="tp-sec-card__label">{item.label}</p> : null}
              <h3 className="tp-sec-card__title">{item.title}</h3>
              {item.text ? <p className="tp-sec-card__text">{item.text}</p> : null}
            </div>
          ))}
        </div>
      );
    }
    case "table":
      return (
        <div className="tp-sec-table-wrap">
          {block.title ? <p className="tp-label">{block.title}</p> : null}
          <table className="tp-sec-table">
            <thead><tr>{block.columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {block.columns.map((_column, cellIndex) => <td key={cellIndex}>{row[cellIndex] ?? ""}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "highlight":
      return (
        <div className={`tp-sec-highlight tp-sec-highlight--${block.tone}`}>
          {block.label ? <p className="tp-sec-highlight__label">{block.label}</p> : null}
          <p className="tp-sec-highlight__text">{block.text}</p>
        </div>
      );
    case "quote":
      return <blockquote className="tp-quote tp-sec-quote">“{block.text}”</blockquote>;
    case "timeline":
      return (
        <div className="tp-sec-timeline">
          {block.items.map((item, index) => (
            <div key={index} className="tp-sec-timeline__item">
              <span className="tp-sec-timeline__label">{item.label}</span>
              <div>
                <h4 className="tp-sec-timeline__title">{item.title}</h4>
                {item.text ? <p className="tp-sec-timeline__text">{item.text}</p> : null}
              </div>
            </div>
          ))}
        </div>
      );
    case "stats":
      return (
        <div className="tp-sec-stats" style={{ gridTemplateColumns: `repeat(${block.items.length}, minmax(0, 1fr))` }}>
          {block.items.map((item, index) => (
            <div key={index} className="tp-sec-stat">
              <span className="tp-sec-stat__value">{item.value}</span>
              <span className="tp-sec-stat__label">{item.label}</span>
            </div>
          ))}
        </div>
      );
    case "image":
      if (!block.photo.src) return null;
      return (
        <figure className="tp-sec-image">
          <PhotoWithCaption photo={block.photo} />
          <PhotoCaption text={block.caption} />
        </figure>
      );
    default:
      return null;
  }
}

/** Página de seção criada pela IA: cabeçalho da marca + blocos no layout escolhido. */
export function CustomSectionPage(props: { data: CustomSectionPageData; footer: FooterInfo }): JSX.Element {
  const { data, footer } = props;
  const photo = data.photo?.src ? data.photo : undefined;
  const layout = photo ? data.layout : data.layout === "band" ? "band" : "standard";
  const blocks = (
    <div className="tp-sec-blocks">
      {data.blocks.map((block, index) => <Block key={index} block={block} narrow={layout === "split"} />)}
    </div>
  );
  return (
    <section className={`tp-page tp-custom tp-custom--${layout}`} data-page-id={`section:${data.sectionId}`}>
      {layout === "band" && photo ? (
        <div className="tp-custom__band-photo"><PhotoWithCaption photo={photo} /></div>
      ) : null}
      <div className="tp-page__inner">
        {data.eyebrow ? <p className="tp-eyebrow">{data.eyebrow}</p> : null}
        <h2 className="tp-headline">{data.title}{data.continuation ? <span className="tp-custom__cont"> · continuação</span> : null}</h2>
        {data.intro ? <p className="tp-custom__intro">{data.intro}</p> : null}
        <hr className="tp-rule" />
        {layout === "hero" && photo ? (
          <div className="tp-custom__hero"><PhotoWithCaption photo={photo} /><PhotoCaption text={photo.caption} /></div>
        ) : null}
        {layout === "split" && photo ? (
          <div className="tp-custom__split">
            <div className="tp-custom__split-photo"><PhotoWithCaption photo={photo} /><PhotoCaption text={photo.caption} /></div>
            {blocks}
          </div>
        ) : blocks}
        {(data.stacked ?? []).map((part) => (
          <div key={part.sectionId} className="tp-custom__stacked" data-section-id={part.sectionId}>
            {part.eyebrow ? <p className="tp-eyebrow">{part.eyebrow}</p> : null}
            <h2 className="tp-headline tp-custom__stacked-title">{part.title}</h2>
            {part.intro ? <p className="tp-custom__intro">{part.intro}</p> : null}
            <div className="tp-sec-blocks">
              {part.blocks.map((block, index) => <Block key={index} block={block} narrow={false} />)}
            </div>
          </div>
        ))}
      </div>
      <ProposalFooter footer={footer} />
    </section>
  );
}
