/* EventHub extras. Standalone and optional: <script src="/js/extras.js" defer></script>
   - header shadow, back-to-top, light/dark toggle
   - category strip with icons (built from the hero's category chips)
   - countdown + "selling fast" labels on event cards
   - sticky "Get tickets" bar on phones (event page)

   To light up the labels, add these attributes where your code renders an event card (.ecard):
     data-start="2026-11-14T19:00:00+01:00"   ISO date with timezone (optional: data-end)
     data-left="12" data-capacity="200"        tickets remaining / total   (or data-sold + data-capacity)
   For a countdown on the event page, put data-start on .ev-hero. */
(function () {
  'use strict';
  // Category display on the home page: 'chips' = your original small chips with a small icon (default),
  // 'tiles' = the large floating icon panel under the hero.
  var CATEGORY_STYLE = 'chips';
  var root = document.documentElement;
  var P = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.4 1-3 0 1.7 1 2.5 2.5 2.5z"/>',
    all: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    night: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/><path d="M17 3v3M15.5 4.5h3"/>',
    tech: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
    food: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/>',
    arts: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.7-.7 1.7-1.6 0-.4-.2-.8-.5-1.1-.3-.3-.5-.7-.5-1.1 0-.9.7-1.7 1.7-1.7H16c3.3 0 6-2.7 6-6 0-4.9-4.5-8.5-10-8.5z"/>',
    sports: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.7V17c0 .6-.5 1-1.1 1.2C7.8 18.8 7 20.2 7 22M14 14.7V17c0 .6.5 1 1.1 1.2 1.1.6 1.9 2 1.9 3.8M18 2H6v7a6 6 0 0 0 12 0V2z"/>',
    business: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    edu: '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
    health: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z"/>',
    comedy: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
    community: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    festival: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    film: '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 3v18M17 3v18M2 12h20M2 7.5h5M2 16.5h5M17 7.5h5M17 16.5h5"/>',
    conf: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8"/>',
    ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M13 5v2M13 17v2M13 11v2"/>'
  };
  var MAP = [
    [/^(all|every|browse|explore|trending|popular)/i, 'all'], [/night|club|part(y|ies)|rave|lounge/i, 'night'],
    [/music|concert|gig|\bdj\b|band|jazz|choir|opera/i, 'music'], [/tech|startup|develop|digital|\bai\b|software|crypto/i, 'tech'],
    [/food|drink|dining|culinary|wine|cook|market|brunch/i, 'food'], [/\barts?\b|culture|gallery|theat|exhibit|design|dance/i, 'arts'],
    [/sport|fitness|run|game|match|football|soccer|basketball/i, 'sports'], [/business|network|career|financ|professional|entrepreneur/i, 'business'],
    [/educat|learn|workshop|class|school|course|seminar|training/i, 'edu'], [/health|well|yoga|medit|beauty/i, 'health'],
    [/comed|stand-?up|laugh/i, 'comedy'], [/communit|social|meetup|charit|faith|church|religio|famil|kids/i, 'community'],
    [/festival|carnival|fair|holiday/i, 'festival'], [/film|cinema|movie/i, 'film'], [/conference|summit|talk|expo|panel/i, 'conf']
  ];
  function ico(n) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[n] || P.ticket) + '</svg>'; }
  function iconFor(label) { for (var i = 0; i < MAP.length; i++) if (MAP[i][0].test(label)) return MAP[i][1]; return 'ticket'; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function setText(el, t) { if (el.textContent !== t) el.textContent = t; }
  function setHTML(el, h) { if (el.getAttribute('data-h') !== h) { el.innerHTML = h; el.setAttribute('data-h', h); } }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

  /* ---- theme toggle ---- */
  function isDark() { var t = root.getAttribute('data-theme'); return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches; }
  function paintToggle(b) { var d = isDark(); b.innerHTML = ico(d ? 'sun' : 'moon'); b.setAttribute('aria-label', d ? 'Switch to light mode' : 'Switch to dark mode'); }
  function toggleTheme() { var next = isDark() ? 'light' : 'dark'; root.setAttribute('data-theme', next); try { localStorage.setItem('eh-theme', next); } catch (e) {} }
  function paintSide(b) { var d = isDark(); b.innerHTML = '<span class="ico">' + ico(d ? 'sun' : 'moon') + '</span>' + (d ? 'Light mode' : 'Dark mode'); }
  function addSideToggle() {
    var side = document.querySelector('.side');
    if (!side || side.querySelector('.theme-btn')) return;
    var b = document.createElement('button'); b.type = 'button'; b.className = 'nav-item theme-btn'; paintSide(b);
    b.addEventListener('click', function () { toggleTheme(); paintSide(b); });
    side.insertBefore(b, side.querySelector('.spacer'));
  }
  function addToggle() {
    var nav = document.querySelector('.site-header .nav');
    if (!nav || nav.querySelector('.theme-toggle')) return;
    var b = document.createElement('button'); b.type = 'button'; b.className = 'theme-toggle'; paintToggle(b);
    b.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark'; root.setAttribute('data-theme', next);
      try { localStorage.setItem('eh-theme', next); } catch (e) {} paintToggle(b);
    });
    nav.appendChild(b);
  }

  /* ---- category strip (built from the hero chips; chips elsewhere just get icons) ---- */
  function catStrip() {
    var hero = document.querySelector('.hero');
    if (CATEGORY_STYLE === 'tiles' && hero && !document.querySelector('.catstrip-section')) {
      var chips = $all('.chips a.chip', hero);
      if (chips.length) {
        var html = '<div class="wrap"><nav class="catstrip" aria-label="Browse by category">';
        var hasAll = chips.some(function (c) { return /^all\b/i.test(c.textContent.trim()); });
        if (!hasAll) html += '<a class="cat" href="/events"><span class="cat-ic">' + ico('all') + '</span><span class="cat-name">All events</span></a>';
        chips.forEach(function (c) {
          var raw = c.textContent.trim(), m = raw.match(/^(.*?)\s*\((\d+)\)$/), label = m ? m[1] : raw;
          html += '<a class="cat' + (c.classList.contains('on') ? ' on' : '') + '" href="' + esc(c.getAttribute('href') || '#') + '"><span class="cat-ic">' + ico(iconFor(label)) + '</span><span class="cat-name">' + esc(label) + (m ? '<small>' + esc(m[2]) + (m[2] === '1' ? ' event' : ' events') + '</small>' : '') + '</span></a>';
        });
        var sec = document.createElement('section'); sec.className = 'catstrip-section'; sec.innerHTML = html + '</nav></div>';
        hero.insertAdjacentElement('afterend', sec);
        hero.querySelector('.chips').setAttribute('data-upgraded', '');
      }
    }
    $all('.chip:not([data-ic])').forEach(function (c) {
      if ((CATEGORY_STYLE === 'tiles' && c.closest('.hero')) || c.querySelector('svg')) return;
      c.setAttribute('data-ic', ''); var s = document.createElement('span'); s.className = 'chip-ic'; s.innerHTML = ico(iconFor(c.textContent.trim())); c.insertBefore(s, c.firstChild);
    });
  }

  /* ---- countdown + urgency ---- */
  function parts(ms) { var m = Math.floor(ms / 6e4), h = Math.floor(m / 60), d = Math.floor(h / 24); return { m: m, h: h, d: d }; }
  function shortCount(start, end) {
    var now = Date.now(); if (isNaN(start) || now > (end || start + 3 * 36e5)) return null;
    if (start <= now) return { t: 'Happening now', live: true };
    var p = parts(start - now);
    if (p.m < 60) return { t: 'Starts in ' + Math.max(p.m, 1) + ' min' };
    if (p.h < 24) return { t: 'Starts in ' + p.h + 'h ' + (p.m % 60) + 'm' };
    var days = Math.ceil((start - now) / 864e5);
    if (days < 7) return { t: 'In ' + days + ' day' + (days > 1 ? 's' : '') };
    return null;
  }
  function longCount(start, end) {
    var now = Date.now(); if (isNaN(start) || now > (end || start + 3 * 36e5)) return null;
    if (start <= now) return { t: 'Happening now', live: true };
    var p = parts(start - now), out = [];
    if (p.d) out.push(p.d + 'd'); out.push((p.h % 24) + 'h'); out.push((p.m % 60) + 'm');
    return { t: 'Starts in ' + out.join(' ') };
  }
  function refreshCard(c) {
    var img = c.querySelector('.ecard-img'), foot = c.querySelector('.ecard-foot');
    var st = Date.parse(c.getAttribute('data-start') || ''), en = Date.parse(c.getAttribute('data-end') || '');
    if (img && c.hasAttribute('data-start')) {
      var chip = img.querySelector('.ecard-count'), r = shortCount(st, en);
      if (r) {
        if (!chip) { chip = document.createElement('span'); chip.className = 'ecard-count'; img.appendChild(chip); }
        setText(chip, r.t); chip.classList.toggle('live', !!r.live);
      } else if (chip) chip.remove();
    }
    if (foot) {
      var cap = parseFloat(c.getAttribute('data-capacity')), left = parseFloat(c.getAttribute('data-left'));
      if (isNaN(left) && c.hasAttribute('data-sold') && !isNaN(cap)) left = cap - parseFloat(c.getAttribute('data-sold'));
      var hot = foot.querySelector('.hot'), label = null, out = false;
      if (!isNaN(left)) {
        if (left <= 0) { label = 'Sold out'; out = true; }
        else if (left <= 10) label = 'Only ' + left + ' left';
        else if (!isNaN(cap) && cap > 0 && left / cap <= 0.2) label = 'Selling fast';
      }
      c.classList.toggle('off', out);
      if (label) {
        if (!hot) { hot = document.createElement('span'); hot.className = 'hot'; foot.appendChild(hot); }
        hot.classList.toggle('out', out); setHTML(hot, (out ? '' : ico('flame')) + esc(label));
      } else if (hot) hot.remove();
    }
  }
  function refreshHero() {
    var h = document.querySelector('.ev-hero[data-start]'); if (!h) return;
    var r = longCount(Date.parse(h.getAttribute('data-start')), Date.parse(h.getAttribute('data-end') || '')), el = h.querySelector('.cd-inline');
    if (!r) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('span'); el.className = 'cd-inline'; (h.querySelector('.meta') || h.querySelector('.wrap') || h).appendChild(el); }
    setText(el, r.t); el.classList.toggle('live', !!r.live);
  }
  function refreshAll() { $all('.ecard[data-start],.ecard[data-left],.ecard[data-sold]').forEach(refreshCard); refreshHero(); }

  /* ---- sticky "Get tickets" bar (phones) ---- */
  var watched = null, io = null;
  function cheapest() {
    var best = null;
    $all('.buy .tt:not(.off) .tt-price').forEach(function (el) {
      var t = el.textContent.trim(), n = /free/i.test(t) ? 0 : parseFloat(t.replace(/[^\d.]/g, ''));
      if (!isNaN(n) && (!best || n < best.n)) best = { n: n, t: t };
    });
    return best;
  }
  function markPicked() {
    $all('.buy .tt').forEach(function (tt) { var o = tt.querySelector('.qty output'); tt.classList.toggle('picked', !!o && o.textContent.trim() !== '0'); });
  }
  function stickyBuy() {
    var buy = document.querySelector('.ev-layout .buy'), bar = document.querySelector('.getbar');
    markPicked();
    if (!buy || !buy.querySelector('.qty')) { if (bar) { bar.remove(); document.body.classList.remove('has-getbar'); } return; }
    if (!bar) {
      bar = document.createElement('div'); bar.className = 'getbar';
      bar.innerHTML = '<div><div class="gb-from"></div><div class="gb-price"></div></div><button type="button" class="btn coral gb-btn">Get tickets</button>';
      bar.querySelector('.gb-btn').addEventListener('click', function () { var b = document.querySelector('.ev-layout .buy'); if (b) b.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      document.body.appendChild(bar); document.body.classList.add('has-getbar');
    }
    if (watched !== buy && 'IntersectionObserver' in window) {
      if (io) io.disconnect();
      io = new IntersectionObserver(function (es) { bar.classList.toggle('show', !es[0].isIntersecting); }, { threshold: 0.12 });
      io.observe(buy); watched = buy;
    }
    var p = cheapest(), any = document.querySelector('.buy .tt');
    setText(bar.querySelector('.gb-from'), p ? (p.n === 0 ? 'Tickets' : 'From') : 'Tickets');
    setText(bar.querySelector('.gb-price'), p ? p.t : (any ? 'Sold out' : 'Available'));
  }

  /* ---- header shadow + back to top ---- */
  var fab = document.createElement('button'); fab.type = 'button'; fab.className = 'fab'; fab.setAttribute('aria-label', 'Back to top'); fab.innerHTML = ico('up');
  fab.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); }); document.body.appendChild(fab);
  function onScroll() {
    var y = window.scrollY || 0, h = document.querySelector('.site-header');
    if (h) h.classList.toggle('scrolled', y > 8); fab.classList.toggle('show', y > 700);
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---- run now, on every render, and on a slow tick ---- */
  var queued = false;
  function enhance() { queued = false; addToggle(); addSideToggle(); catStrip(); refreshAll(); stickyBuy(); onScroll(); }
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(enhance); } }
  enhance();
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  setInterval(refreshAll, 30000);
})();