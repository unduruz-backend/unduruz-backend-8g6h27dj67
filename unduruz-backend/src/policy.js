// The compliance rules every agent is bound by, derived from current
// platform policy. This string is prepended to every Claude call.
// If a platform changes its rules, change them here once.

export const POLICY = {
  disclose:
    'Always state clearly where AI was used. Undisclosed AI is the single ' +
    'biggest account-termination risk: Amazon KDP terminates for ' +
    'misrepresentation rather than for AI use, and Etsy removes undisclosed ' +
    'listings.',
  humanValue:
    'YouTube demonetises "inauthentic content" (mass-produced or templated) ' +
    'under its 15 July 2025 policy. Every item must carry unique human ' +
    'value: an original angle, real editorial choices, specific first-hand detail.',
  niche:
    'Generic output neither sells nor survives moderation. Target a niche ' +
    'describable in five or more specific words, never a broad category.',
  noBulk:
    'Never produce near-identical variants for different buyers or channels. ' +
    'Fiverr bans bulk-identical AI delivery; Upwork bans unreviewed ' +
    'automated submission.',
  ip:
    'Use only assets licensed for commercial use. Never imitate a living ' +
    "artist's style, a trademark, or a copyrighted character. Pure AI output " +
    'is not copyrightable (US Copyright Office, 29 January 2025), so the ' +
    'human-authored structure and editing is what we own.',
  refunds:
    'Australian Consumer Law applies to digital goods and cannot be ' +
    'contracted out of. Never write "no refunds".',
  claims:
    'Never promise income, guaranteed results, or make health, legal or ' +
    'financial claims.',
};

export function policyBlock() {
  return [
    'OPERATING POLICY (mandatory):',
    '- ' + POLICY.disclose,
    '- ' + POLICY.humanValue,
    '- ' + POLICY.niche,
    '- ' + POLICY.noBulk,
    '- ' + POLICY.ip,
    '- ' + POLICY.refunds,
    '- ' + POLICY.claims,
    '',
    'You are drafting only. A human reviews and approves everything before ' +
    'it is published. Never claim something has been published or sold.',
  ].join('\n');
}

// Product lines chosen for what genuinely sells and what platforms permit.
export const TASK_KINDS = [
  {
    cat: 'Niche Digital Product',
    channel: 'Lemon Squeezy / Gumroad',
    titles: [
      'Notion template for a specific profession',
      'Canva pack for one niche trade',
      'Digital planner for a named audience',
      'Spreadsheet tool for one workflow',
    ],
    brief:
      'Design one niche digital product. Name the exact audience, the specific ' +
      'problem, what is inside, and the listing copy.',
    disclosure: [
      'State AI assistance in the listing description',
      'Etsy: list as "Designed by a seller", who_made = I did',
      'Include an ACL-compliant refund line',
    ],
    valueCents: [1200, 8500],
  },
  {
    cat: 'Short-Form Video',
    channel: 'YouTube Shorts',
    titles: [
      'Shorts script with an original angle',
      'Explainer series for one niche',
      'Hook rewrites grounded in real specifics',
    ],
    brief:
      'Write a short video script with a genuinely original angle and real ' +
      'editorial choices. Include hook, beats, on-screen text and spoken script.',
    disclosure: [
      'Tick YouTube "altered or synthetic content" if visuals are realistic AI',
      'Add unique human commentary; templated output is demonetised',
      'Use only commercially licensed music and footage',
    ],
    valueCents: [0, 0],
  },
  {
    cat: 'Client Service',
    channel: 'Direct / Upwork / Fiverr',
    titles: [
      'Custom copy for one real client',
      'Content audit for a named business',
      'Launch plan tailored to one brand',
    ],
    brief:
      'Produce genuinely customised client work, specific to one business and ' +
      'unusable as a template for anyone else.',
    disclosure: [
      'Disclose AI assistance to the client',
      'Must be customised per order; bulk-identical delivery is banned',
      'Human review required before delivery',
    ],
    valueCents: [8000, 45000],
  },
  {
    cat: 'Marketing Asset',
    channel: 'Owned channels',
    titles: [
      'Launch sequence for one product',
      'Landing page for a niche offer',
      'Audience research brief',
    ],
    brief:
      'Produce a marketing asset for our own products. Concrete and executable ' +
      'this week, with no income or results promises.',
    disclosure: [
      'No earnings or guaranteed-results claims',
      'Substantiate any statistic or drop it',
    ],
    valueCents: [0, 0],
  },
  {
    cat: 'Ops & Research',
    channel: 'Internal',
    titles: [
      'Competitor teardown in one niche',
      'Pricing experiment design',
      'Cost reduction review',
    ],
    brief:
      'Produce an internal research or operations brief with findings and ' +
      'recommended actions. Flag uncertainty honestly.',
    disclosure: ['Internal use; mark clearly if any part is published later'],
    valueCents: [0, 0],
  },
];

export const kindByCat = (cat) => TASK_KINDS.find((k) => k.cat === cat);
