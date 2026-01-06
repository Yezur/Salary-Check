import { DEFAULTS, TAX_PRESETS, LIMITS, PAYROLL_TAX } from './config.js';

const STORAGE_KEY = 'paycalc:v1';
const SAVE_DEBOUNCE_MS = 300;
const HOURS_PER_DAY = 8;
const COMPUTED_EARNINGS_TYPES = new Set(['salary', 'allowances']);
const EARNINGS_TYPE_LABELS = {
  salary: 'Salaris',
  holiday: 'Vakantiegeld',
  allowances: 'Toeslagen',
  twk: 'TWK'
};
const DEFAULT_EARNINGS_ITEMS = [
  { type: 'salary', amount: 0, taxable: true, sv: true, zvw: true },
  { type: 'holiday', amount: 0, taxable: true, sv: true, zvw: true },
  { type: 'allowances', amount: 0, taxable: true, sv: true, zvw: true },
  { type: 'twk', amount: 0, taxable: true, sv: true, zvw: true }
];

const currencyFormatter = new Intl.NumberFormat('nl-NL', {
  style: 'currency',
  currency: 'EUR'
});

const state = {
  period: 'month',
  currency: 'EUR',
  workedDays: 0,
  payroll: {
    period: DEFAULTS.payrollPeriod,
    hasLoonheffingskorting: DEFAULTS.hasLoonheffingskorting
  },
  rates: {
    base: 0,
    standby: DEFAULTS.standbyRate,
    mult150: DEFAULTS.mult150,
    mult200: DEFAULTS.mult200
  },
  hours: {
    normal: 0,
    ot150: 0,
    ot200: 0,
    standby: 0
  },
  earningsItems: DEFAULT_EARNINGS_ITEMS.map((item) => ({ ...item })),
  reimbursements: [],
  deductions: [],
  tax: {
    mode: 'preset',
    presetId: DEFAULTS.taxPresetId,
    rate: TAX_PRESETS.find((p) => p.id === DEFAULTS.taxPresetId)?.rate ?? 0.35
  }
};

let saveTimer = null;
let latestResult = null;

