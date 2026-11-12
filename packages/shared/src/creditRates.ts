import fs from 'node:fs';
import { CreditRatesSchema as RatesSchema } from '@kinote/contracts';

/** Credits per 1,000 tokens. */
export type CreditRate = { input: number; output: number };
export type CreditRates = { default: CreditRate; models: Record<string, CreditRate> };

/**
 * Reads MODEL_CREDIT_RATES: unset → null (every call costs 0). A value starting
 * with `{` is JSON; anything else is a path to a JSON file. Throws
 * `MODEL_CREDIT_RATES: <reason>` on bad JSON, a missing file or a schema failure,
 * so a bad setting stops the service rather than charging nothing.
 */
export function parseCreditRates(
  raw: string | undefined,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')
): CreditRates | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  let text: string;
  if (value.startsWith('{')) {
    text = value;
  } else {
    try {
      text = readFile(value);
    } catch (err) {
      throw new Error(`MODEL_CREDIT_RATES: cannot read file ${value} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('MODEL_CREDIT_RATES: not valid JSON');
  }
  const result = RatesSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`MODEL_CREDIT_RATES: ${issue.path.join('.') || '(root)'} ${issue.message}`);
  }
  return result.data;
}

const DETERMINISTIC = /^(kinote-deterministic|deterministic-)/;
const warnedModels = new Set<string>();

const defaultUnlisted = (model: string) => {
  console.warn(`MODEL_CREDIT_RATES has no entry for model "${model}"; charging the default rate`);
};

/**
 * The cost of one model call in millicredits (an integer, rounded up). 0 with no
 * rates and for deterministic models unless they are listed by name. A model not
 * listed is charged at `default` and reported once per process.
 */
export function millicreditsFor(
  rates: CreditRates | null,
  model: string,
  inputTokens: number,
  outputTokens: number,
  onUnlistedModel: (model: string) => void = defaultUnlisted
): number {
  if (!rates) return 0;
  let rate = rates.models[model];
  if (!rate) {
    if (DETERMINISTIC.test(model)) return 0;
    rate = rates.default;
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      onUnlistedModel(model);
    }
  }
  // Credits per 1,000 tokens = millicredits per token. Rounded to 1e-6 first so
  // float noise (0.1 × 3000 = 300.00000000000006) does not add a millicredit.
  const exact = inputTokens * rate.input + outputTokens * rate.output;
  return Math.ceil(Math.round(exact * 1e6) / 1e6);
}
