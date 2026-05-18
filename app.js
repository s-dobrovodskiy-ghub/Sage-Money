// === 1. GLOBAL UI FUNCTIONS (Definition FIRST to prevent race conditions) ===
window.openUpload = () => { 
    const modal = document.getElementById('uploadModal');
    if (modal) modal.style.display = 'flex'; 
    if (typeof lucide !== 'undefined') lucide.createIcons(); 
};

window.closeUpload = () => { 
    const modal = document.getElementById('uploadModal');
    if (modal) modal.style.display = 'none'; 
};

window.closeModal = () => { 
    const modal = document.getElementById('categoryModal');
    if (modal) modal.style.display = 'none'; 
};

window.showToast = (msg, type = 'success') => {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'check-circle' : (type === 'error' ? 'alert-circle' : 'info');
    toast.innerHTML = `<i data-lucide="${icon}"></i> <span>${msg}</span>`;
    container.appendChild(toast);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
};

// === 2. CONFIGURATION ===
const DEFAULT_CATEGORIES = ['Продукты', 'Транспорт', 'Еда', 'Шопинг', 'Здоровье', 'Сервисы/Переводы', 'Постоянные расходы', 'Перевод между счетами', 'Переводы', 'Прочее'];
const SUPABASE_URL = typeof CONFIG !== 'undefined' ? CONFIG.SUPABASE_URL : '';
const SUPABASE_KEY = typeof CONFIG !== 'undefined' ? CONFIG.SUPABASE_KEY : '';

let db = null;
try {
    if (typeof supabase !== 'undefined') {
        db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }
} catch (e) { console.error("Supabase init error:", e); }

// === 3. STATE ===
let state = {
    user_id: localStorage.getItem('money_user_id') || '',
    transactions: [],
    savings: [],
    fixedExpenses: [
        {id: 1, name: 'Квартира', amount: 300, checked: false},
        {id: 2, name: 'Медицина', amount: 50, checked: false},
        {id: 3, name: 'Сервисы', amount: 20, checked: false}
    ],
    accounts: [{id: 1, name: 'Основная карта', amount: 0, currency: 'BYN'}],
    regularIncomes: [],
    filters: { start: '', end: '', category: '', tag: '', search: '', source: '' },
    rates: { BYN: 3.25, RUB: 90.0 }, // fallback rates: units per 1 USD
    expandedCategories: new Set(),
    editingId: null,
    tempCategory: null,
    currentTab: 'dashboard',
    isSyncing: false,
    displayCurrency: localStorage.getItem('displayCurrency') || 'USD',
    alfaPage: 1,
    alfaHasMore: false,
    alfaLoading: false
};

// === ALFA-BANK OAUTH ===
const ALFA = {
    clientId: 'dAvFmotq4hat3rLkAriUPwdWBEIa',
    clientSecret: 'KU9srBdVjc0Ph5w8oDzulxzawG8a',
    authUrl: 'https://ibapi.alfabank.by:8273/authorize',
    tokenUrl: 'https://ibapi.alfabank.by:8273/token',
    apiBase: 'https://developerhub.alfabank.by:8273/individual/1.0.0/accounts',
    redirectUri: 'https://sparkling-ganache-43d839.netlify.app/',
    scope: 'accounts_individual'
};

window.connectAlfaBank = () => {
    const url = `${ALFA.authUrl}?response_type=code&client_id=${ALFA.clientId}&redirect_uri=${encodeURIComponent(ALFA.redirectUri)}&scope=${ALFA.scope}`;
    window.location.href = url;
};

async function handleOAuthCallback() {
    // Check implicit flow (token in hash)
    const hash = new URLSearchParams(window.location.hash.replace('#', ''));
    const implicitToken = hash.get('access_token');
    if (implicitToken) {
        localStorage.setItem('alfaToken', implicitToken);
        const exp = hash.get('expires_in');
        if (exp) localStorage.setItem('alfaTokenExpiry', (Date.now() + parseInt(exp) * 1000).toString());
        window.history.replaceState({}, '', '/');
        showToast('Альфа-Банк подключён!', 'success');
        updateAlfaUI(); await syncAlfaBank(); return;
    }
    // Check code grant
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return;
    window.history.replaceState({}, '', '/');
    try {
        showToast('Получаем токен...', 'info');
        const res = await fetch(ALFA.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code', code,
                client_id: ALFA.clientId, client_secret: ALFA.clientSecret,
                redirect_uri: ALFA.redirectUri
            })
        });
        const data = await res.json();
        if (data.access_token) {
            localStorage.setItem('alfaToken', data.access_token);
            if (data.refresh_token) localStorage.setItem('alfaRefreshToken', data.refresh_token);
            if (data.expires_in) localStorage.setItem('alfaTokenExpiry', (Date.now() + data.expires_in * 1000).toString());
            showToast('Альфа-Банк подключён!', 'success');
            updateAlfaUI(); await syncAlfaBank();
        } else { throw new Error(data.error_description || JSON.stringify(data)); }
    } catch (e) {
        console.error('Alfa token error:', e);
        showToast('Ошибка подключения: ' + e.message, 'error');
    }
}

async function syncAlfaBank() {
    const token = localStorage.getItem('alfaToken');
    if (!token) return;
    const expiry = localStorage.getItem('alfaTokenExpiry');
    if (expiry && Date.now() > parseInt(expiry)) {
        localStorage.removeItem('alfaToken'); updateAlfaUI();
        showToast('Сессия истекла, переподключитесь', 'info'); return;
    }
    try {
        showToast('Загружаем операции Альфа-Банк...', 'info');
        const lastSync = localStorage.getItem('alfaLastSync');
        const dateFrom = lastSync ? new Date(parseInt(lastSync)).toISOString().split('T')[0] : new Date(Date.now() - 730*86400000).toISOString().split('T')[0];
        const dateTo = new Date().toISOString().split('T')[0];
        // Save date range for pagination
        localStorage.setItem('alfaDateFrom', dateFrom);
        localStorage.setItem('alfaDateTo', dateTo);
        state.alfaPage = 1;
        const PAGE_SIZE = 100;
        const res = await fetch(`${ALFA.apiBase}/statement?dateFrom=${dateFrom}&dateTo=${dateTo}&pageRowCount=${PAGE_SIZE}&pageNo=1`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 401) { localStorage.removeItem('alfaToken'); updateAlfaUI(); showToast('Сессия истекла', 'error'); return; }
        const data = await res.json();
        const totalRows = data.totalRowCount || 0;
        state.alfaHasMore = totalRows > PAGE_SIZE;
        const existingIds = new Set(state.transactions.filter(t => t.alfaId).map(t => t.alfaId));
        const newTxs = (data.items || []).filter(op => op.status !== 'rejected' && !existingIds.has(op.id)).map(op => alfaOpToTx(op));
        commitTransactions(newTxs);
        if (newTxs.length === 0) showToast('Новых операций нет', 'info');
        else if (state.alfaHasMore) showToast(`Загружено ${newTxs.length} из ${totalRows}. Прокрутите вниз для ещё`, 'info');
        localStorage.setItem('alfaLastSync', Date.now().toString());
        updateAlfaUI();
    } catch (e) { console.error(e); showToast('Ошибка загрузки: ' + e.message, 'error'); }
}

