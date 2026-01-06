export const DEFAULTS = {
  standbyRate: 1.6,
  mult150: 1.5,
  mult200: 2.0,
  taxPresetId: "mid35",
  payrollPeriod: "month",
  hasLoonheffingskorting: true
};

export const TAX_PRESETS = [
  { id: "low25", label: "Laag (25%)", rate: 0.25 },
  { id: "mid35", label: "Gemiddeld (35%)", rate: 0.35 },
  { id: "high45", label: "Hoog (45%)", rate: 0.45 }
];

export const LIMITS = {
  taxRateMin: 0,
  taxRateMax: 0.6,
  hoursSoftMax: 400
};

export const PAYROLL_TAX = {
  periodFactors: {
    month: 12,
    fourWeeks: 13
  },
  brackets: [
    { upTo: 75518, rate: 0.3693 },
    { upTo: null, rate: 0.495 }
  ],
  credits: {
    general: {
      max: 3362,
      phaseOutStart: 24812,
      phaseOutRate: 0.0663
    },
    labor: {
      phaseInEnd: 11490,
      phaseInRate: 0.0823,
      max: 5532,
      plateauEnd: 37691,
      phaseOutRate: 0.065
    }
  }
};
