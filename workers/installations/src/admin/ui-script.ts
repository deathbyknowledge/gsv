export const ADMIN_UI_SCRIPT = `
(() => {
  const picker = document.querySelector('[data-column-picker]');
  const table = document.querySelector('[data-user-table]');
  if (picker && table) {
    const storageKey = 'gsv.admin.hidden-columns.v1';
    const headers = [...table.querySelectorAll('thead th[data-column]')];
    const keys = new Set(headers.map(header => header.dataset.column));
    let hidden = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
      if (Array.isArray(saved)) hidden = new Set(saved.filter(key => keys.has(key) && key !== 'identity'));
    } catch { /* Column choices remain usable when browser storage is unavailable. */ }
    const options = picker.querySelector('[data-column-options]');
    const summary = picker.querySelector('summary');
    function apply() {
      for (const cell of table.querySelectorAll('[data-column]')) cell.hidden = hidden.has(cell.dataset.column);
      for (const input of options.querySelectorAll('input')) input.checked = !hidden.has(input.value);
      summary.textContent = 'Columns (' + (headers.length - hidden.size) + '/' + headers.length + ')';
    }
    function save() {
      try { localStorage.setItem(storageKey, JSON.stringify([...hidden])); }
      catch { /* This page still uses the selected columns. */ }
    }
    for (const header of headers) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = header.dataset.column;
      input.disabled = input.value === 'identity';
      label.append(input, document.createTextNode(header.dataset.columnLabel + (input.disabled ? ' (always shown)' : '')));
      input.addEventListener('change', () => {
        if (input.checked) hidden.delete(input.value); else hidden.add(input.value);
        apply();
        save();
      });
      options.append(label);
    }
    picker.querySelector('[data-reset-columns]').addEventListener('click', () => {
      hidden.clear();
      apply();
      save();
    });
    document.addEventListener('click', event => { if (!picker.contains(event.target)) picker.open = false; });
    picker.addEventListener('keydown', event => {
      if (event.key === 'Escape') { picker.open = false; summary.focus(); }
    });
    apply();
    picker.hidden = false;
  }

  for (const button of document.querySelectorAll('[data-copy-email]')) {
    const feedback = button.querySelector('[data-copy-feedback]');
    let reset;
    let copying = false;
    button.addEventListener('click', async () => {
      if (copying) return;
      copying = true;
      clearTimeout(reset);
      let copied = false;
      try {
        await navigator.clipboard.writeText(button.dataset.copyEmail);
        copied = true;
      } catch {
        const field = document.createElement('textarea');
        field.className = 'clipboard-copy-target';
        field.value = button.dataset.copyEmail;
        field.readOnly = true;
        document.body.append(field);
        try { field.select(); copied = document.execCommand('copy'); }
        catch { copied = false; }
        finally { field.remove(); button.focus({ preventScroll: true }); }
      }
      if (!copied) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(button.querySelector('[data-email-text]'));
        if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      }
      feedback.textContent = copied ? 'Copied' : 'Copy manually';
      button.title = copied ? 'Email address copied' : 'Select the email and press Ctrl+C or Command+C';
      copying = false;
      reset = setTimeout(() => { feedback.textContent = 'Copy'; button.title = 'Copy email address'; }, 2500);
    });
  }
})();
`;