function parseNumber(value) {
  if (value === undefined || value === null) return 0;
  const normalized = String(value).replace(',', '.');
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeEarningsItems(items) {
  const byType = new Map(Array.isArray(items) ? items.map((item) => [item.type, item]) : []);
  return DEFAULT_EARNINGS_ITEMS.map((item) => {
    const saved = byType.get(item.type) || {};
    return {
      ...item,
      ...saved,
      amount: parseNumber(saved.amount ?? item.amount),
      taxable: saved.taxable ?? item.taxable,
      sv: saved.sv ?? item.sv,
      zvw: saved.zvw ?? item.zvw
    };
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(16).slice(2)}`;
}

function normalizeDeductions(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    id: item.id || getId(),
    label: item.label || 'Inhouding',
    amount: parseNumber(item.amount),
    type: item.type === 'percent' ? 'percent' : 'fixed',
    basis: item.basis || 'taxableWage'
  }));
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    mergeState(stored);
  } catch (err) {
    console.warn('Kon localStorage niet lezen', err);
  }
}

function mergeState(saved) {
  if (!saved || typeof saved !== 'object') return;
  if (typeof saved.workedDays === 'number') {
    state.workedDays = Math.max(0, saved.workedDays);
  }
  if (saved.payroll && typeof saved.payroll === 'object') {
    state.payroll = { ...state.payroll, ...saved.payroll };
    if (!PAYROLL_TAX.periodFactors[state.payroll.period]) {
      state.payroll.period = DEFAULTS.payrollPeriod;
    }
    state.payroll.hasLoonheffingskorting = Boolean(state.payroll.hasLoonheffingskorting);
  }
  state.rates = { ...state.rates, ...(saved.rates || {}) };
  state.hours = { ...state.hours, ...(saved.hours || {}) };
  state.reimbursements = Array.isArray(saved.reimbursements)
    ? saved.reimbursements.map((item) => normalizeReimbursement(item))
    : state.reimbursements;
  state.deductions = Array.isArray(saved.deductions) ? saved.deductions : state.deductions;
  state.tax = { ...state.tax, ...(saved.tax || {}) };
  state.tax.rate = clamp(state.tax.rate, LIMITS.taxRateMin, LIMITS.taxRateMax);
  if (state.workedDays > 0) {
    state.hours.normal = state.workedDays * HOURS_PER_DAY;
  }
  if (state.tax.mode === 'preset' && state.tax.presetId) {
    const preset = TAX_PRESETS.find((p) => p.id === state.tax.presetId) || TAX_PRESETS.find((p) => p.id === DEFAULTS.taxPresetId);
    state.tax.rate = preset.rate;
    state.tax.presetId = preset.id;
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, SAVE_DEBOUNCE_MS);
}

function formatCurrency(amount) {
  return currencyFormatter.format(amount);
}

function calculatePayrollTax({ taxableWage, period, hasLoonheffingskorting }) {
  const annualFactor = PAYROLL_TAX.periodFactors[period] ?? PAYROLL_TAX.periodFactors.month;
  const annualTaxableWage = taxableWage * annualFactor;

  let annualTax = 0;
  let previousLimit = 0;
  PAYROLL_TAX.brackets.forEach((bracket) => {
    const limit = bracket.upTo ?? Infinity;
    if (annualTaxableWage > previousLimit) {
      const taxableSlice = Math.min(annualTaxableWage, limit) - previousLimit;
      annualTax += taxableSlice * bracket.rate;
    }
    previousLimit = limit;
  });

  let annualCredits = 0;
  if (hasLoonheffingskorting) {
    const { general, labor } = PAYROLL_TAX.credits;
    const generalReduction = Math.max(0, (annualTaxableWage - general.phaseOutStart) * general.phaseOutRate);
    const generalCredit = Math.max(0, general.max - generalReduction);

    let laborCredit = 0;
    if (annualTaxableWage <= labor.phaseInEnd) {
      laborCredit = annualTaxableWage * labor.phaseInRate;
    } else if (annualTaxableWage <= labor.plateauEnd) {
      laborCredit = labor.max;
    } else {
      laborCredit = Math.max(0, labor.max - (annualTaxableWage - labor.plateauEnd) * labor.phaseOutRate);
    }

    annualCredits = Math.min(annualTax, generalCredit + laborCredit);
  }

  const annualNetTax = Math.max(0, annualTax - annualCredits);
  return annualNetTax / annualFactor;
}

function calculate(currentState) {
  const earningsItems = Array.isArray(currentState.earningsItems) ? currentState.earningsItems : [];
  const earningsTotal = earningsItems.reduce((sum, item) => sum + item.amount, 0);
  const reimbursementsTotal = currentState.reimbursements.reduce((sum, item) => sum + item.amount, 0);
  const wageBase = basePay + ot150Pay + ot200Pay + standbyPay;

  const taxableReimbursements = currentState.reimbursements
    .filter((item) => item.taxable)
    .reduce((sum, item) => sum + item.amount, 0);
  const svReimbursements = currentState.reimbursements
    .filter((item) => item.svWage)
    .reduce((sum, item) => sum + item.amount, 0);
  const zvwReimbursements = currentState.reimbursements
    .filter((item) => item.zvwWage)
    .reduce((sum, item) => sum + item.amount, 0);
  const nonTaxableReimbursements = reimbursementsTotal - taxableReimbursements;

  const baseWage = basePay + ot150Pay + ot200Pay + standbyPay;
  const grossTotal = basePay + ot150Pay + ot200Pay + standbyPay + reimbursementsTotal;
  const taxableWage = basePay + ot150Pay + ot200Pay + standbyPay + taxableReimbursements;
  const payrollSettings = currentState.payroll || {
    period: DEFAULTS.payrollPeriod,
    hasLoonheffingskorting: DEFAULTS.hasLoonheffingskorting
  };
  const estimatedTax = calculatePayrollTax({
    taxableWage,
    period: payrollSettings.period,
    hasLoonheffingskorting: payrollSettings.hasLoonheffingskorting
  });
  const otherDeductions = currentState.deductions.reduce((sum, item) => sum + item.amount, 0);
  const net = grossTotal - estimatedTax - otherDeductions;

  return {
    earnings: [
      ...earningsItems.map((item) => ({
        label: EARNINGS_TYPE_LABELS[item.type] || item.type,
        amount: item.amount
      })),
      { label: 'Vergoedingen', amount: reimbursementsTotal }
    ],
    deductions: [
      { label: 'Geschatte loonheffing', amount: estimatedTax },
      ...currentState.deductions.map((d) => ({ label: d.label, amount: d.amount }))
    ],
    deductionDetails,
    totals: {
      gross: grossTotal,
      taxable: taxableWage,
      svWage,
      zvwWage,
      est_tax: estimatedTax,
      net,
      non_taxable: nonTaxableReimbursements
    }
  };
}

function renderEarnings(lines) {
  const container = document.getElementById('earningsLines');
  container.innerHTML = '';
  lines.forEach((line) => {
    const row = document.createElement('div');
    row.className = 'line';
    row.innerHTML = `<span>${line.label}</span><strong>${formatCurrency(line.amount)}</strong>`;
    container.appendChild(row);
  });
}

function renderDeductions(lines) {
  const container = document.getElementById('deductionLines');
  container.innerHTML = '';
  lines.forEach((line) => {
    const row = document.createElement('div');
    row.className = 'line';
    row.innerHTML = `<span>${line.label}</span><strong>${formatCurrency(line.amount)}</strong>`;
    container.appendChild(row);
  });
}

function renderTotals(totals) {
  document.getElementById('totalsGross').textContent = formatCurrency(totals.gross);
  document.getElementById('totalsTaxable').textContent = formatCurrency(totals.taxable);
  document.getElementById('totalsSvWage').textContent = formatCurrency(totals.svWage);
  document.getElementById('totalsZvwWage').textContent = formatCurrency(totals.zvwWage);
  document.getElementById('totalsTax').textContent = formatCurrency(totals.est_tax);
  document.getElementById('totalsNet').textContent = formatCurrency(totals.net);
  document.getElementById('totalsNonTaxable').textContent = formatCurrency(totals.non_taxable);
}

function renderReimbursementsTable(items) {
  const body = document.getElementById('reimbursementsTableBody');
  body.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('tr');
    row.dataset.id = item.id;
    row.innerHTML = `
      <td><input type="text" value="${item.label}" data-field="label" aria-label="Label" /></td>
      <td><input type="number" step="0.01" value="${item.amount}" data-field="amount" aria-label="Bedrag" /></td>
      <td style="text-align:center"><input type="checkbox" data-field="taxable" ${item.taxable ? 'checked' : ''} aria-label="Belastbaar" /></td>
      <td style="text-align:center"><input type="checkbox" data-field="svWage" ${item.svWage ? 'checked' : ''} aria-label="SV-loon" /></td>
      <td style="text-align:center"><input type="checkbox" data-field="zvwWage" ${item.zvwWage ? 'checked' : ''} aria-label="Zvw-loon" /></td>
      <td class="actions"><button type="button" class="ghost" data-action="remove">✕</button></td>
    `;
    body.appendChild(row);
  });
}

function renderDeductionsTable(items, deductionDetails = []) {
  const body = document.getElementById('deductionsTableBody');
  body.innerHTML = '';
  const calculatedMap = new Map(deductionDetails.map((item) => [item.id, item.calculated]));
  items.forEach((item) => {
    const row = document.createElement('tr');
    row.dataset.id = item.id;
    const type = item.type === 'percent' ? 'percent' : 'fixed';
    const basis = item.basis || 'taxableWage';
    const calculated = calculatedMap.get(item.id);
    row.innerHTML = `
      <td><input type="text" value="${item.label}" data-field="label" aria-label="Label" /></td>
      <td>
        <select data-field="type" aria-label="Type">
          <option value="fixed" ${type === 'fixed' ? 'selected' : ''}>fixed</option>
          <option value="percent" ${type === 'percent' ? 'selected' : ''}>percent</option>
        </select>
      </td>
      <td><input type="number" step="0.01" value="${item.amount}" data-field="amount" aria-label="Bedrag of percentage" /></td>
      <td>
        <select data-field="basis" aria-label="Basis" ${type === 'percent' ? '' : 'disabled'}>
          <option value="taxableWage" ${basis === 'taxableWage' ? 'selected' : ''}>taxableWage</option>
          <option value="svWage" ${basis === 'svWage' ? 'selected' : ''}>svWage</option>
          <option value="zvwWage" ${basis === 'zvwWage' ? 'selected' : ''}>zvwWage</option>
        </select>
      </td>
      <td>${calculated === undefined ? '-' : formatCurrency(calculated)}</td>
      <td class="actions"><button type="button" class="ghost" data-action="remove">✕</button></td>
    `;
    body.appendChild(row);
  });
}

function renderTaxUI(tax) {
  const modeEl = document.getElementById('taxMode');
  const presetEl = document.getElementById('taxPreset');
  const customEl = document.getElementById('taxCustom');

  modeEl.value = tax.mode;
  presetEl.disabled = tax.mode !== 'preset';
  customEl.disabled = tax.mode !== 'custom';
  if (tax.mode === 'custom') {
    customEl.value = Math.round(tax.rate * 1000) / 10;
  } else {
    presetEl.value = tax.presetId || DEFAULTS.taxPresetId;
  }
}

function readTablesIntoState() {
  const earningsRows = document.querySelectorAll('#earningsItemsTableBody tr');
  state.earningsItems = Array.from(earningsRows).map((row) => {
    const type = row.dataset.type;
    const existing = state.earningsItems.find((item) => item.type === type) || DEFAULT_EARNINGS_ITEMS.find((item) => item.type === type);
    const amount = parseNumber(row.querySelector('[data-field="amount"]').value);
    const taxable = row.querySelector('[data-field="taxable"]').checked;
    const sv = row.querySelector('[data-field="sv"]').checked;
    const zvw = row.querySelector('[data-field="zvw"]').checked;
    return {
      type,
      amount: COMPUTED_EARNINGS_TYPES.has(type) && existing ? existing.amount : amount,
      taxable,
      sv,
      zvw
    };
  });

  const reimbRows = document.querySelectorAll('#reimbursementsTableBody tr');
  state.reimbursements = Array.from(reimbRows).map((row) => {
    const id = row.dataset.id || getId();
    const label = row.querySelector('[data-field="label"]').value || 'Vergoeding';
    const amount = parseNumber(row.querySelector('[data-field="amount"]').value);
    const taxable = row.querySelector('[data-field="taxable"]').checked;
    const svWage = row.querySelector('[data-field="svWage"]').checked;
    const zvwWage = row.querySelector('[data-field="zvwWage"]').checked;
    return { id, label, amount, taxable, svWage, zvwWage };
  });

  const deductRows = document.querySelectorAll('#deductionsTableBody tr');
  state.deductions = Array.from(deductRows).map((row) => {
    const id = row.dataset.id || getId();
    const label = row.querySelector('[data-field="label"]').value || 'Inhouding';
    const amount = parseNumber(row.querySelector('[data-field="amount"]').value);
    const type = row.querySelector('[data-field="type"]').value === 'percent' ? 'percent' : 'fixed';
    const basis = row.querySelector('[data-field="basis"]').value || 'taxableWage';
    return { id, label, amount, type, basis };
  });
}

function readFormIntoState() {
  state.rates.base = Math.max(0, parseNumber(document.getElementById('baseRate').value));
  state.rates.standby = Math.max(0, parseNumber(document.getElementById('standbyRate').value));
  state.rates.mult150 = clamp(parseNumber(document.getElementById('mult150').value) || DEFAULTS.mult150, 1, 5);
  state.rates.mult200 = clamp(parseNumber(document.getElementById('mult200').value) || DEFAULTS.mult200, 1, 5);

  const normalHoursInput = document.getElementById('hNormal');
  const workedDaysInput = document.getElementById('workedDays');
  const workedDaysRaw = workedDaysInput.value;
  const manualNormalHours = Math.max(0, parseNumber(normalHoursInput.value));
  state.workedDays = Math.max(0, parseNumber(workedDaysRaw));
  const normalFromDays = state.workedDays * HOURS_PER_DAY;

  if (workedDaysRaw !== '') {
    state.hours.normal = normalFromDays;
    normalHoursInput.value = state.hours.normal;
  } else {
    state.hours.normal = manualNormalHours;
  }
  state.hours.ot150 = Math.max(0, parseNumber(document.getElementById('h150').value));
  state.hours.ot200 = Math.max(0, parseNumber(document.getElementById('h200').value));
  state.hours.standby = Math.max(0, parseNumber(document.getElementById('hStandby').value));

  const modeEl = document.getElementById('taxMode');
  const presetEl = document.getElementById('taxPreset');
  const customEl = document.getElementById('taxCustom');
  state.tax.mode = modeEl.value === 'custom' ? 'custom' : 'preset';

  if (state.tax.mode === 'preset') {
    const preset = TAX_PRESETS.find((p) => p.id === presetEl.value) || TAX_PRESETS.find((p) => p.id === DEFAULTS.taxPresetId);
    state.tax.presetId = preset.id;
    state.tax.rate = preset.rate;
  } else {
    const customPercent = clamp(parseNumber(customEl.value), LIMITS.taxRateMin * 100, LIMITS.taxRateMax * 100);
    state.tax.rate = customPercent / 100;
    state.tax.presetId = null;
  }

  const basePay = state.hours.normal * state.rates.base;
  const ot150Pay = state.hours.ot150 * state.rates.base * state.rates.mult150;
  const ot200Pay = state.hours.ot200 * state.rates.base * state.rates.mult200;
  const standbyPay = state.hours.standby * state.rates.standby;
  const allowancesTotal = ot150Pay + ot200Pay + standbyPay;

  const earningsByType = new Map(state.earningsItems.map((item) => [item.type, item]));
  if (earningsByType.has('salary')) {
    earningsByType.get('salary').amount = basePay;
  }
  if (earningsByType.has('allowances')) {
    earningsByType.get('allowances').amount = allowancesTotal;
  }
  state.earningsItems = normalizeEarningsItems(Array.from(earningsByType.values()));

  readTablesIntoState();
  const payrollPeriod = document.querySelector('input[name="payrollPeriod"]:checked')?.value || DEFAULTS.payrollPeriod;
  state.payroll.period = payrollPeriod === 'fourWeeks' ? 'fourWeeks' : 'month';
  state.payroll.hasLoonheffingskorting = document.getElementById('loonheffingskortingToggle').checked;
  toggleHoursWarning();
}

function toggleHoursWarning() {
  const warning = document.getElementById('hoursWarning');
  const totalHours = state.hours.normal + state.hours.ot150 + state.hours.ot200 + state.hours.standby;
  const show = totalHours > LIMITS.hoursSoftMax;
  warning.hidden = !show;
}

function render(result) {
  renderEarnings(result.earnings);
  renderDeductions(result.deductions);
  renderTotals(result.totals);
  renderEarningsItemsTable(state.earningsItems);
  renderReimbursementsTable(state.reimbursements);
  renderDeductionsTable(state.deductions, result.deductionDetails);
  renderTaxUI(state.tax);
  document.querySelector(`input[name="payrollPeriod"][value="${state.payroll.period}"]`).checked = true;
  document.getElementById('loonheffingskortingToggle').checked = state.payroll.hasLoonheffingskorting;
}

function addReimbursement() {
  state.reimbursements.push({
    id: getId(),
    label: 'Representatie',
    amount: 0,
    taxable: false,
    svWage: false,
    zvwWage: false
  });
  renderReimbursementsTable(state.reimbursements);
}

function addDeduction() {
  state.deductions.push({ id: getId(), label: 'Inhouding', amount: 0, type: 'fixed', basis: 'taxableWage' });
  renderDeductionsTable(state.deductions);
}

function removeRow(event, tableSelector, collectionKey) {
  const btn = event.target.closest('[data-action="remove"]');
  if (!btn) return false;
  const row = btn.closest('tr');
  if (!row) return false;
  const id = row.dataset.id;
  state[collectionKey] = state[collectionKey].filter((item) => item.id !== id);
  row.remove();
  recalc();
  return true;
}

function recalc() {
  readFormIntoState();
  latestResult = calculate(state);
  render(latestResult);
  scheduleSave();
}

function exportCSV(result) {
  const periodLabel = state.payroll.period === 'fourWeeks' ? '4-weken' : 'Maand';
  const rows = [
    ['label', 'type', 'amount'],
    ...result.earnings.map((line) => [line.label, 'earning', line.amount.toFixed(2)]),
    ...result.deductions.map((line) => [line.label, 'deduction', line.amount.toFixed(2)]),
    ['Totaal bruto', 'total', result.totals.gross.toFixed(2)],
    ['Belastbaar loon', 'total', result.totals.taxable.toFixed(2)],
    ['Geschatte loonheffing', 'total', result.totals.est_tax.toFixed(2)],
    ['Netto indicatie', 'total', result.totals.net.toFixed(2)],
    ['Onbelaste vergoedingen', 'info', result.totals.non_taxable.toFixed(2)],
    ['Periode loonheffing', 'info', periodLabel],
    ['Loonheffingskorting toegepast', 'info', state.payroll.hasLoonheffingskorting ? 'Ja' : 'Nee'],
    ['Timestamp', 'meta', new Date().toISOString()]
  ];

  const csvContent = rows
    .map((r) => r.map((cell) => `"${String(cell).replace(/\"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'salarisindicatie.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function printPdf() {
  document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
  setTimeout(() => window.print(), 200);
}

function resetAll() {
  localStorage.removeItem(STORAGE_KEY);
  state.rates = {
    base: 0,
    standby: DEFAULTS.standbyRate,
    mult150: DEFAULTS.mult150,
    mult200: DEFAULTS.mult200
  };
  state.hours = { normal: 0, ot150: 0, ot200: 0, standby: 0 };
  state.workedDays = 0;
  state.earningsItems = DEFAULT_EARNINGS_ITEMS.map((item) => ({ ...item }));
  state.reimbursements = [];
  state.deductions = [];
  state.payroll = {
    period: DEFAULTS.payrollPeriod,
    hasLoonheffingskorting: DEFAULTS.hasLoonheffingskorting
  };
  state.tax = {
    mode: 'preset',
    presetId: DEFAULTS.taxPresetId,
    rate: TAX_PRESETS.find((p) => p.id === DEFAULTS.taxPresetId)?.rate ?? 0.35
  };
  hydrateForm();
  recalc();
}

function hydrateForm() {
  document.getElementById('baseRate').value = state.rates.base;
  document.getElementById('standbyRate').value = state.rates.standby;
  document.getElementById('mult150').value = state.rates.mult150;
  document.getElementById('mult200').value = state.rates.mult200;
  document.getElementById('workedDays').value = state.workedDays;
  const normalHours = state.workedDays > 0 ? state.workedDays * HOURS_PER_DAY : state.hours.normal;
  state.hours.normal = normalHours;
  document.getElementById('hNormal').value = normalHours;
  document.getElementById('h150').value = state.hours.ot150;
  document.getElementById('h200').value = state.hours.ot200;
  document.getElementById('hStandby').value = state.hours.standby;
  renderEarningsItemsTable(state.earningsItems);
  renderReimbursementsTable(state.reimbursements);
  renderDeductionsTable(state.deductions);
  renderTaxUI(state.tax);
  document.querySelector(`input[name="payrollPeriod"][value="${state.payroll.period}"]`).checked = true;
  document.getElementById('loonheffingskortingToggle').checked = state.payroll.hasLoonheffingskorting;
}

function populateTaxPresets() {
  const select = document.getElementById('taxPreset');
  TAX_PRESETS.forEach((preset) => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    select.appendChild(option);
  });
}

function attachEventListeners() {
  document.querySelectorAll('#baseRate, #standbyRate, #mult150, #mult200, #workedDays, #hNormal, #h150, #h200, #hStandby').forEach((el) => {
    el.addEventListener('input', recalc);
    el.addEventListener('change', recalc);
  });

  document.getElementById('earningsItemsTableBody').addEventListener('input', recalc);

  document.getElementById('taxMode').addEventListener('change', recalc);
  document.getElementById('taxPreset').addEventListener('change', recalc);
  document.getElementById('taxCustom').addEventListener('input', recalc);
  document.querySelectorAll('input[name="payrollPeriod"]').forEach((el) => {
    el.addEventListener('change', recalc);
  });
  document.getElementById('loonheffingskortingToggle').addEventListener('change', recalc);

  document.getElementById('addReimbursement').addEventListener('click', () => {
    addReimbursement();
    recalc();
  });
  document.getElementById('addDeduction').addEventListener('click', () => {
    addDeduction();
    recalc();
  });

  document.getElementById('reimbursementsTableBody').addEventListener('input', recalc);
  document.getElementById('deductionsTableBody').addEventListener('input', recalc);
  document.getElementById('reimbursementsTableBody').addEventListener('change', recalc);
  document.getElementById('deductionsTableBody').addEventListener('change', recalc);

  document.getElementById('reimbursementsTableBody').addEventListener('click', (e) => {
    if (removeRow(e, '#reimbursementsTableBody', 'reimbursements')) return;
  });
  document.getElementById('deductionsTableBody').addEventListener('click', (e) => {
    if (removeRow(e, '#deductionsTableBody', 'deductions')) return;
  });

  document.getElementById('downloadCsv').addEventListener('click', () => {
    recalc();
    if (latestResult) exportCSV(latestResult);
  });
  document.getElementById('printPdf').addEventListener('click', () => {
    recalc();
    printPdf();
  });
  document.getElementById('resetForm').addEventListener('click', resetAll);
}

function runSelfTests() {
  const exampleState = {
    earningsItems: [
      { type: 'salary', amount: 3200, taxable: true, sv: true, zvw: true },
      { type: 'holiday', amount: 300, taxable: true, sv: true, zvw: true },
      { type: 'allowances', amount: 250, taxable: true, sv: true, zvw: true },
      { type: 'twk', amount: 120, taxable: true, sv: true, zvw: true }
    ],
    reimbursements: [
      { id: 'a', label: 'Reiskosten', amount: 50, taxable: false, svWage: false, zvwWage: false },
      { id: 'b', label: 'Bonus', amount: 100, taxable: true, svWage: true, zvwWage: true }
    ],
    deductions: [{ id: 'c', label: 'Pensioen', amount: 80 }],
    payroll: { period: 'month', hasLoonheffingskorting: true }
  };
  const result = calculate(exampleState);
  const expectedGross = (160 * 20) + (10 * 20 * 1.5) + (5 * 20 * 2) + (8 * 2) + 150;
  const expectedTaxable = (160 * 20) + (10 * 20 * 1.5) + (5 * 20 * 2) + 100 + (8 * 2);
  const expectedTax = calculatePayrollTax({
    taxableWage: expectedTaxable,
    period: exampleState.payroll.period,
    hasLoonheffingskorting: exampleState.payroll.hasLoonheffingskorting
  });
  const expectedNet = expectedGross - expectedTax - 80;
  const allGood = Math.abs(result.totals.gross - expectedGross) < 0.001 &&
    Math.abs(result.totals.taxable - expectedTaxable) < 0.001 &&
    Math.abs(result.totals.net - expectedNet) < 0.001;
  if (!allGood) {
    console.error('Selftest failed', { result, expectedGross, expectedTaxable, expectedNet });
  } else {
    console.info('Selftest ok');
  }
}

function init() {
  populateTaxPresets();
  loadFromStorage();
  hydrateForm();
  attachEventListeners();
  recalc();
  runSelfTests();
}

document.addEventListener('DOMContentLoaded', init);
