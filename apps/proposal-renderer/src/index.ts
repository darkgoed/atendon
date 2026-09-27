export * from "./spec.js";
export * from "./brand.js";
export * from "./page-data.js";
export { PROPOSAL_FONT_FACES, PROPOSAL_FONT_FILES, proposalFontFaceCssInline, proposalFontFaceCssExternal } from "./fonts.js";
export type { ProposalPage, ProposalPageKind } from "./pages.js";
export { buildProposalPages, PROPOSAL_RENDERER_VERSION } from "./pages.js";
export { ProposalDocument } from "./document.js";
export { renderProposalHtml } from "./render.js";
