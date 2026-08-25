import type { TripzDocumentAsset, TripzDocumentModel, TripzDocumentPage } from "./view-model.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]!);
}

function imageSource(asset: TripzDocumentAsset): string {
  return `data:${asset.mimeType};base64,${Buffer.from(asset.data).toString("base64")}`;
}

function renderImages(page: TripzDocumentPage): string {
  if (!page.images.length) return "";
  const images = page.images.slice(0, page.kind === "cover" ? 1 : 4).map((asset) =>
    `<figure><img src="${imageSource(asset)}" alt="${escapeHtml(asset.label ?? "Imagem da proposta")}">${asset.label ? `<figcaption>${escapeHtml(asset.label)}</figcaption>` : ""}</figure>`
  ).join("");
  return `<div class="gallery gallery-${Math.min(page.images.length, 4)}">${images}</div>`;
}

function renderPage(page: TripzDocumentPage, index: number, total: number): string {
  const facts = page.facts.length ? `<dl>${page.facts.map((fact) => `<div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd></div>`).join("")}</dl>` : "";
  const paragraphs = page.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
  const bullets = page.bullets.length ? `<ul>${page.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>` : "";
  return `<section class="page page-${page.kind}"><div class="accent"></div><header><span>${escapeHtml(page.eyebrow)}</span><small>${index + 1} / ${total}</small></header><main><p class="eyebrow">${escapeHtml(page.eyebrow)}</p><h1>${escapeHtml(page.title)}</h1>${page.subtitle ? `<h2>${escapeHtml(page.subtitle)}</h2>` : ""}${paragraphs}${facts}${bullets}${renderImages(page)}</main><footer>Documento gerado a partir dos dados revisados da proposta</footer></section>`;
}

export function renderTripzHtml(model: TripzDocumentModel): string {
  const { brand } = model;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escapeHtml(model.title)}</title><style>
@page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;background:#d9dedc;color:${brand.textColor};font-family:Arial,Helvetica,sans-serif}.page{position:relative;width:210mm;min-height:297mm;margin:16px auto;background:${brand.backgroundColor};padding:18mm 17mm 15mm;overflow:hidden;page-break-after:always}.page:last-child{page-break-after:auto}.accent{position:absolute;inset:0 auto 0 0;width:5mm;background:${brand.primaryColor}}header{display:flex;justify-content:space-between;align-items:center;color:${brand.mutedColor};font-size:10px;letter-spacing:.12em;text-transform:uppercase}header span{font-weight:700;color:${brand.primaryColor}}main{position:relative;margin-top:18mm}h1{max-width:160mm;margin:0;color:${brand.textColor};font-size:31px;line-height:1.04;letter-spacing:-.035em}h2{margin:4mm 0 0;color:${brand.mutedColor};font-size:16px;font-weight:500}.eyebrow{margin:0 0 3mm;color:${brand.secondaryColor};font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}p{max-width:145mm;margin:6mm 0 0;color:${brand.mutedColor};font-size:12px;line-height:1.65}dl{display:grid;grid-template-columns:1fr 1fr;gap:0;margin:12mm 0 0;border-top:1px solid ${brand.primaryColor}33}dl div{min-height:18mm;padding:4mm 4mm 4mm 0;border-bottom:1px solid ${brand.primaryColor}22}dt{color:${brand.mutedColor};font-size:9px;letter-spacing:.08em;text-transform:uppercase}dd{margin:2mm 0 0;font-size:12px;font-weight:700;line-height:1.4}ul{display:grid;gap:3mm;margin:10mm 0 0;padding:0;list-style:none}li{padding:3mm 0 3mm 5mm;border-left:2px solid ${brand.secondaryColor};font-size:12px;line-height:1.45}.gallery{display:grid;grid-template-columns:1fr 1fr;gap:4mm;margin-top:10mm}.gallery-1{grid-template-columns:1fr}.gallery figure{position:relative;margin:0;overflow:hidden;border-radius:2mm;background:#e7ebe9}.gallery img{display:block;width:100%;height:61mm;object-fit:cover}.gallery-3 figure:first-child{grid-row:span 2}.gallery-3 figure:first-child img{height:126mm}.gallery figcaption{position:absolute;right:0;bottom:0;left:0;padding:8mm 3mm 3mm;background:linear-gradient(transparent,rgba(19,39,36,.8));color:#fff;font-size:9px}.page-cover{color:#fff;background:${brand.primaryColor}}.page-cover .accent{display:none}.page-cover header,.page-cover h1,.page-cover h2,.page-cover p,.page-cover dt,.page-cover dd{color:#fff}.page-cover .eyebrow{color:${brand.secondaryColor}}.page-cover main{display:grid;align-content:end;min-height:225mm}.page-cover .gallery{position:absolute;inset:-18mm -17mm -15mm;margin:0;opacity:.42}.page-cover .gallery:after{content:"";position:absolute;inset:0;background:linear-gradient(20deg,${brand.primaryColor} 10%,transparent 72%)}.page-cover .gallery figure,.page-cover .gallery img{width:100%;height:100%;border-radius:0}.page-cover main>*:not(.gallery){position:relative;z-index:1}.page-cover dl{grid-template-columns:repeat(3,1fr);border-color:#ffffff55}.page-contact main{display:grid;align-content:center;min-height:210mm}.page-contact h1{font-size:42px}footer{position:absolute;right:17mm;bottom:8mm;color:${brand.mutedColor};font-size:8px}@media(max-width:800px){.page{width:100%;min-height:100dvh;margin:0;padding:24px 22px 42px}.accent{width:5px}main{margin-top:48px}h1{font-size:30px}dl{grid-template-columns:1fr}.gallery img{height:34vw}.gallery-3 figure:first-child img{height:72vw}}@media print{html,body{background:transparent}.page{margin:0}}
</style></head><body>${model.pages.map((page, index) => renderPage(page, index, model.pages.length)).join("")}</body></html>`;
}