function alfaOpToTx(op) {
    const amount = Math.abs(op.amount?.amount || 0);
    const currency = op.amount?.currIso || 'BYN';
    const isIncome = (op.amount?.amount || 0) > 0;
    const d = new Date(op.date);
    const dateStr = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
    const ot = op.operationType;
    const cat = isIncome ? 'Доход' : ot === 'ownAccountsTransfer' ? 'Перевод между счетами' : ot === 'payment' ? 'Сервисы/Переводы' : ot === 'currencyExchange' ? 'Сервисы/Переводы' : (ot||'').includes('credit') ? 'Постоянные расходы' : categorize(op.title || '');
    return { id: `tx-${Date.now()}-${Math.random().toString(36).substr(2,5)}`, alfaId: op.id, date: dateStr, isoDate: d.toISOString().split('T')[0], description: op.title || 'Операция', amount, amountOriginal: amount, currency, type: isIncome ? 'income' : 'expense', category: cat, source: 'alfabank' };
}

async function loadNextAlfaPage() {
    if (!state.alfaHasMore || state.alfaLoading) return;
    const token = localStorage.getItem('alfaToken');
    if (!token) return;
    state.alfaLoading = true;
    state.alfaPage++;
    const PAGE_SIZE = 100;
    const dateFrom = localStorage.getItem('alfaDateFrom');
    const dateTo = localStorage.getItem('alfaDateTo');
    try {
        const res = await fetch(`${ALFA.apiBase}/statement?dateFrom=${dateFrom}&dateTo=${dateTo}&pageRowCount=${PAGE_SIZE}&pageNo=${state.alfaPage}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        const totalRows = data.totalRowCount || 0;
        state.alfaHasMore = state.alfaPage * PAGE_SIZE < totalRows;
        const existingIds = new Set(state.transactions.filter(t => t.alfaId).map(t => t.alfaId));
        const newTxs = (data.items || []).filter(op => op.status !== 'rejected' && !existingIds.has(op.id)).map(op => alfaOpToTx(op));
        if (newTxs.length > 0) commitTransactions(newTxs);
        else updateUI(); // refresh sentinel
    } catch (e) {
        state.alfaPage--;
        console.error('Alfa page error:', e);
    }
    state.alfaLoading = false;
}

function setupAlfaInfiniteScroll() {
    const sentinel = document.getElementById('alfaScrollSentinel');
    if (!sentinel) return;
    if (state._alfaObserver) state._alfaObserver.disconnect();
    state._alfaObserver = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting) loadNextAlfaPage();
    }, { rootMargin: '200px' });
    state._alfaObserver.observe(sentinel);
}

function updateAlfaUI() {
    const token = localStorage.getItem('alfaToken');
    const lastSync = localStorage.getItem('alfaLastSync');
    const btn = document.getElementById('alfaBtn');
    if (!btn) return;
    if (token) {
        btn.innerHTML = '<i data-lucide="refresh-cw" size="14"></i> Обновить Альфу';
        btn.onclick = syncAlfaBank;
        btn.title = lastSync ? `Обновлено: ${new Date(parseInt(lastSync)).toLocaleTimeString('ru')}` : '';
        btn.style.borderColor = 'var(--primary-color)';
    } else {
        btn.innerHTML = '<i data-lucide="link-2" size="14"></i> Альфа-Банк';
        btn.onclick = window.connectAlfaBank;
        btn.style.borderColor = '';
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function toUSD(amount, currency) {
    if (!currency || currency === 'USD') return amount;
    const rate = state.rates[currency];
    return rate ? amount / rate : amount;
}

async function fetchRates() {
    const cached = localStorage.getItem('exchangeRates');
    const cachedTime = localStorage.getItem('exchangeRatesTime');
    const now = Date.now();
    const SIX_HOURS = 6 * 3600 * 1000;

    if (cached && cachedTime && now - parseInt(cachedTime) < SIX_HOURS) {
        state.rates = JSON.parse(cached);
        updateRatesUI();
        return;
    }

    try {
        const res = await fetch('https://open.er-api.com/v6/latest/USD');
        const data = await res.json();
        if (data.result === 'success') {
            state.rates = { BYN: data.rates.BYN, RUB: data.rates.RUB };
            localStorage.setItem('exchangeRates', JSON.stringify(state.rates));
            localStorage.setItem('exchangeRatesTime', now.toString());
            showToast(`Курсы обновлены: 1$ = ${state.rates.BYN.toFixed(2)} BYN | ${state.rates.RUB.toFixed(0)} RUB`, 'info');
        }
    } catch (e) {
        console.warn('Rates fetch failed, using fallback:', e);
    }
    updateRatesUI();
}

function updateRatesUI() {
    const el = document.getElementById('ratesDisplay');
    if (el && state.rates.BYN) {
        el.textContent = `1$ = ${state.rates.BYN.toFixed(2)} BYN | ${state.rates.RUB.toFixed(0)} RUB`;
    }
}

// Convert amount from its native currency to the user's chosen display currency
function toDisplay(amount, fromCurrency) {
    const from = fromCurrency || 'BYN';
    const to = state.displayCurrency;
    if (from === to) return amount;
    // Convert from -> USD -> to
    const rateFrom = from === 'USD' ? 1 : (state.rates[from] || 1);
    const rateTo = to === 'USD' ? 1 : (state.rates[to] || 1);
    return (amount / rateFrom) * rateTo;
}

function getCurrencySymbol(c) {
    return c === 'USD' ? '$' : c === 'RUB' ? '\u20bd' : 'Br';
}

window.setDisplayCurrency = (c) => {
    state.displayCurrency = c;
    localStorage.setItem('displayCurrency', c);
    document.querySelectorAll('.cur-btn').forEach(b => b.classList.toggle('active', b.dataset.cur === c));
    updateUI();
};


function expandFiltersToData(transactions) {
    if (!transactions || transactions.length === 0) return;
    const dates = transactions.map(t => t.isoDate).filter(Boolean).sort();
    if (dates.length === 0) return;
    const minDate = dates[0];
    const maxDate = dates[dates.length - 1];
    if (!state.filters.start || minDate < state.filters.start) state.filters.start = minDate;
    if (!state.filters.end || maxDate > state.filters.end) state.filters.end = maxDate;
    const sd = document.getElementById('startDate');
    const ed = document.getElementById('endDate');
    if (sd) sd.value = state.filters.start;
    if (ed) ed.value = state.filters.end;
}

function loadLocal() {
    try {
        const tx = localStorage.getItem('transactions');
        const sv = localStorage.getItem('savings');
        const fx = localStorage.getItem('fixedExpenses');
        if (tx) {
            state.transactions = JSON.parse(tx).filter(t => t && t.date && t.amount != null);
            state.transactions.forEach(t => { if (!t.isoDate) t.isoDate = parseToISODate(t.date); });
        }
        if (sv) state.savings = JSON.parse(sv);
        if (fx) state.fixedExpenses = JSON.parse(fx);
        const acc = localStorage.getItem('accounts');
        if (acc) state.accounts = JSON.parse(acc);
        const ri = localStorage.getItem('regularIncomes');
        if (ri) state.regularIncomes = JSON.parse(ri);
    } catch (e) { console.error("LocalStorage load error:", e); }
}

let _syncTimer = null;
async function syncToCloud() {
    if (!state.user_id || !db) { console.warn('[Sage] syncToCloud skipped: no user_id or db'); return; }
    clearTimeout(_syncTimer);
    _syncTimer = setTimeout(async () => {
        state.isSyncing = true; updateSyncUI();
        try {
            const payload = { transactions: state.transactions, savings: state.savings, fixedExpenses: state.fixedExpenses, accounts: state.accounts, regularIncomes: state.regularIncomes };
            const { error } = await db.from('WebMoney').upsert({ user_id: state.user_id, payload }, { onConflict: 'user_id' });
            if (error) throw error;
            localStorage.setItem('lastSync', new Date().getTime().toString());
            updateSyncUI(true);
            console.log('[Sage] syncToCloud OK');
        } catch (e) {
            console.error('[Sage] Cloud Sync failed:', e);
            updateSyncUI(false, true);
            const msg = e?.message || e?.code || JSON.stringify(e);
            showToast(`\u041e\u0448\u0438\u0431\u043a\u0430 \u043e\u0431\u043b\u0430\u043a\u0430: ${msg}`, 'error');
        } finally { state.isSyncing = false; updateSyncUI(); }
    }, 2000);
}

async function loadFromCloud() {
    if (!state.user_id || !db) { console.warn('[Sage] loadFromCloud skipped: no user_id or db'); return; }
    state.isSyncing = true; updateSyncUI();
    try {
        const { data: rows, error } = await db.from('WebMoney').select('payload').eq('user_id', state.user_id).limit(1);
        if (error) throw error;
        const data = rows && rows.length > 0 ? rows[0] : null;
        if (data && data.payload) {
            state.transactions = (data.payload.transactions || []).filter(t => t && t.date && t.amount != null);
            state.transactions.forEach(t => {
                if (!t.isoDate) t.isoDate = parseToISODate(t.date);
                // Migrate old 'priorbank' source → 'alfabank'
                if (t.source === 'priorbank') t.source = 'alfabank';
            });
            state.savings = data.payload.savings || [];
            state.fixedExpenses = data.payload.fixedExpenses || [];
            state.accounts = data.payload.accounts || [{id: 1, name: 'Основная карта', amount: 0, currency: 'BYN'}];
            state.regularIncomes = data.payload.regularIncomes || [];
            saveLocal();
            expandFiltersToData(state.transactions);
            updateUI();
            localStorage.setItem('lastSync', new Date().getTime().toString());
            updateSyncUI(true);
            showToast(`Загружено из облака: ${state.transactions.length} транзакций`, 'success');
            console.log('[Sage] loadFromCloud OK:', state.transactions.length);
        } else {
            showToast('Облако пустое — заливаем локальные данные', 'info');
            updateSyncUI(true);
            await syncToCloud();
        }
    } catch (e) {
        console.error('[Sage] Cloud Load failed:', e);
        updateSyncUI(false, true);
        const msg = e?.message || e?.code || JSON.stringify(e);
        showToast(`Ошибка загрузки: ${msg}`, 'error');
    }
    finally { state.isSyncing = false; updateSyncUI(); }
}

function saveLocal() {
    localStorage.setItem('transactions', JSON.stringify(state.transactions));
    localStorage.setItem('savings', JSON.stringify(state.savings));
    localStorage.setItem('fixedExpenses', JSON.stringify(state.fixedExpenses));
    localStorage.setItem('accounts', JSON.stringify(state.accounts));
    localStorage.setItem('regularIncomes', JSON.stringify(state.regularIncomes));
}

function checkAutoBackup() {
    const lastBackup = localStorage.getItem('lastBackup');
    const now = new Date().getTime();
    const week = 7 * 24 * 60 * 60 * 1000;
    if (!lastBackup || now - parseInt(lastBackup) > week) {
        showToast("⚠️ Рекомендуется сделать бэкап данных!", "info");
        // Trigger auto backup download
        exportData(true);
    }
}

window.exportData = (isAuto = false) => {
    const d = { transactions: state.transactions, savings: state.savings, fixed: state.fixedExpenses, accounts: state.accounts, regularIncomes: state.regularIncomes };
    const str = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(d));
    const dl = document.createElement('a'); 
    dl.setAttribute("href", str); 
    const dateStr = new Date().toISOString().split('T')[0];
    dl.setAttribute("download", `money_backup_${dateStr}${isAuto ? '_auto' : ''}.json`); 
    dl.click();
    localStorage.setItem('lastBackup', new Date().getTime().toString());
    if (!isAuto) showToast("Бэкап JSON скачан", "success");
};

window.importData = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.transactions) state.transactions = data.transactions;
            if (data.savings) state.savings = data.savings;
            if (data.fixed) state.fixedExpenses = data.fixed;
            if (data.accounts) state.accounts = data.accounts;
            if (data.regularIncomes) state.regularIncomes = data.regularIncomes;
            
            state.transactions.forEach(t => { if (!t.isoDate) t.isoDate = parseToISODate(t.date); });
            
            saveLocal();
            expandFiltersToData(state.transactions);
            updateUI();
            syncToCloud();
            showToast("Данные успешно импортированы", "success");
        } catch (err) {
            console.error(err);
            showToast("Ошибка чтения файла JSON", "error");
        }
    };
    reader.readAsText(file);
    event.target.value = ''; // Reset
};

// === 6. PDF PROCESSING ===

// Detect bank from text header
function detectBank(text) {
    const t = text.substring(0, 500).toUpperCase();
    if (t.includes('ТБАНК') || t.includes('TBANK') || t.includes('ТИНЬКОФФ') || t.includes('ТИНКОФФ')) return 'tinkoff';
    if (t.includes('ПРИОРБАНК') || t.includes('PRIORBANK')) return 'priorbank';
    if (t.includes('АЛЬФА-БАНК') || t.includes('ALFA') || t.includes('ALPHABANK')) return 'alfabank';
    return 'unknown';
}

// Extract text + positions from PDF (needed for Tinkoff columnar format)
async function extractPDFItems(data) {
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js не загружен');
    const pdf = await pdfjsLib.getDocument(data).promise;
    let allItems = [];
    let plainText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const pageHeight = viewport.height;
        content.items.forEach(item => {
            if (item.str.trim()) {
                allItems.push({
                    text: item.str.trim(),
                    x: Math.round(item.transform[4]),
                    y: Math.round(pageHeight - item.transform[5]) // flip Y: 0=top
                });
            }
        });
        plainText += content.items.map(item => item.str).join(' ') + '\n';
    }
    return { items: allItems, plainText };
}

// Parse Tinkoff PDF using positional grouping
// Columns: x~56=date_op, x~199=amount_orig, x~294=amount_rub, x~389=description
function parseTinkoff(items) {
    const COL = { date: 56, amountOrig: 199, amountRub: 294, desc: 389 };
    const TOLERANCE = 40; // px tolerance for column matching
    const ROW_TOLERANCE = 12; // px to group items into same row

    // Group items by Y (row)
    const rows = {};
    items.forEach(item => {
        const yKey = Math.round(item.y / ROW_TOLERANCE) * ROW_TOLERANCE;
        if (!rows[yKey]) rows[yKey] = [];
        rows[yKey].push(item);
    });

    const transactions = [];
    const existingKeys = new Set(state.transactions.map(t => `${t.date}-${t.description.trim().substring(0,20)}-${Number(t.amount).toFixed(2)}`));

    Object.values(rows).forEach(rowItems => {
        const date = rowItems.find(it => Math.abs(it.x - COL.date) < TOLERANCE && /^\d{2}\.\d{2}\.\d{4}/.test(it.text));
        const amtOrig = rowItems.find(it => Math.abs(it.x - COL.amountOrig) < TOLERANCE && /[+-]?[\d ]+[.,]\d{2}/.test(it.text));
        const desc = rowItems.find(it => Math.abs(it.x - COL.desc) < TOLERANCE && it.text.length > 2 && !/^\d{4}$/.test(it.text) && it.text !== '—');

        if (!date || !amtOrig) return;

        // Parse date
        const dateStr = date.text.match(/(\d{2}\.\d{2}\.\d{4})/)?.[1];
        if (!dateStr) return;

        // Parse amount — prefer original currency (col x~199)
        // Format: "+1 690.00 ₽" or "+150.00 Br" etc.
        const amtMatch = amtOrig.text.match(/([+-]?)[\s]*([\d ]+[.,]\d{2})\s*([₽BrUSD$]*)/i);
        if (!amtMatch) return;
        const sign = amtMatch[1] === '-' ? -1 : 1;
        const numStr = amtMatch[2].replace(/\s/g, '').replace(',', '.');
        const amount = Math.abs(parseFloat(numStr));
        if (isNaN(amount) || amount === 0) return;

        // Detect currency
        let currency = 'RUB';
        const currStr = amtOrig.text;
        if (currStr.includes('Br') || currStr.includes('BYN')) currency = 'BYN';
        else if (currStr.includes('$') || currStr.includes('USD')) currency = 'USD';

        const description = (desc?.text || 'Операция').replace(/\n/g, ' ').trim();
        const key = `${dateStr}-${description.substring(0,20)}-${amount.toFixed(2)}`;
        if (existingKeys.has(key)) return;
        existingKeys.add(key);

        // Auto-categorize Tinkoff
        let category;
        const dUp = description.toUpperCase();
        if (sign > 0) category = 'Доход';
        else if (dUp.includes('ПЕРЕВОД') || dUp.includes('TRANSFER')) category = 'Перевод между счетами';
        else if (dUp.includes('ПРОЦЕНТ') || dUp.includes('ШТРАФ') || dUp.includes('ПЛАТА ЗА')) category = 'Сервисы/Переводы';
        else if (dUp.includes('ПОГАШЕНИЕ')) category = 'Постоянные расходы';
        else category = 'Прочее';

        transactions.push({
            id: `tx-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            date: dateStr,
            isoDate: parseToISODate(dateStr),
            description,
            amount,
            amountOriginal: amount,
            currency,
            type: sign > 0 ? 'income' : 'expense',
            category,
            source: 'tinkoff'
        });
    });

    return transactions;
}

