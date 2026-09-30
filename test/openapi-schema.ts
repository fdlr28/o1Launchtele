/**
 * Transcription of `LaunchPrepareRequest` (and the parts it references) from the o1 Launchpad
 * OpenAPI file (docs.o1.exchange/launchpad-api-openapi.yaml). Used to prove that the request
 * bodies built by the bot are valid for the real API.
 *
 * The published schema does not close the top-level objects, but the API documents that unknown
 * fields are rejected (`unknown_parameter`), so `additionalProperties: false` is added here to
 * make the tests stricter than the schema.
 */
const ADDRESS = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' };
const NOT_ZERO = { not: { const: '0x0000000000000000000000000000000000000000' } };
const RATE = { type: 'string', pattern: '^(?:0|[1-9][0-9]{0,7}|100000000)$', maxLength: 9 };
const UINT = { type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 78 };

const maybeEmpty = (pattern: string) => ({
  anyOf: [{ type: 'string', format: 'uri', maxLength: 2048, pattern }, { type: 'string', const: '' }],
  default: '',
});

export const inclusiveTaxSchema = {
  type: 'object',
  required: [
    'format',
    'buy_tax_rate',
    'sell_tax_rate',
    'creator_allocation_share',
    'burn_allocation_share',
    'dividend_allocation_share',
    'integrator_allocation_share',
    'minimum_dividend_holding_raw',
    'creator_fee_recipient',
    'anti_snipe_enabled',
  ],
  properties: {
    format: { type: 'string', const: 'inclusive' },
    buy_tax_rate: RATE,
    sell_tax_rate: RATE,
    creator_allocation_share: RATE,
    burn_allocation_share: RATE,
    dividend_allocation_share: RATE,
    integrator_allocation_share: RATE,
    minimum_dividend_holding_raw: UINT,
    creator_fee_recipient: { ...ADDRESS, ...NOT_ZERO },
    integrator_fee_recipient: ADDRESS,
    anti_snipe_enabled: { type: 'boolean' },
  },
  additionalProperties: false,
};

export const launchPrepareRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['chain_id', 'creator', 'market', 'quote_address', 'token'],
  additionalProperties: false,
  properties: {
    chain_id: { type: 'integer', enum: [8453, 4663, 143, 5042, 56, 196] },
    creator: { ...ADDRESS, ...NOT_ZERO },
    market: { type: 'string', enum: ['standard', 'rwa'] },
    launch_product: { type: 'string', enum: ['non-tax', 'tax'], default: 'non-tax' },
    tax: inclusiveTaxSchema,
    quote_address: ADDRESS,
    token: {
      type: 'object',
      required: ['name', 'symbol', 'image_base64', 'image_type'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 50 },
        symbol: { type: 'string', minLength: 1, maxLength: 11, pattern: '^\\S+$' },
        description: { type: 'string', maxLength: 2000, default: '' },
        image_base64: { type: 'string', minLength: 1, maxLength: 3_000_000, contentEncoding: 'base64' },
        image_type: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
        website: maybeEmpty('^https?://[^/]*\\.[^/]+(?:/.*)?$'),
        x: maybeEmpty('^https?://(?:www\\.)?x\\.com/.+'),
        telegram: maybeEmpty('^https?://(?:www\\.)?(?:t\\.me|telegram\\.me)/.+'),
        editable_metadata: { type: 'boolean', default: false },
        extra_metadata: {
          type: 'array',
          maxItems: 16,
          default: [],
          items: {
            type: 'object',
            required: ['key', 'value'],
            properties: {
              key: { type: 'string', minLength: 1, maxLength: 64 },
              value: { type: 'string', maxLength: 512 },
            },
          },
        },
      },
    },
  },
  allOf: [
    {
      if: { properties: { launch_product: { const: 'tax' } }, required: ['launch_product'] },
      then: { required: ['tax'] },
      else: { not: { required: ['tax'] } },
    },
  ],
};
