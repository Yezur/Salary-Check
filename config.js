export const DEFAULTS = {
  standbyRate: 1.6,
  mult150: 1.5,
  mult200: 2.0,
  taxPresetId: "mid35"
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