async function extractTextFromPDF(data) {
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js не загружен');
    const pdf = await pdfjsLib.getDocument(data).promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        fullText += content.items.map(item => item.str).join(' ') + '\n';
    }
    return fullText;
}

// parseAlfaBYN: generic BYN statement parser (Alfa-Bank, any BYN-reporting bank)
function parseAlfaBYN(text, source) {
    const regex = /(\d{2}\.\d{2}\.\d{4})\s+(?:[\d:]+\s+)?(.*?)\s+(-?[\d\s]+[.,]\d{2})\s+BYN/g;
    let match;
    const newTransactions = [];
    const existingKeys = new Set(state.transactions.map(t => `${t.date}-${t.description.trim()}-${Number(t.amount).toFixed(2)}`));

    while ((match = regex.exec(text)) !== null) {
        let rawAmount = match[3].replace(/\s/g, '').replace(',', '.');
        const numAmount = parseFloat(rawAmount);
        const amount = Math.abs(numAmount);
        const date = match[1];
        const desc = match[2].trim();
        const key = `${date}-${desc}-${amount.toFixed(2)}`;
        if (!existingKeys.has(key)) {
            const isOwnTransfer = /перевод.*сво|между.*счет|на.*свою.*карт/i.test(desc);
            const isExtTransfer = /перевод/i.test(desc) && !isOwnTransfer;
            let category, type;
            if (numAmount > 0) {
                category = 'Доход'; type = 'income';
            } else if (isOwnTransfer) {
                category = 'Перевод между счетами'; type = 'transfer';
            } else if (isExtTransfer) {
                category = 'Переводы'; type = 'expense';
            } else {
                category = categorize(desc); type = 'expense';
            }
            newTransactions.push({
                id: `tx-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                date, isoDate: parseToISODate(date), description: desc, amount,
                amountOriginal: amount, currency: 'BYN',
                type, category, source: source || 'alfabank'
            });
            existingKeys.add(key);
        }
    }
    return newTransactions;
}

// Detect transfers between own accounts across banks:
// expense from bank A + income in bank B within 3 days, same amount within 8% in USD
function detectCrossAccountTransfers() {
    const DAYS = 3, TOLERANCE = 0.08;
    let changed = false;
    const expenses = state.transactions.filter(t => t.type === 'expense' && t.source && t.isoDate);
    const incomes  = state.transactions.filter(t => t.type === 'income'  && t.source && t.isoDate);

    expenses.forEach(exp => {
        const expUSD  = toUSD(exp.amount, exp.currency || 'BYN');
        const expDate = new Date(exp.isoDate);
        const match   = incomes.find(inc => {
            if (inc.source === exp.source) return false;
            const incUSD   = toUSD(inc.amount, inc.currency || 'BYN');
            const daysDiff = Math.abs((new Date(inc.isoDate) - expDate) / 86400000);
            const pctDiff  = Math.abs(expUSD - incUSD) / Math.max(expUSD, incUSD, 0.01);
            return daysDiff <= DAYS && pctDiff <= TOLERANCE;
        });
        if (match) {
            exp.type  = 'transfer'; exp.category  = '\u041f\u0435\u0440\u0435\u0432\u043e\u0434 \u043c\u0435\u0436\u0434\u0443 \u0441\u0447\u0435\u0442\u0430\u043c\u0438';
            match.type = 'transfer'; match.category = '\u041f\u0435\u0440\u0435\u0432\u043e\u0434 \u043c\u0435\u0436\u0434\u0443 \u0441\u0447\u0435\u0442\u0430\u043c\u0438';
            changed = true;
        }
    });
    return changed;
}

window.runTransferDetection = () => {
    if (detectCrossAccountTransfers()) { saveLocal(); updateUI(); showToast('\u041f\u0435\u0440\u0435\u0432\u043e\u0434\u044b \u043e\u043f\u0440\u0435\u0434\u0435\u043b\u0435\u043d\u044b', 'success'); }
    else showToast('\u041d\u043e\u0432\u044b\u0445 \u043f\u0435\u0440\u0435\u0432\u043e\u0434\u043e\u0432 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e', 'info');
};

function commitTransactions(newTxs) {
    if (!newTxs || newTxs.length === 0) {
        showToast('Новых данных не найдено', 'info');
        return;
    }
    state.transactions = [...newTxs, ...state.transactions];
    state.transactions.sort((a, b) => (b.isoDate || '').localeCompare(a.isoDate || ''));
    detectCrossAccountTransfers(); // auto-match cross-bank transfers
    expandFiltersToData(state.transactions);
    saveLocal();
    updateUI();
    syncToCloud();
    showToast(`Загружено ${newTxs.length} новых транзакций`, 'success');
}

async function handleFiles(file) {
    const reader = new FileReader();
    reader.onload = async function() {
        try {
            const typedarray = new Uint8Array(this.result);
            const { items, plainText } = await extractPDFItems(typedarray);
            if (!plainText || plainText.length < 10) throw new Error('Текст не извлечен');
            const bank = detectBank(plainText);
            showToast(`Определён банк: ${bank === 'tinkoff' ? 'Т-Банк' : 'Альфа-Банк'}`, 'info');
            let newTxs;
            if (bank === 'tinkoff') {
                newTxs = parseTinkoff(items);
            } else {
                newTxs = parseAlfaBYN(plainText, 'alfabank');
            }
            commitTransactions(newTxs);
            window.closeUpload();
        } catch (e) {
            console.error(e);
            showToast('Ошибка PDF: ' + e.message, 'error');
        }
    };
    reader.readAsArrayBuffer(file);
}

window.loadByPath = async () => {
    const path = document.getElementById('filePathInput')?.value.trim();
    if (!path) return;
    try {
        const response = await fetch(path);
        const typedarray = new Uint8Array(await response.arrayBuffer());
        const { items, plainText } = await extractPDFItems(typedarray);
        const bank = detectBank(plainText);
        const newTxs = bank === 'tinkoff' ? parseTinkoff(items) : parseAlfaBYN(plainText, 'alfabank');
        commitTransactions(newTxs);
        window.closeUpload();
    } catch (e) {
        console.error(e);
        showToast('Ошибка пути: ' + e.message, 'error');
    }
};

// === 6. UI RENDERING ===
function extractTags(text) {
    if (!text) return [];
    return text.trim().split(/\s+/).filter(w => w.length > 0).map(w => w.replace(/^#/, ''));
}

function updateUI() {
    populateTagFilter();
    const searchQ = (state.filters.search || '').toLowerCase();
    const filtered = state.transactions.filter(tx => {
        if (!tx || !tx.isoDate) return false;
        if (state.filters.start && tx.isoDate < state.filters.start) return false;
        if (state.filters.end && tx.isoDate > state.filters.end) return false;
        if (state.filters.category && tx.category !== state.filters.category) return false;
        if (state.filters.tag && !extractTags(tx.note).includes(state.filters.tag)) return false;
        if (searchQ && !tx.description.toLowerCase().includes(searchQ) && !(tx.note || '').toLowerCase().includes(searchQ)) return false;
        return true;
    });
    if (state.currentTab === 'dashboard') {
        populateCategoryFilter();
        renderTransactions(filtered);
        renderCategorySummary(calculateStats(filtered), filtered);
        renderChart(calculateStats(filtered));
        updateDynamics();
    } else {
        renderCashflow();
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function populateTagFilter() {
    const sel = document.getElementById('tagFilter');
    if (!sel) return;
    const allTags = new Set();
    state.transactions.forEach(tx => {
        extractTags(tx.note).forEach(t => allTags.add(t));
    });
    const currentVal = state.filters.tag || '';
    sel.innerHTML = '<option value="">Все теги</option>' + Array.from(allTags).map(t => `<option value="${t}" ${t === currentVal ? 'selected' : ''}>${t}</option>`).join('');
    sel.onchange = (e) => { state.filters.tag = e.target.value; updateUI(); };
}

window.deleteTx = (txId) => {
    if (!confirm('Удалить эту транзакцию?')) return;
    state.transactions = state.transactions.filter(t => t.id !== txId);
    saveLocal(); updateUI(); syncToCloud();
    showToast('Транзакция удалена', 'info');
};

window.clearAllData = () => {
    if (!confirm('Удалить ВСЕ транзакции? Это действие необратимо!')) return;
    if (!confirm('Вы уверены? Данные будут удалены навсегда.')) return;
    state.transactions = [];
    saveLocal(); updateUI(); syncToCloud();
    showToast('Все транзакции удалены', 'error');
};

function renderTransactions(txs) {
    const list = document.getElementById('transactionList');
    if (!list) return;

    // Update count in header
    const countEl = document.getElementById('txCount');
    if (countEl) countEl.textContent = txs.length > 0 ? `${txs.length} операций` : '';
    
    if (txs.length === 0) {
        list.innerHTML = '<p style="text-align:center; padding:2rem; color:var(--text-dim)">Ничего не найдено</p>';
        return;
    }

    const grouped = {};
    txs.forEach(t => {
        if(!t.isoDate) return;
        const d = new Date(t.isoDate);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const mon = new Date(d); mon.setDate(diff);
        const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
        const fmt = dt => `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}`;
        const key = `Неделя: ${fmt(mon)} — ${fmt(sun)}`;
        if (!grouped[key]) grouped[key] = { items: [], ts: mon.getTime() };
        grouped[key].items.push(t);
    });

    const sortedGroups = Object.entries(grouped).sort((a, b) => b[1].ts - a[1].ts);

    list.innerHTML = sortedGroups.map(([weekName, group]) => `
        <div style="padding: 0.5rem 0; margin-top: 1rem; margin-bottom: 0.5rem; border-bottom: 1px dashed rgba(255,255,255,0.1); color: var(--primary-light); font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">
            ${weekName}
        </div>
        ${group.items.map(t => {
            const sym = getCurrencySymbol(state.displayCurrency);
            const dispAmt = toDisplay(t.amount, t.currency || 'BYN');
            const origStr = (t.currency && t.currency !== state.displayCurrency)
                ? `<span style="font-size:0.7rem;color:var(--text-dim);margin-left:4px">(${t.amount.toFixed(2)} ${t.currency})</span>`
                : '';
            const srcBadge = t.source ? `<span style="font-size:0.65rem;padding:1px 6px;border-radius:20px;background:var(--accent-color);color:var(--text-dim);margin-right:6px">${t.source === 'tinkoff' ? 'T-Bank' : 'Alfa BY'}</span>` : '';
            const displayNote = t.note ? t.note.trim().split(/\s+/).filter(w=>w).map(w => `<span style="color:var(--white); font-weight:600; background:rgba(82, 121, 111, 0.3); padding:0 4px; border-radius:4px;">${w.replace(/^#/, '')}</span>`).join(' ') : '';
            return `
            <div class="transaction-item" id="tx-row-${t.id}">
                <div class="tx-info">
                    <div class="tx-icon"><i data-lucide="${getIconForCategory(t.category)}"></i></div>
                    <div class="tx-details">
                        <h4>${t.description}</h4>
                        ${t.note ? `<p style="color: var(--primary-light); font-size: 0.8rem; margin: 2px 0;">${displayNote}</p>` : ''}
                        <p>${srcBadge}${t.date} • <span class="tx-category-badge" onclick="window.openCategoryModal('${t.id}')">${t.category}</span></p>
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:12px;">
                    <div style="text-align:right">
                        <div class="tx-amount ${t.type === 'income' ? 'positive' : 'negative'}" style="${t.type === 'income' ? 'color: var(--primary-light); font-weight: 700;' : ''}">${t.type === 'income' ? '+' : '-'}${sym}${dispAmt.toFixed(2)}</div>
                        ${origStr}
                    </div>
                    <button class="tx-delete-btn" onclick="window.deleteTx('${t.id}')" title="Удалить"><i data-lucide="trash-2"></i></button>
                </div>
            </div>
            `;
        }).join('')}
    `).join('');

    // Infinite scroll sentinel for Alfa-Bank pagination
    if (state.alfaHasMore) {
        listEl.innerHTML += `<div id="alfaScrollSentinel" style="text-align:center;padding:2rem;color:var(--text-dim);font-size:0.8rem;">
            <i data-lucide="loader" style="animation:spin 1s linear infinite;display:inline-block;"></i> Загружаем ещё...
        </div>`;
        setTimeout(setupAlfaInfiniteScroll, 100);
    } else if (state.alfaPage > 1) {
        listEl.innerHTML += `<div style="text-align:center;padding:1rem;color:var(--text-dim);font-size:0.75rem;">✓ Все операции загружены</div>`;
    }
}

function renderCategorySummary(stats, allFiltered) {
    const totalExpenses = Object.values(stats).reduce((a, b) => a + b, 0);
    const totalIncome = allFiltered.filter(t => t.type === 'income').reduce((sum, t) => sum + toDisplay(t.amount, t.currency || 'BYN'), 0);
    const balance = totalIncome - totalExpenses;
    const tExpEl = document.getElementById('totalExpenses');
    const tIncEl = document.getElementById('totalIncome');
    const tBalEl = document.getElementById('totalBalance');
    const cEl = document.getElementById('categoryList');
    const sym = getCurrencySymbol(state.displayCurrency);
    if (tExpEl) tExpEl.innerText = `${sym}${totalExpenses.toFixed(2)}`;
    if (tIncEl) tIncEl.innerText = `${sym}${totalIncome.toFixed(2)}`;
    if (tBalEl) {
        tBalEl.innerText = `${balance >= 0 ? '+' : ''}${sym}${balance.toFixed(2)}`;
        tBalEl.style.color = balance >= 0 ? 'var(--primary-light)' : 'var(--danger)';
    }
    if (cEl) {
        cEl.innerHTML = Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([cat, val]) => {
            const isOpen = state.expandedCategories.has(cat);
            return `<div class="category-item">
                <div onclick="window.toggleCategory('${cat}')" style="display:flex; justify-content:space-between; margin-bottom:0.5rem; cursor:pointer;">
                    <span style="font-weight:600">${cat}</span><span>${sym}${val.toFixed(2)}</span>
                </div>
                <div style="height:4px; background:var(--accent-color); border-radius:2px; margin-bottom:1rem;"><div style="height:100%; background:var(--primary-color); width:${totalExpenses > 0 ? (val/totalExpenses*100) : 0}%;"></div></div>
                <div class="category-details ${isOpen ? 'open' : ''}">${allFiltered.filter(t => t.category === cat).slice(0, 8).map(t => `<div style="display:flex; justify-content:space-between; margin-bottom:4px; color:var(--text-dim)"><span>${t.description}</span><span>${sym}${toDisplay(t.amount, t.currency||'BYN').toFixed(2)}</span></div>`).join('')}</div>
            </div>`;
        }).join('');
    }
}

window.toggleCategory = (cat) => {
    if (state.expandedCategories.has(cat)) state.expandedCategories.delete(cat);
    else state.expandedCategories.add(cat);
    updateUI();
};

window.openCategoryModal = (txId) => {
    state.editingId = txId;
    const tx = state.transactions.find(t => t.id === txId);
    if (!tx) return;
    state.tempCategory = tx.category;
    document.getElementById('editTxDesc').innerText = tx.description;
    const noteEl = document.getElementById('editTxNote');
    if(noteEl) noteEl.value = (tx.note || '').replace(/#/g, '');
    document.getElementById('categoryChoices').innerHTML = DEFAULT_CATEGORIES.map(c => `<div class="category-chip" style="${c === tx.category ? 'background: var(--primary-color); color: var(--white);' : ''}" onclick="window.setCategory('${c}')">${c}</div>`).join('');
    document.getElementById('categoryModal').style.display = 'flex';
};

window.setCategory = (cat) => {
    state.tempCategory = cat;
    document.getElementById('categoryChoices').innerHTML = DEFAULT_CATEGORIES.map(c => `<div class="category-chip" style="${c === cat ? 'background: var(--primary-color); color: var(--white);' : ''}" onclick="window.setCategory('${c}')">${c}</div>`).join('');
};

window.saveTransactionEdit = () => {
    const tx = state.transactions.find(t => t.id === state.editingId);
    if (tx) {
        if(state.tempCategory) tx.category = state.tempCategory;
        const noteEl = document.getElementById('editTxNote');
        if (noteEl) {
            tx.note = noteEl.value.trim().replace(/#/g, '');
        }
        saveLocal(); window.closeModal(); updateUI(); syncToCloud();
        showToast("Операция обновлена", "success");
    }
};

function renderCashflow() {
    const renderList = (type, arr, showCheckbox, showCurrency) => arr.map(i => `<div class="item-row">
        ${showCheckbox ? `<div class="checkbox-container ${i.checked ? 'checked' : ''}" onclick="window.toggleItem('${type}', ${i.id})"><i data-lucide="check" size="14"></i></div>` : ''}
        <input type="text" value="${i.name}" onchange="window.updateItem('${type}', ${i.id}, 'name', this.value)" style="${showCheckbox ? 'margin-left:1rem;' : ''}">
        <input type="number" value="${i.amount}" onchange="window.updateItem('${type}', ${i.id}, 'amount', this.value)">
        ${showCurrency ? `<select style="background:transparent; border:none; color:var(--text-dim); outline:none;" onchange="window.updateItem('${type}', ${i.id}, 'currency', this.value)"><option value="BYN" ${i.currency==='BYN'?'selected':''}>BYN</option><option value="USD" ${i.currency==='USD'?'selected':''}>USD</option><option value="EUR" ${i.currency==='EUR'?'selected':''}>EUR</option><option value="RUB" ${i.currency==='RUB'?'selected':''}>RUB</option></select>` : ''}
        <button class="btn-delete" onclick="window.deleteItem('${type}', ${i.id})"><i data-lucide="trash-2" size="16"></i></button>
    </div>`).join('');

    const sl = document.getElementById('savingsList');
    const fl = document.getElementById('fixedList');
    const al = document.getElementById('accountsList');
    const ril = document.getElementById('regularIncomesList');

    if (sl) sl.innerHTML = renderList('savings', state.savings, false, false);
    if (fl) fl.innerHTML = renderList('fixed', state.fixedExpenses, true, false);
    if (al) al.innerHTML = renderList('accounts', state.accounts, false, true);
    if (ril) ril.innerHTML = renderList('regularIncomes', state.regularIncomes, true, false);
}

const getList = (type) => ({'savings': state.savings, 'fixed': state.fixedExpenses, 'accounts': state.accounts, 'regularIncomes': state.regularIncomes}[type]);

window.addItem = (type) => {
    const list = getList(type);
    const item = { id: Date.now(), name: 'Новая запись', amount: 0 };
    if (type === 'fixed' || type === 'regularIncomes') item.checked = false;
    if (type === 'accounts') item.currency = 'BYN';
    list.push(item); saveLocal(); updateUI(); syncToCloud();
};

window.updateItem = (type, id, field, val) => {
    const item = getList(type).find(i => i.id === id);
    if (item) { item[field] = field === 'amount' ? parseFloat(val) || 0 : val; saveLocal(); syncToCloud(); }
};

window.toggleItem = (type, id) => {
    const item = getList(type).find(i => i.id === id);
    if (item) { item.checked = !item.checked; saveLocal(); updateUI(); syncToCloud(); }
};
window.toggleFixed = (id) => window.toggleItem('fixed', id);

window.deleteItem = (type, id) => {
    if (type === 'savings') state.savings = state.savings.filter(i => i.id !== id);
    else if (type === 'fixed') state.fixedExpenses = state.fixedExpenses.filter(i => i.id !== id);
    else if (type === 'accounts') state.accounts = state.accounts.filter(i => i.id !== id);
    else if (type === 'regularIncomes') state.regularIncomes = state.regularIncomes.filter(i => i.id !== id);
    saveLocal(); updateUI(); syncToCloud();
};

window.switchTab = (tab) => {
    state.currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`tab-${tab}`)?.classList.add('active');
    document.getElementById(`${tab}View`)?.classList.add('active');
    updateUI();
};

function updateSyncUI(success = false, error = false) {
    const btn = document.getElementById('syncIndicator');
    if (!btn) return;
    if (state.isSyncing) {
        btn.style.color = 'var(--primary-light)';
        btn.innerHTML = `<i data-lucide="refresh-cw" class="spin"></i>`;
        btn.title = 'Синхронизация...';
    } else if (error) {
        btn.style.color = 'var(--danger)';
        btn.innerHTML = `<i data-lucide="cloud-off"></i>`;
        btn.title = 'Ошибка синхронизации (только локально)';
    } else if (state.user_id) {
        const lastSync = localStorage.getItem('lastSync');
        const title = lastSync ? `Последняя синхронизация: ${new Date(parseInt(lastSync)).toLocaleString()}` : 'Синхронизировано';
        btn.style.color = '#52796f';
        btn.innerHTML = `<i data-lucide="cloud-check"></i>`;
        btn.title = title;
    } else {
        btn.style.color = 'var(--text-dim)';
        btn.innerHTML = `<i data-lucide="cloud-off"></i>`;
        btn.title = 'Локальный режим (без облака)';
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// === 7. HELPERS ===
function populateCategoryFilter() {
    const sel = document.getElementById('categoryFilter');
    if (!sel) return;
    const cats = [...new Set(state.transactions.map(t => t.category))].filter(Boolean);
    const currentVal = state.filters.category || '';
    sel.innerHTML = '<option value="">Все</option>' + cats.map(c => `<option value="${c}" ${c === currentVal ? 'selected' : ''}>${c}</option>`).join('');
    sel.onchange = (e) => { state.filters.category = e.target.value; updateUI(); };
}

function updateDynamics() {
    if(!state.filters.start || !state.filters.end) return;
    const start = new Date(state.filters.start);
    const end = new Date(state.filters.end);
    const diff = end - start;
    const prevEnd = new Date(start.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - diff);
    const prevStartStr = prevStart.toISOString().split('T')[0];
    const prevEndStr = prevEnd.toISOString().split('T')[0];

    let currentExp = 0, currentInc = 0, prevExp = 0, prevInc = 0;

    state.transactions.forEach(t => {
        if (!t || !t.isoDate) return;
        if (state.filters.category && t.category !== state.filters.category) return;
        if (state.filters.tag && !extractTags(t.note).includes(state.filters.tag)) return;
        
        if (t.isoDate >= state.filters.start && t.isoDate <= state.filters.end) {
            if(t.type === 'income') currentInc += t.amount; else currentExp += t.amount;
        }
        if (t.isoDate >= prevStartStr && t.isoDate <= prevEndStr) {
            if(t.type === 'income') prevInc += t.amount; else prevExp += t.amount;
        }
    });

    const renderComp = (elId, cur, prev, reverseColor) => {
        const el = document.getElementById(elId);
        if(!el) return;
        if(prev === 0) { el.innerHTML = ''; return; }
        const pct = ((cur - prev) / prev * 100);
        const isUp = pct > 0;
        const color = reverseColor ? (isUp ? 'success' : 'danger') : (isUp ? 'danger' : 'success');
        el.innerHTML = `<span style="color: var(--${color})">${isUp ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}%</span> с прошлого периода`;
    };

    renderComp('expenseCompare', currentExp, prevExp, false);
    renderComp('incomeCompare', currentInc, prevInc, true);
}

function parseToISODate(str) {
    if (!str || !str.includes('.')) return '2000-01-01';
    const [d, m, y] = str.split('.');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
function calculateStats(txs) {
    const cats = {};
    txs.forEach(t => {
        // Exclude income AND own-account transfers from expense stats
        if (t.type !== 'income' && t.type !== 'transfer' && t.category !== 'Перевод между счетами') {
            const val = toDisplay(t.amount, t.currency || 'BYN');
            cats[t.category] = (cats[t.category] || 0) + val;
        }
    });
    return cats;
}

// === AI EXPORT ===
window.exportForAI = () => {
    const days = 90;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    const txs = state.transactions.filter(t => t.isoDate >= cutoff);

    // Totals
    const income  = txs.filter(t => t.type === 'income').reduce((s, t) => s + toDisplay(t.amount, t.currency || 'BYN'), 0);
    const expense = txs.filter(t => t.type === 'expense').reduce((s, t) => s + toDisplay(t.amount, t.currency || 'BYN'), 0);

    // By category
    const byCategory = {};
    txs.filter(t => t.type === 'expense').forEach(t => {
        const cat = t.category || '\u041f\u0440\u043e\u0447\u0435\u0435';
        byCategory[cat] = (byCategory[cat] || 0) + toDisplay(t.amount, t.currency || 'BYN');
    });
    const catLines = Object.entries(byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([c, v]) => `  ${c}: ${v.toFixed(2)} ${state.displayCurrency}`)
        .join('\n');

    // Top 10 largest expenses
    const top10 = txs.filter(t => t.type === 'expense')
        .sort((a, b) => b.amount - a.amount).slice(0, 10)
        .map(t => `  ${t.date} | ${t.description.substring(0, 40)} | ${toDisplay(t.amount, t.currency||'BYN').toFixed(2)} ${state.displayCurrency}`)
        .join('\n');

    // Savings
    const savingsLines = state.savings.map(s => `  ${s.name}: ${s.amount} ${s.currency || 'BYN'} (цель: ${s.goal || '?'})`).join('\n');
    // Fixed expenses
    const fixedLines = state.fixedExpenses.map(f => `  ${f.name}: ${f.amount} USD/мес`).join('\n');

    const sym = state.displayCurrency;
    const report = `=== ФИНАНСОВЫЙ ОТЧЁТ SAGE MONEY ===
Период анализа: последние ${days} дней
Валюта отображения: ${sym}
Курсы: 1 USD = ${state.rates.BYN} BYN, 1 USD = ${state.rates.RUB} RUB

ИТОГИ:
  Доходы:  ${income.toFixed(2)} ${sym}
  Расходы: ${expense.toFixed(2)} ${sym}
  Баланс:  ${(income - expense).toFixed(2)} ${sym}

РАСХОДЫ ПО КАТЕГОРИЯМ:
${catLines}

ТОП-10 КРУПНЕЙШИХ РАСХОДОВ:
${top10}

НАКОПЛЕНИЯ:
${savingsLines || '  (нет данных)'}

ПОСТОЯННЫЕ РАСХОДЫ В МЕС:
${fixedLines || '  (нет данных)'}

=== ЗАДАЧА ДЛЯ ИИ ===
Ты — персональный финансовый советник. На основе данных выше:
1. Оцени структуру расходов — где перерасход?
2. Дай 3-5 конкретных рекомендаций по оптимизации
3. Рассчитай, сколько можно откладывать ежемесячно
4. Укажи потенциальные риски в текущей финансовой модели
Отвечай на русском языке, конкретно и по делу.`;

    navigator.clipboard.writeText(report).then(() => {
        showToast('\u041e\u0442\u0447\u0451\u0442 \u0441\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u043d! \u0412\u0441\u0442\u0430\u0432\u044c \u0432 DeepSeek \u0438\u043b\u0438 ChatGPT', 'success');
    }).catch(() => {
        // Fallback: open in new window
        const w = window.open('', '_blank');
        w.document.write('<pre style="font-family:monospace;white-space:pre-wrap;padding:20px">' + report.replace(/</g,'&lt;') + '</pre>');
        showToast('\u041e\u0442\u0447\u0451\u0442 \u043e\u0442\u043a\u0440\u044b\u0442 \u0432 \u043d\u043e\u0432\u043e\u043c \u043e\u043a\u043d\u0435 \u2014 \u0441\u043a\u043e\u043f\u0438\u0440\u0443\u0439 \u0432\u0440\u0443\u0447\u043d\u0443\u044e', 'info');
    });
};

function getIconForCategory(cat) {
    const icons = {'Продукты':'shopping-cart', 'Транспорт':'bus', 'Еда':'coffee', 'Шопинг':'shopping-bag', 'Здоровье':'heart-pulse', 'Сервисы/Переводы':'refresh-cw', 'Доход':'trending-up', 'Зарплата':'briefcase', 'Прочее':'credit-card'};
    return icons[cat] || 'credit-card';
}
function renderChart(stats) {
    const canvas = document.getElementById('categoryChart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (window.myChart) window.myChart.destroy();
    window.myChart = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: { labels: Object.keys(stats), datasets: [{ data: Object.values(stats), backgroundColor: ['#52796f', '#84a98c', '#354f52', '#2f3e46', '#cad2c5', '#141818'], borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, cutout: '75%' }
    });
}

function categorize(desc) {
    desc = desc.toUpperCase();
    if (desc.includes('EVROOPT') || desc.includes('GREEN-') || desc.includes('MARTSIN') || desc.includes('SOSEDI')) return 'Продукты';
    if (desc.includes('TRANSPORT') || desc.includes('ELEVEN')) return 'Транспорт';
    if (desc.includes('EDA') || desc.includes('KAFE') || desc.includes('WANTED') || desc.includes('DONER')) return 'Еда';
    if (desc.includes('MEGATOP') || desc.includes('MALL') || desc.includes('SHOP')) return 'Шопинг';
    if (desc.includes('APTEKA') || desc.includes('PARATSELS')) return 'Здоровье';
    if (desc.includes('ERIP') || desc.includes('INSNC') || desc.includes('TRANSFER')) return 'Сервисы/Переводы';
    return 'Прочее';
}

// === 8. INITIALIZATION ===
document.addEventListener('DOMContentLoaded', () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
    state.filters.start = `${y}-${m}-01`;
    state.filters.end = `${y}-${m}-${lastDay}`;
    const sDate = document.getElementById('startDate');
    const eDate = document.getElementById('endDate');
    const rBtn = document.getElementById('resetFilters');
    
    if(sDate) { sDate.value = state.filters.start; sDate.onchange = (e) => { state.filters.start = e.target.value; updateUI(); }; }
    if(eDate) { eDate.value = state.filters.end; eDate.onchange = (e) => { state.filters.end = e.target.value; updateUI(); }; }
    if(rBtn) rBtn.onclick = () => {
        state.filters.start = `${y}-${m}-01`; state.filters.end = `${y}-${m}-${lastDay}`;
        state.filters.category = ''; state.filters.tag = ''; state.filters.search = '';
        if(sDate) sDate.value = state.filters.start; if(eDate) eDate.value = state.filters.end;
        const cF = document.getElementById('categoryFilter'); if(cF) cF.value = '';
        const tF = document.getElementById('tagFilter'); if(tF) tF.value = '';
        const sF = document.getElementById('searchInput'); if(sF) sF.value = '';
        updateUI();
    };

    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.oninput = (e) => { state.filters.search = e.target.value; updateUI(); };
    }

    loadLocal();
    expandFiltersToData(state.transactions);
    document.querySelectorAll('.cur-btn').forEach(b => b.classList.toggle('active', b.dataset.cur === state.displayCurrency));
    updateUI();
    checkAutoBackup();
    fetchRates();
    handleOAuthCallback();
    updateAlfaUI();

    // Auth modal logic
    window.submitLogin = () => {
        const login = (document.getElementById('authLoginInput')?.value || '').trim();
        const pass  = (document.getElementById('authPassInput')?.value  || '').trim();
        const errEl = document.getElementById('authError');

        // Hardcoded credentials for personal use
        const VALID = { login: 'Serge', pass: '2544' };
        if (login !== VALID.login || pass !== VALID.pass) {
            if (errEl) errEl.textContent = '\u041d\u0435\u0432\u0435\u0440\u043d\u044b\u0439 \u043b\u043e\u0433\u0438\u043d \u0438\u043b\u0438 \u043f\u0430\u0440\u043e\u043b\u044c';
            document.getElementById('authPassInput')?.select();
            return;
        }
        if (errEl) errEl.textContent = '';
        state.user_id = login;
        localStorage.setItem('money_user_id', login);
        document.getElementById('authModal').style.display = 'none';
        showToast(`\u0414\u043e\u0431\u0440\u043e \u043f\u043e\u0436\u0430\u043b\u043e\u0432\u0430\u0442\u044c, ${login}!`, 'success');
        loadFromCloud();
    };

    window.skipLogin = () => {
        document.getElementById('authModal').style.display = 'none';
        showToast('\u0420\u0435\u0436\u0438\u043c \u0431\u0435\u0437 \u043e\u0431\u043b\u0430\u043a\u0430. \u0414\u0430\u043d\u043d\u044b\u0435 \u0445\u0440\u0430\u043d\u044f\u0442\u0441\u044f \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u043e', 'info');
    };

    // Show auth modal or load from cloud
    if (!state.user_id) {
        setTimeout(() => {
            document.getElementById('authModal').style.display = 'flex';
            document.getElementById('authLoginInput')?.focus();
        }, 500);
    } else {
        loadFromCloud();
    }
    
    // Attach dropzone listeners with real drag&drop support
    const dz = document.getElementById('dropZone');
    const fi = document.getElementById('fileInput');
    if (dz && fi) {
        dz.onclick = (e) => { if (e.target === dz || e.target.closest('#dropZone') === dz) fi.click(); };
        fi.onchange = (e) => { if (e.target.files.length) handleFiles(e.target.files[0]); };
        dz.ondragover = (e) => { e.preventDefault(); dz.style.borderColor = 'var(--primary-light)'; dz.style.background = 'rgba(82,121,111,0.1)'; };
        dz.ondragleave = () => { dz.style.borderColor = ''; dz.style.background = ''; };
        dz.ondrop = (e) => {
            e.preventDefault();
            dz.style.borderColor = ''; dz.style.background = '';
            const file = e.dataTransfer.files[0];
            if (file && file.name.endsWith('.pdf')) { handleFiles(file); window.closeUpload(); }
            else showToast('Нужен PDF файл', 'error');
        };
    }

    // Configure PDF.js
    if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    // Auth is handled by the modal (submitLogin / skipLogin)
});
