import { DEFAULTS, TAX_PRESETS, LIMITS } from './config.js';

const STORAGE_KEY = 'paycalc:v1';
const SAVE_DEBOUNCE_MS = 300;
const HOURS_PER_DAY = 8;
const OVERTIME_TAX_RATE = 0.5033;

const currencyFormatter = new Intl.NumberFormat('nl-NL', {
  style: 'currency',
  currency: 'EUR'
});

const state = {
  period: 'month',
  currency: 'EUR',
  workedDays: 0,
  salary: {
    monthly: 0,
    hourly: DEFAULTS.hourlyRate
  },
  rates: {
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
    taxable: Boolean(item.taxable)
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
  if (saved.salary && typeof saved.salary === 'object') {
    state.salary = { ...state.salary, ...saved.salary };
  }
  state.salary.monthly = Math.max(0, parseNumber(state.salary.monthly));
  state.salary.hourly = Math.max(0, parseNumber(state.salary.hourly));
  state.rates = { ...state.rates, ...(saved.rates || {}) };
  state.hours = { ...state.hours, ...(saved.hours || {}) };
  state.reimbursements = Array.isArray(saved.reimbursements)
    ? saved.reimbursements.map((item) => normalizeReimbursement(item))
    : state.reimbursements;
  state.deductions = Array.isArray(saved.deductions) ? normalizeDeductions(saved.deductions) : state.deductions;
  state.tax = { ...state.tax, ...(saved.tax || {}) };
  state.tax.rate = clamp(state.tax.rate, LIMITS.taxRateMin, LIMITS.taxRateMax);
  state.tax.mode = state.tax.mode === 'custom' ? 'custom' : 'preset';
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

const hoursFormatter = new Intl.NumberFormat('nl-NL', {
  maximumFractionDigits: 1
});

function formatHours(value) {
  return hoursFormatter.format(value);
}

function calculateEstimatedTax(currentState, taxableWage) {
  const tax = currentState.tax ?? {};
  const mode = tax.mode === 'custom' ? 'custom' : 'preset';
  if (mode === 'custom') {
    const rate = clamp(parseNumber(tax.rate), LIMITS.taxRateMin, LIMITS.taxRateMax);
    return taxableWage * rate;
  }
  const preset = TAX_PRESETS.find((p) => p.id === tax.presetId) || TAX_PRESETS.find((p) => p.id === DEFAULTS.taxPresetId);
  const rate = clamp(parseNumber(preset?.rate ?? tax.rate), LIMITS.taxRateMin, LIMITS.taxRateMax);
  return taxableWage * rate;
}

function calculate(currentState) {
  const monthlySalary = parseNumber(currentState.salary?.monthly);
  const hourlyRate = parseNumber(currentState.salary?.hourly);
  const baseHourly = hourlyRate;
  const basePay = monthlySalary;
  const ot150Pay = currentState.hours.ot150 * baseHourly * currentState.rates.mult150;
  const ot200Pay = currentState.hours.ot200 * baseHourly * currentState.rates.mult200;
  const standbyPay = currentState.hours.standby * currentState.rates.standby;
  const reimbursementsTotal = currentState.reimbursements.reduce((sum, item) => sum + item.amount, 0);
  const wageBase = basePay + ot150Pay + ot200Pay + standbyPay;

  const taxableReimbursements = currentState.reimbursements
    .filter((item) => item.taxable)
    .reduce((sum, item) => sum + item.amount, 0);
  const nonTaxableReimbursements = reimbursementsTotal - taxableReimbursements;
  const deductionsTotal = currentState.deductions.reduce((sum, item) => sum + item.amount, 0);
  const taxableDeductions = currentState.deductions
    .filter((item) => item.taxable)
    .reduce((sum, item) => sum + item.amount, 0);

  const overtimePay = ot150Pay + ot200Pay;
  const baseWage = basePay + ot150Pay + ot200Pay + standbyPay;
  const grossTotal = basePay + ot150Pay + ot200Pay + standbyPay + reimbursementsTotal;
  const baseTaxableWage = basePay + taxableReimbursements;
  const taxableWage = Math.max(0, baseTaxableWage - taxableDeductions);
  const baseTax = calculateEstimatedTax(currentState, taxableWage);
  const overtimeTax = (ot150Pay + ot200Pay) * 0.5033;
  const estimatedTax = baseTax + overtimeTax;
  const net = grossTotal - estimatedTax - deductionsTotal;
  const earnings = [
      { label: 'Maandsalaris', amount: basePay },
      { label: 'Overwerk 150%', amount: ot150Pay },
      { label: 'Overwerk 200%', amount: ot200Pay },
      { label: 'Standby', amount: standbyPay },
      { label: 'Vergoedingen', amount: reimbursementsTotal }
    ];
  const deductions = [
      { label: 'Loonheffing (basis)', amount: baseTax },
      { label: 'Belasting overuren 50,33%', amount: overtimeTax },
      ...currentState.deductions.map((d) => ({ label: d.label, amount: d.amount }))
    ];
  const totalEarnings = earnings.reduce((sum, line) => sum + line.amount, 0);
  const totalDeductions = deductions.reduce((sum, line) => sum + line.amount, 0);

  return {
    earnings,
    deductions,
    totals: {
      earnings: totalEarnings,
      deductions: totalDeductions,
      gross: grossTotal,
      taxable: taxableWage,
      base_tax: baseTax,
      overtime_tax: overtimeTax,
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
  document.getElementById('totalsEarnings').textContent = formatCurrency(totals.earnings);
  document.getElementById('totalsDeductions').textContent = formatCurrency(totals.deductions);
  document.getElementById('totalsGross').textContent = formatCurrency(totals.gross);
  document.getElementById('totalsTaxable').textContent = formatCurrency(totals.taxable);
  document.getElementById('totalsBaseTax').textContent = formatCurrency(totals.base_tax);
  document.getElementById('totalsOvertimeTax').textContent = formatCurrency(totals.overtime_tax);
  document.getElementById('totalsTax').textContent = formatCurrency(totals.est_tax);
  document.getElementById('totalsNet').textContent = formatCurrency(totals.net);
  document.getElementById('totalsNonTaxable').textContent = formatCurrency(totals.non_taxable);
}

function renderHoursSummary(hours, workedDays) {
  document.getElementById('summaryWorkedDays').textContent = formatHours(workedDays);
  document.getElementById('summaryNormalHours').textContent = formatHours(hours.normal);
  document.getElementById('summaryOvertime150').textContent = formatHours(hours.ot150);
  document.getElementById('summaryOvertime200').textContent = formatHours(hours.ot200);
  document.getElementById('summaryStandbyHours').textContent = formatHours(hours.standby);
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
      <td class="actions"><button type="button" class="ghost" data-action="remove">✕</button></td>
    `;
    body.appendChild(row);
  });
}

function renderDeductionsTable(items) {
  const body = document.getElementById('deductionsTableBody');
  body.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('tr');
    row.dataset.id = item.id;
    row.innerHTML = `
      <td><input type="text" value="${item.label}" data-field="label" aria-label="Label" /></td>
      <td><input type="number" step="0.01" value="${item.amount}" data-field="amount" aria-label="Bedrag" /></td>
      <td style="text-align:center"><input type="checkbox" data-field="taxable" ${item.taxable ? 'checked' : ''} aria-label="Belastbaar" /></td>
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
  const reimbRows = document.querySelectorAll('#reimbursementsTableBody tr');
  state.reimbursements = Array.from(reimbRows).map((row) => {
    const id = row.dataset.id || getId();
    const label = row.querySelector('[data-field="label"]').value || 'Vergoeding';
    const amount = parseNumber(row.querySelector('[data-field="amount"]').value);
    const taxable = row.querySelector('[data-field="taxable"]').checked;
    return { id, label, amount, taxable };
  });

  const deductRows = document.querySelectorAll('#deductionsTableBody tr');
  state.deductions = Array.from(deductRows).map((row) => {
    const id = row.dataset.id || getId();
    const label = row.querySelector('[data-field="label"]').value || 'Inhouding';
    const amount = parseNumber(row.querySelector('[data-field="amount"]').value);
    const taxable = row.querySelector('[data-field="taxable"]').checked;
    return { id, label, amount, taxable };
  });
}

function readFormIntoState() {
  state.salary.monthly = Math.max(0, parseNumber(document.getElementById('salaryMonthly').value));
  state.salary.hourly = Math.max(0, parseNumber(document.getElementById('hourlyRate').value));
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

  readTablesIntoState();
  toggleHoursWarning();
}

function toggleHoursWarning() {
  const warning = document.getElementById('hoursWarning');
  const totalHours = state.hours.normal + state.hours.ot150 + state.hours.ot200 + state.hours.standby;
  const show = totalHours > LIMITS.hoursSoftMax;
  warning.hidden = !show;
}

function render(result, options = {}) {
  const { skipReimbursementsTable = false, skipDeductionsTable = false } = options;
  renderEarnings(result.earnings);
  renderDeductions(result.deductions);
  renderTotals(result.totals);
  renderHoursSummary(state.hours, state.workedDays);
  if (!skipReimbursementsTable) {
    renderReimbursementsTable(state.reimbursements);
  }
  if (!skipDeductionsTable) {
    renderDeductionsTable(state.deductions);
  }
  renderTaxUI(state.tax);
}

function addReimbursement() {
  state.reimbursements.push({
    id: getId(),
    label: 'Representatie',
    amount: 0,
    taxable: false
  });
  renderReimbursementsTable(state.reimbursements);
}

function addDeduction() {
  state.deductions.push({ id: getId(), label: 'Inhouding', amount: 0, taxable: false });
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
  const activeElement = document.activeElement;
  const reimbursementsBody = document.getElementById('reimbursementsTableBody');
  const deductionsBody = document.getElementById('deductionsTableBody');
  const skipReimbursementsTable = reimbursementsBody?.contains(activeElement) ?? false;
  const skipDeductionsTable = deductionsBody?.contains(activeElement) ?? false;
  readFormIntoState();
  latestResult = calculate(state);
  render(latestResult, { skipReimbursementsTable, skipDeductionsTable });
  scheduleSave();
}

function exportCSV(result) {
  const rows = [
    ['label', 'type', 'amount'],
    ...result.earnings.map((line) => [line.label, 'earning', line.amount.toFixed(2)]),
    ...result.deductions.map((line) => [line.label, 'deduction', line.amount.toFixed(2)]),
    ['Totaal betalingen', 'total', result.totals.earnings.toFixed(2)],
    ['Totaal inhoudingen', 'total', result.totals.deductions.toFixed(2)],
    ['Totaal bruto', 'total', result.totals.gross.toFixed(2)],
    ['Belastbaar loon', 'total', result.totals.taxable.toFixed(2)],
    ['Loonheffing (basis)', 'total', result.totals.base_tax.toFixed(2)],
    ['Belasting overuren 50,33%', 'total', result.totals.overtime_tax.toFixed(2)],
    ['Totaal loonheffing', 'total', result.totals.est_tax.toFixed(2)],
    ['Netto indicatie', 'total', result.totals.net.toFixed(2)],
    ['Onbelaste vergoedingen', 'info', result.totals.non_taxable.toFixed(2)],
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
  state.salary = {
    monthly: 0,
    hourly: DEFAULTS.hourlyRate
  };
  state.rates = {
    standby: DEFAULTS.standbyRate,
    mult150: DEFAULTS.mult150,
    mult200: DEFAULTS.mult200
  };
  state.hours = { normal: 0, ot150: 0, ot200: 0, standby: 0 };
  state.workedDays = 0;
  state.reimbursements = [];
  state.deductions = [];
  state.tax = {
    mode: 'preset',
    presetId: DEFAULTS.taxPresetId,
    rate: TAX_PRESETS.find((p) => p.id === DEFAULTS.taxPresetId)?.rate ?? 0.35
  };
  hydrateForm();
  recalc();
}

function hydrateForm() {
  document.getElementById('salaryMonthly').value = state.salary.monthly;
  document.getElementById('hourlyRate').value = state.salary.hourly;
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
  renderReimbursementsTable(state.reimbursements);
  renderDeductionsTable(state.deductions);
  renderTaxUI(state.tax);
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
  document.querySelectorAll('#salaryMonthly, #hourlyRate, #standbyRate, #mult150, #mult200, #workedDays, #hNormal, #h150, #h200, #hStandby').forEach((el) => {
    el.addEventListener('input', recalc);
    el.addEventListener('change', recalc);
  });

  document.getElementById('taxMode').addEventListener('change', recalc);
  document.getElementById('taxMode').addEventListener('input', recalc);
  document.getElementById('taxPreset').addEventListener('change', recalc);
  document.getElementById('taxPreset').addEventListener('input', recalc);
  document.getElementById('taxCustom').addEventListener('input', recalc);

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
    salary: { monthly: 3200, hourly: 0 },
    rates: { standby: 2, mult150: 1.5, mult200: 2 },
    hours: { normal: 160, ot150: 10, ot200: 5, standby: 8 },
    reimbursements: [
      { id: 'a', label: 'Reiskosten', amount: 50, taxable: false },
      { id: 'b', label: 'Bonus', amount: 100, taxable: true }
    ],
    deductions: [{ id: 'c', label: 'Pensioen', amount: 80 }],
    tax: { mode: 'preset', presetId: DEFAULTS.taxPresetId }
  };
  const result = calculate(exampleState);
  const expectedGross = 3200 + (10 * 20 * 1.5) + (5 * 20 * 2) + (8 * 2) + 150;
  const expectedTaxable = 3200 + 100;
  const expectedTaxRate = TAX_PRESETS.find((p) => p.id === DEFAULTS.taxPresetId).rate;
  const expectedOvertimeTax = ((10 * 20 * 1.5) + (5 * 20 * 2)) * 0.5033;
  const expectedTax = (expectedTaxable * expectedTaxRate) + expectedOvertimeTax;
  const expectedNet = expectedGross - expectedTax - 80;
  const hourlyState = {
    salary: { monthly: 0, hourly: 20 },
    rates: { standby: 2, mult150: 1.5, mult200: 2 },
    hours: { normal: 150, ot150: 6, ot200: 4, standby: 3 },
    reimbursements: [],
    deductions: [],
    tax: { mode: 'preset', presetId: DEFAULTS.taxPresetId }
  };
  const hourlyResult = calculate(hourlyState);
  const hourlyExpectedGross = (6 * 20 * 1.5) + (4 * 20 * 2) + (3 * 2);
  const hourlyExpectedTaxable = 0;
  const hourlyExpectedOvertimeTax = ((6 * 20 * 1.5) + (4 * 20 * 2)) * 0.5033;
  const hourlyExpectedTax = (hourlyExpectedTaxable * expectedTaxRate) + hourlyExpectedOvertimeTax;
  const hourlyExpectedNet = hourlyExpectedGross - hourlyExpectedTax;
  const allGood = Math.abs(result.totals.gross - expectedGross) < 0.001 &&
    Math.abs(result.totals.taxable - expectedTaxable) < 0.001 &&
    Math.abs(result.totals.net - expectedNet) < 0.001 &&
    Math.abs(hourlyResult.totals.gross - hourlyExpectedGross) < 0.001 &&
    Math.abs(hourlyResult.totals.taxable - hourlyExpectedTaxable) < 0.001 &&
    Math.abs(hourlyResult.totals.net - hourlyExpectedNet) < 0.001;
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
