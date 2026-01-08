import { DEFAULTS, LIMITS } from './config.js';

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
  deductions: []
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
    taxableRate: clamp(parseNumber(item.taxableRate), 0, 100)
  }));
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    mergeState(stored);
    const legacyKeys = ['workedDays', 'salary', 'hours', 'reimbursements', 'deductions'];
    const hasLegacyPayload = legacyKeys.some((key) => key in stored);
    if (hasLegacyPayload) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(getPersistedState()));
    }
  } catch (err) {
    console.warn('Kon localStorage niet lezen', err);
  }
}

function mergeState(saved) {
  if (!saved || typeof saved !== 'object') return;
  state.rates = sanitizeRates(saved.rates);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(getPersistedState()));
  }, SAVE_DEBOUNCE_MS);
}

function sanitizeRates(rates) {
  const safeRates = { ...state.rates };
  if (!rates || typeof rates !== 'object') return safeRates;
  if ('standby' in rates) {
    safeRates.standby = Math.max(0, parseNumber(rates.standby));
  }
  if ('mult150' in rates) {
    safeRates.mult150 = clamp(parseNumber(rates.mult150) || DEFAULTS.mult150, 1, 5);
  }
  if ('mult200' in rates) {
    safeRates.mult200 = clamp(parseNumber(rates.mult200) || DEFAULTS.mult200, 1, 5);
  }
  return safeRates;
}

function getPersistedState() {
  return {
    rates: sanitizeRates(state.rates)
  };
}

