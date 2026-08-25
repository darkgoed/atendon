import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  runNewaveGoldReplayExperiment,
  serializeNewaveReplayExperimentReport,
  type NewaveReplayExperimentFixtureBundle
} from "../src/modules/agent-improvement/newave-replay-experiment.js";

function fixtureBundle(value: unknown): NewaveReplayExperimentFixtureBundle {
  if (!value || typeof value !== "object") throw new Error("Arquivo de fixtures IA-04 inválido");
  const candidate = value as Partial<NewaveReplayExperimentFixtureBundle>;
  if (typeof candidate.suiteVersion !== "string"
    || !Array.isArray(candidate.samples)
    || (candidate.evidenceKind !== "recorded_replay" && candidate.evidenceKind !== "synthetic_test")) {
    throw new Error("Arquivo de fixtures IA-04 deve conter suiteVersion, evidenceKind e samples");
  }
  return candidate as NewaveReplayExperimentFixtureBundle;
}

export async function runNewaveReplayExperimentCli(argv: string[]): Promise<string> {
  const parsed = parseArgs({
    args: argv,
    options: {
      fixtures: { type: "string" },
      output: { type: "string" }
    },
    strict: true
  });
  if (!parsed.values.fixtures || !parsed.values.output) {
    throw new Error("Uso: --fixtures <arquivo-sanitizado.json> --output <relatorio.json>");
  }
  const fixturePath = resolve(parsed.values.fixtures);
  const outputPath = resolve(parsed.values.output);
  const fixtures = fixtureBundle(JSON.parse(await readFile(fixturePath, "utf8")));
  const report = runNewaveGoldReplayExperiment({ fixtures });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializeNewaveReplayExperimentReport(report), {
    encoding: "utf8",
    mode: 0o600
  });
  return outputPath;
}

const isEntrypoint = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isEntrypoint) {
  runNewaveReplayExperimentCli(process.argv.slice(2))
    .then((outputPath) => console.log(`Relatório IA-04 sanitizado salvo em ${outputPath}`))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
