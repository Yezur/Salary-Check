import { DEFAULTS, TAX_PRESETS, LIMITS } from './config.js';

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
  state.rates = { ...state.rates, ...(saved.rates || {}) };
  state.hours = { ...state.hours, ...(saved.hours || {}) };
  state.earningsItems = normalizeEarningsItems(saved.earningsItems);
  state.reimbursements = Array.isArray(saved.reimbursements) ? saved.reimbursements : state.reimbursements;
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

function calculate(currentState) {
  const earningsItems = Array.isArray(currentState.earningsItems) ? currentState.earningsItems : [];
  const earningsTotal = earningsItems.reduce((sum, item) => sum + item.amount, 0);
  const reimbursementsTotal = currentState.reimbursements.reduce((sum, item) => sum + item.amount, 0);
  const taxableEarnings = earningsItems
    .filter((item) => item.taxable)
    .reduce((sum, item) => sum + item.amount, 0);

  const taxableReimbursements = currentState.reimbursements
    .filter((item) => item.taxable)
    .reduce((sum, item) => sum + item.amount, 0);
  const nonTaxableReimbursements = reimbursementsTotal - taxableReimbursements;

  const grossTotal = earningsTotal + reimbursementsTotal;
  const taxableWage = taxableEarnings + taxableReimbursements;
  const estimatedTax = taxableWage * currentState.tax.rate;
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
      { label: `Geschatte belasting (${Math.round(currentState.tax.rate * 1000) / 10}%)`, amount: estimatedTax },
      ...currentState.deductions.map((d) => ({ label: d.label, amount: d.amount }))
    ],
    totals: {
      gross: grossTotal,
      taxable: taxableWage,
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
      <td class="actions"><button type="button" class="ghost" data-action="remove">✕</button></td>
    `;
    body.appendChild(row);
  });
}

function renderEarningsItemsTable(items) {
  const body = document.getElementById('earningsItemsTableBody');
  body.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('tr');
    row.dataset.type = item.type;
    const isComputed = COMPUTED_EARNINGS_TYPES.has(item.type);
    row.innerHTML = `
      <td>${EARNINGS_TYPE_LABELS[item.type] || item.type}</td>
      <td><input type="number" step="0.01" value="${item.amount}" data-field="amount" aria-label="Bedrag ${EARNINGS_TYPE_LABELS[item.type] || item.type}" ${isComputed ? 'readonly' : ''} /></td>
      <td style="text-align:center"><input type="checkbox" data-field="taxable" ${item.taxable ? 'checked' : ''} aria-label="Belastbaar ${EARNINGS_TYPE_LABELS[item.type] || item.type}" /></td>
      <td style="text-align:center"><input type="checkbox" data-field="sv" ${item.sv ? 'checked' : ''} aria-label="SV ${EARNINGS_TYPE_LABELS[item.type] || item.type}" /></td>
      <td style="text-align:center"><input type="checkbox" data-field="zvw" ${item.zvw ? 'checked' : ''} aria-label="ZVW ${EARNINGS_TYPE_LABELS[item.type] || item.type}" /></td>
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
    return { id, label, amount, taxable };
  });

  const deductRows = document.querySelectorAll('#deductionsTableBody tr');
  state.deductions = Array.from(deductRows).map((row) => {
    const id = row.dataset.id || getId();
    const label = row.querySelector('[data-field="label"]').value || 'Inhouding';
    const amount = parseNumber(row.querySelector('[data-field="amount"]').value);
    return { id, label, amount };
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
  renderDeductionsTable(state.deductions);
  renderTaxUI(state.tax);
}

function addReimbursement() {
  state.reimbursements.push({ id: getId(), label: 'Representatie', amount: 0, taxable: false });
  renderReimbursementsTable(state.reimbursements);
}

function addDeduction() {
  state.deductions.push({ id: getId(), label: 'Inhouding', amount: 0 });
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
  const rows = [
    ['label', 'type', 'amount'],
    ...result.earnings.map((line) => [line.label, 'earning', line.amount.toFixed(2)]),
    ...result.deductions.map((line) => [line.label, 'deduction', line.amount.toFixed(2)]),
    ['Totaal bruto', 'total', result.totals.gross.toFixed(2)],
    ['Belastbaar loon', 'total', result.totals.taxable.toFixed(2)],
    ['Geschatte belasting', 'total', result.totals.est_tax.toFixed(2)],
    ['Netto indicatie', 'total', result.totals.net.toFixed(2)],
    ['Onbelaste vergoedingen', 'info', result.totals.non_taxable.toFixed(2)],
    ['Belastingtarief', 'info', (state.tax.rate * 100).toFixed(1) + '%'],
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
      { id: 'a', label: 'Reiskosten', amount: 50, taxable: false },
      { id: 'b', label: 'Bonus', amount: 100, taxable: true }
    ],
    deductions: [{ id: 'c', label: 'Pensioen', amount: 80 }],
    tax: { rate: 0.35 }
  };
  const result = calculate(exampleState);
  const expectedGross = 3200 + 300 + 250 + 120 + 150;
  const expectedTaxable = 3200 + 300 + 250 + 120 + 100;
  const expectedTax = expectedTaxable * 0.35;
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
