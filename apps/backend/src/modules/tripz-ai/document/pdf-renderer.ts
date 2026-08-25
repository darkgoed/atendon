import { PDFDocument, StandardFonts, rgb, type PDFImage, type PDFFont, type PDFPage } from "pdf-lib";
import sharp from "sharp";
import type { TripzDocumentAsset, TripzDocumentModel } from "./view-model.js";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

function color(hex: string) {
  const normalized = hex.replace("#", "");
  return rgb(Number.parseInt(normalized.slice(0, 2), 16) / 255, Number.parseInt(normalized.slice(2, 4), 16) / 255, Number.parseInt(normalized.slice(4, 6), 16) / 255);
}

function pdfSafe(value: string, font: PDFFont): string {
  const normalized = value.replace(/\u00a0/g, " ").replace(/[→←↔]/g, "-").replace(/[–—]/g, "-");
  let output = "";
  for (const character of normalized) {
    try {
      font.encodeText(character);
      output += character;
    } catch {
      output += "?";
    }
  }
  return output;
}

function wrap(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of pdfSafe(value, font).split(/\n+/)) {
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) current = candidate;
      else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function drawTextLines(page: PDFPage, lines: string[], input: { x: number; y: number; size: number; font: PDFFont; color: ReturnType<typeof rgb>; maxLines?: number; lineHeight?: number }) {
  const visible = lines.slice(0, input.maxLines ?? lines.length);
  visible.forEach((line, index) => page.drawText(line, { x: input.x, y: input.y - index * (input.lineHeight ?? input.size * 1.3), size: input.size, font: input.font, color: input.color }));
  return input.y - visible.length * (input.lineHeight ?? input.size * 1.3);
}

async function embedImage(pdf: PDFDocument, asset: TripzDocumentAsset): Promise<PDFImage | null> {
  try {
    if (asset.mimeType === "image/png") return await pdf.embedPng(asset.data);
    if (asset.mimeType === "image/jpeg") return await pdf.embedJpg(asset.data);
    if (asset.mimeType === "image/webp") {
      const png = await sharp(asset.data, { failOn: "error", limitInputPixels: 40_000_000 }).png().toBuffer();
      return await pdf.embedPng(png);
    }
  } catch {
    return null;
  }
  return null;
}

function fitImage(image: PDFImage, width: number, height: number) {
  const scale = Math.min(width / image.width, height / image.height);
  return { width: image.width * scale, height: image.height * scale };
}

export async function renderTripzPdf(model: TripzDocumentModel): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(model.title);
  pdf.setAuthor(model.brand.agencyName);
  pdf.setCreator(`AtendON ${model.rendererVersion}`);
  pdf.setProducer("AtendON Tripz IA");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const primary = color(model.brand.primaryColor);
  const secondary = color(model.brand.secondaryColor);
  const background = color(model.brand.backgroundColor);
  const textColor = color(model.brand.textColor);
  const muted = color(model.brand.mutedColor);

  for (const [pageIndex, source] of model.pages.entries()) {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const isCover = source.kind === "cover";
    page.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, color: isCover ? primary : background });
    if (!isCover) page.drawRectangle({ x: 0, y: 0, width: 14, height: PAGE_HEIGHT, color: primary });

    const embedded = (await Promise.all(source.images.slice(0, isCover ? 1 : 4).map((asset) => embedImage(pdf, asset)))).filter((item): item is PDFImage => Boolean(item));
    if (isCover && embedded[0]) {
      const image = embedded[0];
      const scale = Math.max(PAGE_WIDTH / image.width, PAGE_HEIGHT / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      page.drawImage(image, { x: (PAGE_WIDTH - width) / 2, y: (PAGE_HEIGHT - height) / 2, width, height, opacity: 0.32 });
      page.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, color: primary, opacity: 0.45 });
    }

    const foreground = isCover ? rgb(1, 1, 1) : textColor;
    page.drawText(pdfSafe(source.eyebrow.toUpperCase(), bold), { x: 56, y: 788, size: 9, font: bold, color: isCover ? secondary : primary });
    page.drawText(`${pageIndex + 1} / ${model.pages.length}`, { x: 505, y: 788, size: 8, font: regular, color: isCover ? rgb(1, 1, 1) : muted });
    let y = isCover ? 310 : 720;
    y = drawTextLines(page, wrap(source.title, bold, isCover ? 36 : 27, 480), { x: 56, y, size: isCover ? 36 : 27, font: bold, color: foreground, maxLines: 4, lineHeight: isCover ? 40 : 31 }) - 8;
    if (source.subtitle) y = drawTextLines(page, wrap(source.subtitle, regular, 14, 470), { x: 56, y, size: 14, font: regular, color: isCover ? rgb(1, 1, 1) : muted, maxLines: 3, lineHeight: 18 }) - 12;

    for (const paragraph of source.paragraphs) {
      y = drawTextLines(page, wrap(paragraph, regular, 11, 470), { x: 56, y, size: 11, font: regular, color: isCover ? rgb(1, 1, 1) : muted, maxLines: 7, lineHeight: 16 }) - 9;
    }

    if (!isCover && embedded.length) {
      const columns = embedded.length === 1 ? 1 : 2;
      const boxWidth = columns === 1 ? 470 : 227;
      const boxHeight = embedded.length <= 2 ? 180 : 116;
      const startY = Math.min(y - 16, 445);
      embedded.forEach((image, index) => {
        const fitted = fitImage(image, boxWidth, boxHeight);
        const column = index % columns;
        const row = Math.floor(index / columns);
        const boxX = 56 + column * 243;
        const boxY = startY - row * (boxHeight + 14) - boxHeight;
        page.drawRectangle({ x: boxX, y: boxY, width: boxWidth, height: boxHeight, color: rgb(0.91, 0.93, 0.92) });
        page.drawImage(image, { x: boxX + (boxWidth - fitted.width) / 2, y: boxY + (boxHeight - fitted.height) / 2, ...fitted });
      });
      y = startY - Math.ceil(embedded.length / columns) * (boxHeight + 14) - 10;
    }

    for (const fact of source.facts) {
      if (y < 95) break;
      page.drawLine({ start: { x: 56, y: y + 5 }, end: { x: 526, y: y + 5 }, thickness: 0.5, color: primary, opacity: 0.25 });
      page.drawText(pdfSafe(fact.label.toUpperCase(), bold), { x: 56, y: y - 9, size: 7, font: bold, color: isCover ? rgb(1, 1, 1) : muted });
      y = drawTextLines(page, wrap(fact.value, bold, 10.5, 465), { x: 56, y: y - 25, size: 10.5, font: bold, color: foreground, maxLines: 3, lineHeight: 14 }) - 8;
    }

    for (const bullet of source.bullets) {
      if (y < 88) break;
      page.drawRectangle({ x: 56, y: y - 3, width: 3, height: 18, color: secondary });
      y = drawTextLines(page, wrap(bullet, regular, 10.5, 450), { x: 68, y: y + 4, size: 10.5, font: regular, color: foreground, maxLines: 3, lineHeight: 14 }) - 8;
    }

    page.drawText("Documento gerado a partir dos dados revisados da proposta", { x: 56, y: 27, size: 6.5, font: regular, color: isCover ? rgb(1, 1, 1) : muted });
  }

  return pdf.save({ useObjectStreams: true, addDefaultPage: false });
}
