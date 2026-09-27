import { z } from "zod";

// C8: o `message` de um ZodError é JSON.stringify(issues) e chegava cru ao
// painel. Aqui vira texto legível: mensagens próprias do schema (refine,
// .min(1, "Informe…")) passam intactas; as padrões do zod (em inglês) viram
// português prefixadas pelo caminho do campo.
function defaultIssueText(issue: z.ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined" || issue.received === "null" ? "campo obrigatório" : "tipo inválido";
    case "invalid_string":
      return issue.validation === "uuid" ? "identificador inválido"
        : issue.validation === "email" ? "e-mail inválido"
          : issue.validation === "url" ? "URL inválida"
            : issue.validation === "datetime" || issue.validation === "date" ? "data inválida"
              : "formato inválido";
    case "too_small":
      return issue.type === "string" ? `deve ter ao menos ${issue.minimum} caractere(s)`
        : issue.type === "array" || issue.type === "set" ? `deve ter ao menos ${issue.minimum} item(ns)`
          : `deve ser no mínimo ${issue.minimum}`;
    case "too_big":
      return issue.type === "string" ? `deve ter no máximo ${issue.maximum} caractere(s)`
        : issue.type === "array" || issue.type === "set" ? `deve ter no máximo ${issue.maximum} item(ns)`
          : `deve ser no máximo ${issue.maximum}`;
    case "invalid_enum_value":
    case "invalid_literal":
      return "valor não permitido";
    case "unrecognized_keys":
      return `campo(s) não permitido(s): ${issue.keys.join(", ")}`;
    case "invalid_date":
      return "data inválida";
    default:
      return "valor inválido";
  }
}

export function zodErrorMessage(error: z.ZodError): string {
  const messages = error.issues.map((issue) => {
    const zodDefault = z.defaultErrorMap(issue, { defaultError: issue.message, data: undefined }).message;
    if (issue.message !== zodDefault) return issue.message;
    const path = issue.path.join(".");
    return path ? `Campo ${path}: ${defaultIssueText(issue)}` : `Dados inválidos: ${defaultIssueText(issue)}`;
  });
  return [...new Set(messages)].join("; ") || "Dados inválidos";
}
