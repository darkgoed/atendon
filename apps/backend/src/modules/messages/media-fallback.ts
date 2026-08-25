import type { MediaType } from "./types.js";
import { DEFAULT_MEDIA_FALLBACK } from "../ai-router/defaults.js";

export function mediaFallback(mediaType: MediaType): string {
  return DEFAULT_MEDIA_FALLBACK[mediaType];
}
