import { isAddress, isHex } from 'viem';
import type { TransactionRequest, TransactionStep, TypedDataRequest } from './types.js';

/**
 * The public docs only partially specify the /swaps/quote and /swaps/prepare responses:
 * they say approvals come back as "transaction steps", Permit2 as "typed data" and that the swap
 * itself is a transaction with `to`, `data` and `value`. The helpers below therefore accept the
 * documented `steps[]` shape (same as /launches/prepare) and a few obvious variations, and the
 * caller fails loudly when nothing recognisable is found.
 */

export interface ExtractedTx {
  id: string;
  transaction: TransactionRequest;
  dependsOn: string[];
  simulationNotRun: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeTx(value: unknown): value is TransactionRequest {
  return isRecord(value) && typeof value.to === 'string' && isAddress(value.to) && typeof value.data === 'string' && isHex(value.data);
}

export function extractTxSteps(result: unknown): ExtractedTx[] {
  if (!isRecord(result)) return [];
  const out: ExtractedTx[] = [];

  if (Array.isArray(result.steps)) {
    for (const [index, raw] of (result.steps as TransactionStep[]).entries()) {
      if (isRecord(raw) && raw.kind === 'transaction' && looksLikeTx(raw.transaction)) {
        out.push({
          id: typeof raw.id === 'string' ? raw.id : `step-${index}`,
          transaction: raw.transaction,
          dependsOn: Array.isArray(raw.depends_on) ? (raw.depends_on as string[]) : [],
          simulationNotRun: isRecord(raw.simulation) && raw.simulation.status === 'not_run',
        });
      }
    }
    if (out.length > 0) return out;
  }

  // Variations: a single top-level `transaction`, or `to`/`data`/`value` directly on the result.
  if (looksLikeTx(result.transaction)) {
    return [{ id: 'swap', transaction: result.transaction, dependsOn: [], simulationNotRun: false }];
  }
  if (looksLikeTx(result)) {
    return [{ id: 'swap', transaction: result, dependsOn: [], simulationNotRun: false }];
  }
  return [];
}

export function extractTypedData(result: unknown): TypedDataRequest | null {
  if (!isRecord(result)) return null;
  if (Array.isArray(result.steps)) {
    for (const raw of result.steps as TransactionStep[]) {
      if (isRecord(raw) && raw.kind === 'typed_data' && isRecord(raw.typed_data)) return raw.typed_data as unknown as TypedDataRequest;
    }
  }
  for (const key of ['permit2', 'typed_data', 'permit2_typed_data']) {
    const candidate = result[key];
    if (isRecord(candidate) && isRecord(candidate.domain) && isRecord(candidate.types) && isRecord(candidate.message)) {
      return candidate as unknown as TypedDataRequest;
    }
  }
  return null;
}

const INT_TYPE = /^u?int\d*$/;

function coerceValue(type: string, value: unknown, types: TypedDataRequest['types']): unknown {
  if (type.endsWith('[]')) {
    return (value as unknown[]).map((item) => coerceValue(type.slice(0, -2), item, types));
  }
  if (types[type]) return coerceStruct(type, value as Record<string, unknown>, types);
  if (INT_TYPE.test(type)) return typeof value === 'bigint' ? value : BigInt(value as string | number);
  return value;
}

function coerceStruct(name: string, value: Record<string, unknown>, types: TypedDataRequest['types']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of types[name] ?? []) out[field.name] = coerceValue(field.type, value[field.name], types);
  return out;
}

/** EIP-712 signers need bigint for uint fields, but the API sends numeric strings. */
export function coerceTypedData(td: TypedDataRequest): {
  domain: Record<string, unknown>;
  types: TypedDataRequest['types'];
  primaryType: string;
  message: Record<string, unknown>;
} {
  const types = { ...td.types };
  delete (types as Record<string, unknown>).EIP712Domain;
  return {
    domain: td.domain,
    types,
    primaryType: td.primaryType,
    message: coerceStruct(td.primaryType, td.message, types),
  };
}

export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

