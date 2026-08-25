"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_PIPELINE_PREFERENCES,
  normalizePipelinePreferences,
  pipelinePreferenceStorageKey,
  type PipelinePreferences
} from "@/lib/pipeline";

export function usePipelinePreferences(tenantId?: string, userId?: string) {
  const [preferences, setPreferences] = useState<PipelinePreferences>(() => ({
    ...DEFAULT_PIPELINE_PREFERENCES,
    visibleFields: [...DEFAULT_PIPELINE_PREFERENCES.visibleFields],
    auxiliaryBadges: [...DEFAULT_PIPELINE_PREFERENCES.auxiliaryBadges]
  }));
  const hydratedFor = useRef<string | null>(null);
  const skipPersistFor = useRef<string | null>(null);

  useEffect(() => {
    if (!tenantId || !userId) return;
    const ownerKey = `${tenantId}:${userId}`;
    skipPersistFor.current = ownerKey;
    try {
      const stored = window.localStorage.getItem(pipelinePreferenceStorageKey(tenantId, userId));
      setPreferences(normalizePipelinePreferences(stored ? JSON.parse(stored) : null));
    } catch {
      setPreferences(normalizePipelinePreferences(null));
    }
    hydratedFor.current = ownerKey;
  }, [tenantId, userId]);

  useEffect(() => {
    if (!tenantId || !userId) return;
    const ownerKey = `${tenantId}:${userId}`;
    if (hydratedFor.current !== ownerKey) return;
    if (skipPersistFor.current === ownerKey) {
      skipPersistFor.current = null;
      return;
    }
    try {
      window.localStorage.setItem(pipelinePreferenceStorageKey(tenantId, userId), JSON.stringify(preferences));
    } catch {
      // Storage may be unavailable in private or constrained browsing contexts.
    }
  }, [preferences, tenantId, userId]);

  return [preferences, setPreferences] as const;
}
