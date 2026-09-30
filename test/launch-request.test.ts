import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { newDraft, type Draft } from '../src/domain/draft.js';
import { validateImage } from '../src/domain/validators.js';
import { buildLaunchRequest, draftProblems } from '../src/o1/launchRequest.js';
import { UserFacingError } from '../src/errors.js';
import type { ContractSuite, QuoteConfiguration } from '../src/o1/types.js';
import { launchPrepareRequestSchema } from './openapi-schema.js';
import { AAPL, RECIPIENT, TOKENS_10K, USDC, WALLET, ZERO, configFor, suite } from './fixtures.js';

// ajv-formats is CommonJS; under NodeNext its default export needs unwrapping for the types.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (instance: Ajv2020) => void;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(launchPrepareRequestSchema);

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function completeDraft(overrides: Partial<Draft> = {}): Draft {
  const cfg = configFor('tax');
  const native = cfg.quotes![0]!;
  return {
    ...newDraft({ chainId: 8453, wallet: WALLET }),
    quote: { address: native.address, symbol: 'ETH', decimals: 18, route: 'standard', assetType: 'native' },
    name: 'Pepe Coin',
    symbol: 'PEPE',
    image: validateImage(PNG),
    ...overrides,
  };
}

function build(draft: Draft, product = draft.product, quoteIndex = 0) {
  const cfg = configFor(product);
  const s = cfg.suites![0] as ContractSuite;
  const q = cfg.quotes![quoteIndex] as QuoteConfiguration;
  return buildLaunchRequest({ draft, creator: WALLET, suite: s, quote: q });
}

function expectValid(body: unknown) {
  const ok = validate(body);
  expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
}

describe('buildLaunchRequest is valid against the o1 OpenAPI schema', () => {
  it('Tax launch with defaults', () => {
    const body = build(completeDraft());
    expectValid(body);
    expect(body.launch_product).toBe('tax');
    expect(body.market).toBe('standard');
    expect(body.quote_address).toBe(ZERO);
    expect(body.tax).toMatchObject({
      format: 'inclusive',
      buy_tax_rate: '3000000',
      sell_tax_rate: '3000000',
      creator_allocation_share: '100000000',
      dividend_allocation_share: '0',
      burn_allocation_share: '0',
      minimum_dividend_holding_raw: '0',
      creator_fee_recipient: WALLET,
      anti_snipe_enabled: true,
    });
  });

  it('Tax launch with dividends, socials and a custom recipient', () => {
    const draft = completeDraft({
      website: 'https://pepe.example',
      x: 'https://x.com/pepe',
      telegram: 'https://t.me/pepe_chat',
      description: 'The original frog',
      editableMetadata: true,
    });
    draft.tax = {
      ...draft.tax,
      buyRate: '5000000',
      sellRate: '7500000',
      creatorShare: '60000000',
      dividendShare: '40000000',
      minHolding: TOKENS_10K,
      antiSnipe: false,
      creatorRecipient: RECIPIENT,
    };
    const body = build(draft);
    expectValid(body);
    expect(body.token).toMatchObject({ website: 'https://pepe.example', x: 'https://x.com/pepe', telegram: 'https://t.me/pepe_chat', editable_metadata: true });
    expect(body.tax?.creator_fee_recipient).toBe(RECIPIENT);
    expect(body.tax?.minimum_dividend_holding_raw).toBe(TOKENS_10K);
  });

  it('Standard launch has no tax object', () => {
    const draft = completeDraft({ product: 'non-tax' });
    const body = build(draft, 'non-tax');
    expectValid(body);
    expect(body.launch_product).toBe('non-tax');
    expect('tax' in body).toBe(false);
  });

  it('stock pair uses the rwa market and the quote address from /config', () => {
    const draft = completeDraft({ quote: { address: AAPL, symbol: 'AAPL', decimals: 8, route: 'rwa', assetType: 'tokenized_security' } });
    const body = build(draft, 'tax', 2);
    expectValid(body);
    expect(body.market).toBe('rwa');
    expect(body.quote_address).toBe(AAPL);
  });

  it('ERC-20 stable pair', () => {
    const draft = completeDraft({ quote: { address: USDC, symbol: 'USDC', decimals: 6, route: 'standard', assetType: 'stablecoin' } });
    const body = build(draft, 'tax', 1);
    expectValid(body);
    expect(body.quote_address).toBe(USDC);
  });

  it('never sends unknown fields (the API rejects them)', () => {
    const body = build(completeDraft());
    expect(Object.keys(body).sort()).toEqual(['chain_id', 'creator', 'launch_product', 'market', 'quote_address', 'tax', 'token']);
    expect(Object.keys(body.token).sort()).toEqual([
      'description', 'editable_metadata', 'extra_metadata', 'image_base64', 'image_type', 'name', 'symbol', 'telegram', 'website', 'x',
    ]);
  });

  it('sends the image bytes unchanged', () => {
    const body = build(completeDraft());
    expect(Buffer.from(body.token.image_base64, 'base64')).toEqual(Buffer.from(PNG));
    expect(body.token.image_type).toBe('image/png');
  });
});

describe('draftProblems / guard rails', () => {
  it('lists missing required fields', () => {
    const empty = newDraft({ chainId: 8453, wallet: WALLET });
    const problems = draftProblems(empty, suite('tax')).join('\n');
    expect(problems).toContain('Pair');
    expect(problems).toContain('Nama');
    expect(problems).toContain('Simbol');
    expect(problems).toContain('Gambar');
  });

  it('requires an amount when dev buy is on', () => {
    const draft = completeDraft();
    draft.devBuy.enabled = true;
    expect(draftProblems(draft, suite('tax')).join('\n')).toContain('Jumlah dev buy');
  });

  it('refuses to build a request for an invalid tax setup', () => {
    const draft = completeDraft();
    draft.tax.buyRate = '50000000'; // 50% is outside the 1-10% policy
    expect(() => build(draft)).toThrow(UserFacingError);
    expect(() => build(draft)).toThrow(/Buy tax/);
  });

  it('refuses an incomplete draft', () => {
    const draft = completeDraft({ name: null });
    expect(() => build(draft)).toThrow(/Nama/);
  });
});

describe('the schema harness itself can fail (guards against a vacuous test suite)', () => {
  const good = () => structuredClone(build(completeDraft()));

  it('rejects unknown top-level fields', () => {
    expect(validate({ ...good(), dev_buy: true })).toBe(false);
  });

  it('rejects a non-x.com X link, a zero tax recipient and malformed rates', () => {
    const badX = good();
    badX.token.x = 'https://example.com/elon';
    expect(validate(badX)).toBe(false);

    const zeroRecipient = good();
    zeroRecipient.tax!.creator_fee_recipient = ZERO;
    expect(validate(zeroRecipient)).toBe(false);

    const badRate = good();
    badRate.tax!.buy_tax_rate = '03000000';
    expect(validate(badRate)).toBe(false);
  });

  it('rejects a tax object on a non-tax request and a missing one on a tax request', () => {
    const std = good();
    std.launch_product = 'non-tax';
    expect(validate(std)).toBe(false); // still carries `tax`

    const noTax = good();
    delete noTax.tax;
    expect(validate(noTax)).toBe(false);
  });
});
