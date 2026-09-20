/** Agrupador da visão "Agenda pessoal" de /tarefas (spec tarefas-agenda-pessoal).
 *  Puro: opera sobre a lista JÁ carregada (mesma SWR, zero refetch), sem lib de
 *  datas. O dia civil vem de Intl en-CA (yyyy-mm-dd) no fuso da sessão; o
 *  rótulo dos dias é pt-BR fixo ("ter, 23 set") montado do próprio key — criar
 *  um Date "seguro por fuso" para o Intl formatar exigiria matemática de fuso.
 */

export type AgendaTask = { id: string; status: string; due_at: string | null };
export type AgendaGroup<T extends AgendaTask> = { key: string; label: string; tasks: T[] };

const WEEKDAYS_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MONTHS_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function dayKeyFormatter(timezone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timezone ? { timeZone: timezone } : {})
  });
}

/** "2026-09-22" → "ter, 22 set" (weekday via UTC — independe de fuso). */
function dayLabel(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const weekday = WEEKDAYS_SHORT[new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()];
  return `${weekday}, ${day} ${MONTHS_SHORT[month! - 1]}`;
}

/**
 * Agrupa por dia civil do due_at no fuso dado, em ordem de render:
 * "Atrasadas" (due < hoje, não concluída) → dias (passados de concluídas,
 * hoje e futuros) ascendentes → "Sem prazo" (due ausente ou inválido/NaN).
 */
export function groupTasksByDay<T extends AgendaTask>(
  tasks: readonly T[],
  today: Date,
  timezone?: string
): AgendaGroup<T>[] {
  let formatDay: Intl.DateTimeFormat;
  try {
    formatDay = dayKeyFormatter(timezone);
  } catch {
    // Fuso inválido na sessão: agrupa no fuso local, nunca crasha.
    formatDay = dayKeyFormatter();
  }
  const todayKey = formatDay.format(today);

  const overdue: T[] = [];
  const undated: T[] = [];
  const byDay = new Map<string, T[]>();
  for (const task of tasks) {
    const due = task.due_at ? new Date(task.due_at) : null;
    if (!due || Number.isNaN(due.getTime())) {
      undated.push(task);
      continue;
    }
    const key = formatDay.format(due);
    if (key < todayKey && task.status !== "concluida") overdue.push(task);
    else {
      const bucket = byDay.get(key);
      if (bucket) bucket.push(task);
      else byDay.set(key, [task]);
    }
  }

  const groups: AgendaGroup<T>[] = [];
  if (overdue.length) groups.push({ key: "atrasadas", label: "Atrasadas", tasks: overdue });
  for (const key of [...byDay.keys()].sort()) {
    groups.push({ key, label: key === todayKey ? "Hoje" : dayLabel(key), tasks: byDay.get(key)! });
  }
  if (undated.length) groups.push({ key: "sem-prazo", label: "Sem prazo", tasks: undated });
  return groups;
}
