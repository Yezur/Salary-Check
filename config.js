export const DEFAULTS = {
  standbyRate: 1.6,
  mult150: 1.5,
  mult200: 2.0,
  hourlyRate: 0,
  contractHours: 160,
  taxPresetId: "rate3582"
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
