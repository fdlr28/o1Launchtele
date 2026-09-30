import type { Address } from 'viem';
import type { Draft } from '../domain/draft.js';
import { missingFields } from '../domain/draft.js';
import { effectiveTaxSettings, readTaxPolicy, toApiTax, validateTaxSettings } from '../domain/tax.js';
import { UserFacingError } from '../errors.js';
import type { ContractSuite, LaunchPrepareRequest, QuoteConfiguration } from './types.js';

export interface BuildLaunchRequestInput {
  draft: Draft;
  creator: Address;
  suite: ContractSuite;
  quote: QuoteConfiguration;
}

/** Problems that would make the API reject the draft, in Indonesian. Empty = OK. */
export function draftProblems(draft: Draft, suite: ContractSuite | undefined): string[] {
  const problems = missingFields(draft).map((f) => `${f} belum diisi.`);
  if (draft.product === 'tax') {
    const policy = suite ? readTaxPolicy(suite) : null;
    if (suite && !policy) {
      problems.push('Suite Tax di chain ini memakai format lama yang tidak didukung bot.');
    } else if (policy) {
      const supply = suite?.launch_supply_raw ? BigInt(suite.launch_supply_raw) : null;
      problems.push(...validateTaxSettings(draft.tax, policy, supply));
    }
  }
  return problems;
}

export function buildLaunchRequest({ draft, creator, suite, quote }: BuildLaunchRequestInput): LaunchPrepareRequest {
  const problems = draftProblems(draft, suite);
  if (problems.length > 0) throw new UserFacingError(problems.join('\n'));
  if (!draft.name || !draft.symbol || !draft.image) throw new UserFacingError('Draft belum lengkap.');

  const request: LaunchPrepareRequest = {
    chain_id: draft.chainId,
    creator,
    market: quote.route,
    launch_product: draft.product,
    quote_address: quote.address,
    token: {
      name: draft.name,
      symbol: draft.symbol,
      description: draft.description,
      image_base64: draft.image.base64,
      image_type: draft.image.type,
      website: draft.website,
      x: draft.x,
      telegram: draft.telegram,
      editable_metadata: draft.editableMetadata,
      extra_metadata: [],
    },
  };

  if (draft.product === 'tax') {
    const policy = readTaxPolicy(suite);
    if (!policy) throw new UserFacingError('Kebijakan tax tidak tersedia untuk chain ini.');
    request.tax = toApiTax(effectiveTaxSettings(draft.tax, policy));
  }
  return request;
}
