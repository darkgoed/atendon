"use client";

import { ArrowCounterClockwise, SlidersHorizontal } from "@phosphor-icons/react";
import { PopoverMenu } from "@/components/popover-menu";
import { IconButton } from "@/components/ui";
import {
  DEFAULT_PIPELINE_PREFERENCES,
  type PipelineAuxiliaryBadge,
  type PipelineOptionalField,
  type PipelinePreferences
} from "@/lib/pipeline";

const fieldLabels: Record<PipelineOptionalField, string> = {
  origin: "Origem e campanha",
  ownership: "Responsável",
  qualification: "Qualificação",
  nextMeeting: "Próxima reunião",
  nextAction: "Próxima ação",
  stalled: "Tempo sem avanço"
};

const badgeLabels: Record<PipelineAuxiliaryBadge, string> = {
  resultPending: "Resultado pendente",
  recovery: "Recuperação / no-show",
  overdueFollowUp: "Follow-up atrasado"
};

function toggle<T extends string>(values: T[], value: T, checked: boolean): T[] {
  return checked ? [...new Set([...values, value])] : values.filter((candidate) => candidate !== value);
}

export function PipelineViewPreferences({
  value,
  onChange
}: {
  value: PipelinePreferences;
  onChange: (value: PipelinePreferences) => void;
}) {
  return (
    <PopoverMenu
      icon={<SlidersHorizontal size={15} aria-hidden="true" />}
      ariaLabel="Exibição"
      title="Exibição"
      buttonClassName="btn active:scale-[.98]"
      panelClassName="pipeline-popover grid gap-4"
    >
      {() => <>
        <div>
          <strong className="text-sm">Exibição do quadro</strong>
          <p className="pipeline-preference-copy">Estas escolhas ficam salvas apenas para o seu usuário.</p>
        </div>
        <fieldset className="grid gap-2">
          <legend className="label mb-1">Densidade</legend>
          <div className="grid grid-cols-2 gap-2">
            {(["compact", "comfortable"] as const).map((density) => (
              <button
                key={density}
                type="button"
                className={`min-h-9 rounded border px-3 text-xs transition-colors active:scale-[.98] ${value.density === density ? "border-[var(--primary)] bg-[var(--surface-active)] text-[var(--primary-text)]" : "border-[var(--border)] text-[var(--text-secondary)]"}`}
                aria-pressed={value.density === density}
                onClick={() => onChange({ ...value, density })}
              >
                {density === "compact" ? "Compacta" : "Confortável"}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="label mb-2">Campos opcionais</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.entries(fieldLabels) as [PipelineOptionalField, string][]).map(([field, label]) => (
              <label key={field} className="flex min-h-8 items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={value.visibleFields.includes(field)}
                  onChange={(event) => onChange({ ...value, visibleFields: toggle(value.visibleFields, field, event.target.checked) })}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="label mb-2">Alertas auxiliares</legend>
          <div className="grid gap-2">
            {(Object.entries(badgeLabels) as [PipelineAuxiliaryBadge, string][]).map(([badge, label]) => (
              <label key={badge} className="flex min-h-8 items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={value.auxiliaryBadges.includes(badge)}
                  onChange={(event) => onChange({ ...value, auxiliaryBadges: toggle(value.auxiliaryBadges, badge, event.target.checked) })}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span className="label">Largura das colunas</span>
          <select className="input" value={value.columnWidth} onChange={(event) => onChange({ ...value, columnWidth: Number(event.target.value) as PipelinePreferences["columnWidth"] })}>
            <option value={240}>Estreita · 240 px</option>
            <option value={280}>Padrão · 272 px</option>
            <option value={320}>Ampla · 320 px</option>
          </select>
        </label>
        <IconButton type="button" label="Restaurar padrão" className="active:scale-[.98]" onClick={() => onChange({ ...DEFAULT_PIPELINE_PREFERENCES, visibleFields: [...DEFAULT_PIPELINE_PREFERENCES.visibleFields], auxiliaryBadges: [...DEFAULT_PIPELINE_PREFERENCES.auxiliaryBadges] })}>
          <ArrowCounterClockwise size={15} aria-hidden="true" />
        </IconButton>
      </>}
    </PopoverMenu>
  );
}
