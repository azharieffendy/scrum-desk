/* ================================================================
   Info tooltips: a small "i" mark next to a label (tipIcon / thTip) whose
   explanation shows in one floating bubble on hover, keyboard focus or tap.
   The bubble sits on <body> with position: fixed, so table scrollers and
   panels never clip it. Text may hold line breaks (\n) for paragraphs.
   Globals from app-core.js at run time: esc.
   ================================================================ */
'use strict';

const TIP_GAP = 8;

/** The "i" mark; the text is also in the mark for screen readers. */
function tipIcon(text, label) {
  return `<span class="tip" tabindex="0" data-tip="${esc(text)}"><span aria-hidden="true">i</span><span class="sr-only">${esc(label ? 'About ' + label + ': ' : '')}${esc(text)}</span></span>`;
}

/** A table header cell with its label and an info mark. */
function thTip(label, text, cls) {
  return `<th${cls ? ` class="${cls}"` : ''}><span class="th-tip">${esc(label)}${tipIcon(text, label)}</span></th>`;
}

/** A report stat label with an info mark. */
function statLabel(label, text) {
  return `<span class="stat-label">${esc(label)}${tipIcon(text, label)}</span>`;
}

let tipBubble = null;
let tipTarget = null;

function tipBubbleEl() {
  if (!tipBubble) {
    tipBubble = document.createElement('div');
    tipBubble.className = 'tip-bubble';
    tipBubble.setAttribute('role', 'tooltip');
    tipBubble.setAttribute('aria-hidden', 'true'); // the mark already carries the text for screen readers
    tipBubble.hidden = true;
    document.body.appendChild(tipBubble);
  }
  return tipBubble;
}

/** Shows the bubble under the mark (above it when there is no room), kept inside the window. */
function showTip(el) {
  const bubble = tipBubbleEl();
  tipTarget = el;
  bubble.textContent = el.dataset.tip || '';
  bubble.hidden = false;
  const r = el.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const left = Math.min(Math.max(TIP_GAP, r.left + r.width / 2 - b.width / 2), window.innerWidth - b.width - TIP_GAP);
  const below = r.bottom + TIP_GAP + b.height <= window.innerHeight;
  bubble.style.left = Math.max(TIP_GAP, left) + 'px';
  bubble.style.top = (below ? r.bottom + TIP_GAP : Math.max(TIP_GAP, r.top - b.height - TIP_GAP)) + 'px';
  bubble.classList.toggle('above', !below);
}

function hideTip() {
  if (tipBubble) tipBubble.hidden = true;
  tipTarget = null;
}

const tipOf = (node) => (node && node.closest ? node.closest('.tip') : null);

function initTips() {
  document.addEventListener('mouseover', (e) => {
    const t = tipOf(e.target);
    if (t && t !== tipTarget) showTip(t);
  });
  document.addEventListener('mouseout', (e) => {
    const t = tipOf(e.target);
    if (t && t === tipTarget && !t.contains(e.relatedTarget) && document.activeElement !== t) hideTip();
  });
  document.addEventListener('focusin', (e) => {
    const t = tipOf(e.target);
    if (t) showTip(t);
    else if (tipTarget) hideTip();
  });
  document.addEventListener('focusout', (e) => { if (tipOf(e.target) === tipTarget) hideTip(); });
  // a tap focuses the mark (shows it); tapping anywhere else moves focus away and closes it.
  // The click stops here so a mark inside a clickable row or summary does not trigger it.
  document.addEventListener('click', (e) => {
    const t = tipOf(e.target);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    t.focus();
    showTip(t);
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tipTarget) hideTip(); });
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);
}