function resetTransientState() {
  state.salary.hourly = DEFAULTS.hourlyRate;
  state.workedDays = 0;
  state.hours = { normal: 0, ot150: 0, ot200: 0, standby: 0 };
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

function calculate(currentState) {
  const hourlyRate = parseNumber(currentState.salary?.hourly);
  const baseHourly = hourlyRate;
  const ot150Pay = currentState.hours.ot150 * baseHourly * currentState.rates.mult150;
  const ot200Pay = currentState.hours.ot200 * baseHourly * currentState.rates.mult200;
  const standbyPay = currentState.hours.standby * currentState.rates.standby;
  const reimbursementsTotal = currentState.reimbursements.reduce((sum, item) => sum + item.amount, 0);
  const wageBase = ot150Pay + ot200Pay + standbyPay;

  const taxableReimbursements = currentState.reimbursements
    .reduce((sum, item) => sum + (item.amount * (parseNumber(item.taxableRate) / 100)), 0);
  const nonTaxableReimbursements = reimbursementsTotal - taxableReimbursements;
  const deductionsTotal = currentState.deductions.reduce((sum, item) => sum + item.amount, 0);
  const taxableDeductions = currentState.deductions
    .reduce((sum, item) => sum + (item.amount * (parseNumber(item.taxableRate) / 100)), 0);

  const grossTotal = wageBase + reimbursementsTotal;
  const taxableWage = Math.max(0, taxableReimbursements - taxableDeductions);
  const overtimeTax = (ot150Pay + ot200Pay) * OVERTIME_TAX_RATE;
  const earnings = [
      { label: 'Overwerk 150%', amount: ot150Pay },
      { label: 'Overwerk 200%', amount: ot200Pay },
      { label: 'Standby', amount: standbyPay },
      { label: 'Vergoedingen', amount: reimbursementsTotal }
    ];
  const deductions = [
      { label: 'Belasting overuren 50,33%', amount: overtimeTax },
      ...currentState.deductions.map((d) => ({ label: d.label, amount: d.amount }))
    ];
  const totalEarnings = wageBase;
  const totalDeductions = deductions.reduce((sum, line) => sum + line.amount, 0);
  const netTotal = grossTotal - totalDeductions;

  return {
    earnings,
    deductions,
    totals: {
      earnings: totalEarnings,
      reimbursements: reimbursementsTotal,
      deductions: totalDeductions,
      gross: grossTotal,
      net: netTotal,
      taxable: taxableWage,
      overtime_tax: overtimeTax,
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
  document.getElementById('totalsReimbursements').textContent = formatCurrency(totals.reimbursements);
  document.getElementById('totalsDeductions').textContent = formatCurrency(totals.deductions);
  document.getElementById('totalsGross').textContent = formatCurrency(totals.gross);
  document.getElementById('totalsNet').textContent = formatCurrency(totals.net);
  document.getElementById('totalsOvertimeTax').textContent = formatCurrency(totals.overtime_tax);
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
      <td><input type="number" min="0" max="100" step="0.1" value="${item.taxableRate ?? 0}" data-field="taxableRate" aria-label="Belastbaar percentage" /></td>
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
      <td><input type="number" min="0" max="100" step="0.1" value="${item.taxableRate ?? 0}" data-field="taxableRate" aria-label="Belastbaar percentage" /></td>
      <td class="actions"><button type="button" class="ghost" data-action="remove">✕</button></td>
    `;
    body.appendChild(row);
  });
}

function readTablesIntoState() {
  const reimbRows = document.querySelectorAll('#reimbursementsTableBody tr');
  state.reimbursements = Array.from(reimbRows).map((row) => {
    const id = row.dataset.id || getId();
    const label = row.querySelector('[data-field="label"]').value || 'Vergoeding';
    const amount = parseNumber(row.querySelector('[data-field="amount"]').value);
    const taxableRate = clamp(parseNumber(row.querySelector('[data-field="taxableRate"]').value), 0, 100);
    return { id, label, amount, taxableRate };
  });

  const deductRows = document.querySelectorAll('#deductionsTableBody tr');
  state.deductions = Array.from(deductRows).map((row) => {
    const id = row.dataset.id || getId();
    const label = row.querySelector('[data-field="label"]').value || 'Inhouding';
    const amount = parseNumber(row.querySelector('[data-field="amount"]').value);
    const taxableRate = clamp(parseNumber(row.querySelector('[data-field="taxableRate"]').value), 0, 100);
    return { id, label, amount, taxableRate };
  });
}

function readFormIntoState() {
  state.salary.hourly = Math.max(0, parseNumber(document.getElementById('hourlyRate').value));
  state.rates.standby = Math.max(0, parseNumber(document.getElementById('standbyRate').value));
  state.rates.mult150 = clamp(parseNumber(document.getElementById('mult150').value) || DEFAULTS.mult150, 1, 5);
  state.rates.mult200 = clamp(parseNumber(document.getElementById('mult200').value) || DEFAULTS.mult200, 1, 5);

  const normalHoursInput = document.getElementById('hNormal');
  const workedDaysInput = document.getElementById('workedDays');

  if (normalHoursInput && workedDaysInput) {
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
  }
  state.hours.ot150 = Math.max(0, parseNumber(document.getElementById('h150').value));
  state.hours.ot200 = Math.max(0, parseNumber(document.getElementById('h200').value));
  state.hours.standby = Math.max(0, parseNumber(document.getElementById('hStandby').value));

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
}

function addReimbursement() {
  state.reimbursements.push({
    id: getId(),
    label: 'Representatie',
    amount: 0,
    taxableRate: 0
  });
  renderReimbursementsTable(state.reimbursements);
}

function addDeduction() {
  state.deductions.push({ id: getId(), label: 'Inhouding', amount: 0, taxableRate: 0 });
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
  const exportState = { ...state, salary: { ...state.salary, monthly: 0 } };
  const exportResult = calculate(exportState);
  const exportEarnings = exportResult.earnings.filter((line) => line.label !== 'Maandsalaris');
  const rows = [
    ['label', 'type', 'amount'],
    ...exportEarnings.map((line) => [line.label, 'earning', line.amount.toFixed(2)]),
    ...exportResult.deductions.map((line) => [line.label, 'deduction', line.amount.toFixed(2)]),
    ['Totaal betalingen', 'total', exportResult.totals.earnings.toFixed(2)],
    ['Totaal vergoedingen', 'total', exportResult.totals.reimbursements.toFixed(2)],
    ['Totaal inhoudingen', 'total', exportResult.totals.deductions.toFixed(2)],
    ['Totaal bruto', 'total', exportResult.totals.gross.toFixed(2)],
    ['Totaal netto', 'total', exportResult.totals.net.toFixed(2)],
    ['Belasting overuren 50,33%', 'total', exportResult.totals.overtime_tax.toFixed(2)],
    ['Onbelaste vergoedingen', 'info', exportResult.totals.non_taxable.toFixed(2)],
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
  hydrateForm();
  recalc();
}

function hydrateForm() {
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
}

function attachEventListeners() {
  document.querySelectorAll('#hourlyRate, #standbyRate, #mult150, #mult200, #workedDays, #hNormal, #h150, #h200, #hStandby').forEach((el) => {
    el.addEventListener('input', recalc);
    el.addEventListener('change', recalc);
  });

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
    salary: { hourly: 20 },
    rates: { standby: 2, mult150: 1.5, mult200: 2 },
    hours: { normal: 0, ot150: 10, ot200: 5, standby: 8 },
    reimbursements: [
      { id: 'a', label: 'Reiskosten', amount: 50, taxableRate: 0 },
      { id: 'b', label: 'Bonus', amount: 100, taxableRate: 100 }
    ],
    deductions: [{ id: 'c', label: 'Pensioen', amount: 80, taxableRate: 0 }]
  };
  const result = calculate(exampleState);
  const expectedGross = (10 * 20 * 1.5) + (5 * 20 * 2) + (8 * 2) + 150;
  const expectedTaxable = 100;
  const expectedOvertimeTax = ((10 * 20 * 1.5) + (5 * 20 * 2)) * OVERTIME_TAX_RATE;
  const expectedDeductionsTotal = expectedOvertimeTax + 80;
  const expectedNet = expectedGross - expectedDeductionsTotal;
  const hourlyState = {
    salary: { hourly: 20 },
    rates: { standby: 2, mult150: 1.5, mult200: 2 },
    hours: { normal: 150, ot150: 6, ot200: 4, standby: 3 },
    reimbursements: [],
    deductions: []
  };
  const hourlyResult = calculate(hourlyState);
  const hourlyExpectedGross = (6 * 20 * 1.5) + (4 * 20 * 2) + (3 * 2);
  const hourlyExpectedTaxable = 0;
  const hourlyExpectedOvertimeTax = ((6 * 20 * 1.5) + (4 * 20 * 2)) * OVERTIME_TAX_RATE;
  const hourlyExpectedDeductionsTotal = hourlyExpectedOvertimeTax;
  const hourlyExpectedNet = hourlyExpectedGross - hourlyExpectedDeductionsTotal;
  const allGood = Math.abs(result.totals.gross - expectedGross) < 0.001 &&
    Math.abs(result.totals.taxable - expectedTaxable) < 0.001 &&
    Math.abs(result.totals.deductions - expectedDeductionsTotal) < 0.001 &&
    Math.abs(result.totals.net - expectedNet) < 0.001 &&
    Math.abs(result.totals.overtime_tax - expectedOvertimeTax) < 0.001 &&
    Math.abs(hourlyResult.totals.gross - hourlyExpectedGross) < 0.001 &&
    Math.abs(hourlyResult.totals.taxable - hourlyExpectedTaxable) < 0.001 &&
    Math.abs(hourlyResult.totals.deductions - hourlyExpectedDeductionsTotal) < 0.001 &&
    Math.abs(hourlyResult.totals.net - hourlyExpectedNet) < 0.001 &&
    Math.abs(hourlyResult.totals.overtime_tax - hourlyExpectedOvertimeTax) < 0.001;
  if (!allGood) {
    console.error('Selftest failed', { result, expectedGross, expectedTaxable, expectedDeductionsTotal });
  } else {
    console.info('Selftest ok');
  }
}

function init() {
  loadFromStorage();
  resetTransientState();
  hydrateForm();
  attachEventListeners();
  recalc();
  runSelfTests();
}

document.addEventListener('DOMContentLoaded', init);
