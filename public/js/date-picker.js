'use strict';

// Výběr data v českém formátu (d. m. rrrr) s kalendářem od pondělí. Nativní <input type="date">
// se řídí jazykem prohlížeče (v anglickém mm/dd/yyyy a týden od neděle), proto vlastní.
//   DatePicker.attach(input) → input.getIso() ('' = prázdné, null = neplatné), input.setIso('2026-11-11')
(function () {
  const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
  const WEEKDAYS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
  const pad = (n) => String(n).padStart(2, '0');
  const toIso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const format = (iso) => (iso ? `${Number(iso.slice(8))}. ${Number(iso.slice(5, 7))}. ${iso.slice(0, 4)}` : '');

  /** „11. 11. 2026“, „11.11.2026“ → "2026-11-11"; neplatné → null */
  function parse(text) {
    const m = String(text || '').trim().match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/);
    if (!m) return null;
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    return toIso(y, mo, d);
  }

  const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  let openPicker = null; // jen jeden otevřený kalendář naráz

  function attach(input) {
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.placeholder = input.placeholder || 'd. m. rrrr';
    const wrap = document.createElement('span');
    wrap.className = 'date-picker';
    input.replaceWith(wrap);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'date-picker__button';
    button.setAttribute('aria-label', 'Vybrat v kalendáři');
    button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
    const popup = document.createElement('div');
    popup.className = 'date-picker__popup';
    popup.hidden = true;
    wrap.append(input, button, popup);

    let shown = null; // zobrazený měsíc { y, m }

    input.getIso = () => (input.value.trim() ? parse(input.value) : '');
    input.setIso = (iso) => { input.value = format(iso); };

    function render() {
      const { y, m } = shown;
      const first = new Date(Date.UTC(y, m - 1, 1));
      const offset = (first.getUTCDay() + 6) % 7; // pondělí = 0
      const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const selected = input.getIso();
      const today = todayIso();
      let cells = '';
      for (let i = 0; i < offset; i++) cells += '<span></span>';
      for (let d = 1; d <= days; d++) {
        const iso = toIso(y, m, d);
        const weekday = (offset + d - 1) % 7;
        const classes = ['date-picker__day', iso === selected && 'is-selected', iso === today && 'is-today', weekday >= 5 && 'is-weekend'].filter(Boolean).join(' ');
        cells += `<button type="button" class="${classes}" data-iso="${iso}">${d}</button>`;
      }
      popup.innerHTML = `<div class="date-picker__nav">
          <button type="button" data-shift="-1" aria-label="Předchozí měsíc">‹</button>
          <strong>${MONTHS[m - 1]} ${y}</strong>
          <button type="button" data-shift="1" aria-label="Další měsíc">›</button>
        </div>
        <div class="date-picker__grid">${WEEKDAYS.map((w, i) => `<span class="date-picker__weekday${i >= 5 ? ' is-weekend' : ''}">${w}</span>`).join('')}${cells}</div>`;
    }

    function open() {
      if (openPicker && openPicker !== close) openPicker();
      const base = input.getIso() || input.dataset.defaultIso || todayIso();
      shown = { y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)) };
      render();
      popup.hidden = false;
      openPicker = close;
    }
    function close() {
      popup.hidden = true;
      if (openPicker === close) openPicker = null;
    }

    button.addEventListener('click', () => (popup.hidden ? open() : close()));
    popup.addEventListener('click', (ev) => {
      const shift = ev.target.closest('[data-shift]');
      if (shift) {
        const next = new Date(Date.UTC(shown.y, shown.m - 1 + Number(shift.dataset.shift), 1));
        shown = { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1 };
        render();
        return;
      }
      const day = ev.target.closest('[data-iso]');
      if (!day) return;
      input.setIso(day.dataset.iso);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      close();
      input.focus();
    });
    // po ručním zápisu sjednotit tvar („11.11.2026“ → „11. 11. 2026“)
    input.addEventListener('blur', () => { const iso = input.getIso(); if (iso) input.setIso(iso); });
    document.addEventListener('pointerdown', (ev) => { if (!popup.hidden && !wrap.contains(ev.target)) close(); });
    wrap.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !popup.hidden) { close(); input.focus(); } });
    return input;
  }

  window.DatePicker = { attach, parse, format };
})();
