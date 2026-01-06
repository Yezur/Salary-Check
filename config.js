export const DEFAULTS = {
  standbyRate: 1.6,
  mult150: 1.5,
  mult200: 2.0,
  contractHours: 160,
  taxPresetId: "rate3582",
  payrollPeriod: "month",
  hasLoonheffingskorting: true
};

export const TAX_PRESETS = [
  { id: "rate3582", label: "35,82%", rate: 0.3582 },
  { id: "rate3748", label: "37,48%", rate: 0.3748 },
  { id: "rate4950", label: "49,50%", rate: 0.495 }
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
