// 棋盤：CSS grid + SVG 棋子。支援點選走子、拖曳走子（Pointer Events）、
// 合法著法提示、升變選單、滑動動畫。全部手寫，不依賴外部程式庫。
const FILES = 'abcdefgh';
const ANIM_MS = 150;

function parseFen(fen) {
  const map = {};
  const rows = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r] || '') {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      map[FILES[f] + (8 - r)] = color + ch.toUpperCase();
      f++;
    }
  }
  return map;
}

function pieceImg(code) {
  const img = document.createElement('img');
  img.src = 'vendor/pieces/' + code + '.svg';
  img.alt = '';
  img.draggable = false;
  return img;
}

// cfg: { fen, orientation, last:{from,to}, check:sq, hl:[sq…]（提示用的藍框）, status:'ok'|'bad'|'',
//        interactive, turn:'w'|'b', legal:(sq)=>verboseMoves, onMove:(from,to,promo)=>void, animate }
export class Board {
  constructor(host, { mini = false } = {}) {
    this.host = host;
    this.mini = mini;
    this.cfg = {};
    this.orientation = null;
    this.pos = {};
    this.fen = null;
    this.selected = null;
    this.targets = [];
    this.d = null;          // 目前按下的狀態
    this.ghost = null;
    this.over = null;
    this.menu = null;
    this._skip = false;
    this._build('white');
  }

  _build(orientation) {
    this._cancelDrag();
    this.orientation = orientation;
    const el = document.createElement('div');
    el.className = 'board' + (this.mini ? ' mini' : '');
    el.setAttribute('role', 'grid');
    el.setAttribute('aria-label', '棋盤');
    this.sq = {};
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const name = this._name(c, r);
        const d = document.createElement('div');
        d.dataset.sq = name;
        d._img = null;
        d._code = '';
        if (!this.mini) {
          if (c === 0) { const s = document.createElement('span'); s.className = 'coord r'; s.textContent = name[1]; d.appendChild(s); }
          if (r === 7) { const s = document.createElement('span'); s.className = 'coord f'; s.textContent = name[0]; d.appendChild(s); }
        }
        this.sq[name] = d;
        el.appendChild(d);
      }
    }
    this.el = el;
    if (!this.mini) {
      el.addEventListener('pointerdown', e => this._down(e));
      el.addEventListener('pointermove', e => this._move(e));
      el.addEventListener('pointerup', e => this._up(e));
      el.addEventListener('pointercancel', e => this._cancelPointer(e));
      el.addEventListener('lostpointercapture', e => this._cancelPointer(e));
      el.addEventListener('contextmenu', e => e.preventDefault());
    }
    this.host.replaceChildren(el);
    this.pos = {};
    this.fen = null;
  }

  _name(c, r) {
    const flip = this.orientation === 'black';
    const fi = flip ? 7 - c : c;
    const rk = flip ? r + 1 : 8 - r;
    return FILES[fi] + rk;
  }

  _cell(sq) {
    const flip = this.orientation === 'black';
    const fi = FILES.indexOf(sq[0]);
    const rk = Number(sq[1]);
    return { c: flip ? 7 - fi : fi, r: flip ? rk - 1 : 8 - rk };
  }

  _geom(x, y) {
    const rect = this.el.getBoundingClientRect();
    const s = this.el.clientWidth / 8;
    const cx = (x - rect.left - this.el.clientLeft) / s;
    const cy = (y - rect.top - this.el.clientTop) / s;
    if (cx < 0 || cy < 0 || cx >= 8 || cy >= 8) return null;
    return this._name(Math.floor(cx), Math.floor(cy));
  }

  _center(sq) {
    const rect = this.el.getBoundingClientRect();
    const s = this.el.clientWidth / 8;
    const { c, r } = this._cell(sq);
    return { x: rect.left + this.el.clientLeft + (c + 0.5) * s, y: rect.top + this.el.clientTop + (r + 0.5) * s, s };
  }

  _own(sq) {
    const p = this.pos[sq];
    return !!(this.cfg.interactive && p && p[0] === this.cfg.turn);
  }

  _legalTargets(sq) {
    try {
      return (this.cfg.legal ? this.cfg.legal(sq) : []).map(m => ({ sq: m.to, cap: !!m.captured || String(m.flags || '').includes('e') }));
    } catch (e) { return []; }
  }

  set(cfg) {
    const o = cfg.orientation === 'black' ? 'black' : 'white';
    if (o !== this.orientation) this._build(o);
    this._cancelDrag();
    this._closeMenu();
    const old = this.pos;
    const now = parseFen(cfg.fen);
    if (cfg.fen !== this.fen || !cfg.interactive) { this.selected = null; this.targets = []; }
    this.cfg = cfg;
    this.fen = cfg.fen;
    this.pos = now;
    for (const [name, d] of Object.entries(this.sq)) {
      const code = now[name] || '';
      if (d._code !== code) {
        if (d._img) d._img.remove();
        d._img = null;
        if (code) { d._img = pieceImg(code); d.appendChild(d._img); }
        d._code = code;
      }
    }
    this.el.classList.toggle('ok', cfg.status === 'ok');
    this.el.classList.toggle('bad', cfg.status === 'bad');
    this.el.classList.toggle('interactive', !!cfg.interactive);
    this.paint();
    const anim = cfg.animate && !this._skip;
    if (anim && cfg.last && Object.keys(old).length) this._animateMove(old, now, cfg.last);
  }

  paint() {
    const last = this.cfg.last;
    const tmap = new Map(this.targets.map(t => [t.sq, t]));
    for (const [name, d] of Object.entries(this.sq)) {
      const dark = (FILES.indexOf(name[0]) + Number(name[1])) % 2 === 0;
      let cls = 'sq ' + (dark ? 'dark' : 'light');
      if (last && (name === last.from || name === last.to)) cls += ' last';
      if (name === this.selected) cls += ' sel';
      if (tmap.has(name)) cls += ' target' + (tmap.get(name).cap ? ' cap' : '');
      if (name === this.cfg.check) cls += ' incheck';
      if (this.cfg.hl && this.cfg.hl.includes(name)) cls += ' hint';
      if (this.d && this.d.dragging && name === this.d.from) cls += ' src';
      if (name === this.over) cls += ' over';
      d.className = cls;
    }
  }

  /* ---------- 動畫 ---------- */

  _slide(toSq, fromSq) {
    const to = this.sq[toSq] && this.sq[toSq]._img;
    if (!to || !this.sq[fromSq]) return;
    const a = this.sq[fromSq].getBoundingClientRect();
    const b = this.sq[toSq].getBoundingClientRect();
    to.style.transition = 'none';
    to.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px)`;
    to.style.zIndex = '3';
    void to.offsetWidth;
    to.style.transition = `transform ${ANIM_MS}ms ease-out`;
    to.style.transform = '';
    setTimeout(() => { to.style.zIndex = ''; to.style.transition = ''; }, ANIM_MS + 60);
  }

  _animateMove(old, now, last) {
    const { from, to } = last;
    if (!old[from] || !now[to] || from === to) return;
    this._slide(to, from);
    // 王車易位：同時滑動車
    if (old[from][1] === 'K' && now[to] === old[from] && Math.abs(FILES.indexOf(to[0]) - FILES.indexOf(from[0])) === 2) {
      const rank = from[1];
      if (to[0] === 'g') this._slide('f' + rank, 'h' + rank);
      else if (to[0] === 'c') this._slide('d' + rank, 'a' + rank);
    }
  }

  /* ---------- 指標事件 ---------- */

  _down(e) {
    if (!this.cfg.interactive) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest && e.target.closest('.promo')) return;
    if (this.d) return;
    if (this.menu) {
      this._closeMenu();
      this.selected = null; this.targets = [];
      this.paint();
      return;
    }
    const sq = this._geom(e.clientX, e.clientY);
    if (!sq) return;
    e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件可能不能 capture */ }
    const own = this._own(sq);
    this.d = { id: e.pointerId, from: sq, own, x0: e.clientX, y0: e.clientY, dragging: false, wasSel: this.selected === sq };
    if (own && !this.d.wasSel) {
      this.selected = sq;
      this.targets = this._legalTargets(sq);
      this.paint();
    }
  }

  _move(e) {
    const d = this.d;
    if (!d || e.pointerId !== d.id) return;
    if (!d.dragging) {
      if (!d.own) return;
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
      this._startDrag();
    }
    this._moveGhost(e.clientX, e.clientY);
    const hover = this._geom(e.clientX, e.clientY);
    if (hover !== this.over) { this.over = hover; this.paint(); }
  }

  _startDrag() {
    const d = this.d;
    d.dragging = true;
    const g = pieceImg(this.pos[d.from]);
    const size = this.el.clientWidth / 8 * 1.2;
    g.className = 'drag-ghost';
    g.style.width = size + 'px';
    g.style.height = size + 'px';
    g.dataset.size = String(size);
    document.body.appendChild(g);
    this.ghost = g;
    this.selected = d.from;
    this.targets = this._legalTargets(d.from);
    this.paint();
  }

  _moveGhost(x, y) {
    const g = this.ghost;
    if (!g) return;
    const s = Number(g.dataset.size);
    g.style.transform = `translate(${x - s / 2}px, ${y - s / 2}px)`;
  }

  _removeGhost(bounceTo) {
    const g = this.ghost;
    this.ghost = null;
    if (!g) return;
    if (bounceTo) {
      const c = this._center(bounceTo);
      const s = Number(g.dataset.size);
      g.style.transition = `transform ${ANIM_MS}ms ease-out`;
      g.style.transform = `translate(${c.x - s / 2}px, ${c.y - s / 2}px)`;
      setTimeout(() => g.remove(), ANIM_MS + 30);
    } else {
      g.remove();
    }
  }

  _up(e) {
    const d = this.d;
    if (!d || e.pointerId !== d.id) return;
    this.d = null;
    try { this.el.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    this.over = null;
    if (d.dragging) {
      const to = this._geom(e.clientX, e.clientY);
      const ok = to && to !== d.from && this.targets.some(t => t.sq === to);
      if (ok) {
        this._removeGhost(null);
        this.paint();
        this._attempt(d.from, to, true);
      } else {
        this._removeGhost(d.from);   // 彈回原位
        this.paint();
      }
      return;
    }
    if (d.own) {
      if (d.wasSel) { this.selected = null; this.targets = []; this.paint(); }
      return;
    }
    if (this.selected && this.targets.some(t => t.sq === d.from)) this._attempt(this.selected, d.from, false);
    else { this.selected = null; this.targets = []; this.paint(); }
  }

  _cancelPointer(e) {
    const d = this.d;
    if (!d || (e.pointerId !== undefined && e.pointerId !== d.id)) return;
    if (e.type === 'lostpointercapture' && !d.dragging) return;
    this._cancelDrag();
    this.paint();
  }

  _cancelDrag() {
    if (this.d && this.d.dragging) this._removeGhost(this.d.from);
    this.d = null;
    this.over = null;
  }

  /* ---------- 走子與升變 ---------- */

  _attempt(from, to, viaDrag) {
    let moves = [];
    try { moves = this.cfg.legal(from).filter(m => m.to === to); } catch (e) { /* 忽略 */ }
    if (!moves.length) { this.paint(); return; }
    if (moves.some(m => m.promotion)) { this._showMenu(from, to, viaDrag); return; }
    this._commit(from, to, undefined, viaDrag);
  }

  _commit(from, to, promo, viaDrag) {
    this.selected = null;
    this.targets = [];
    this._skip = !!viaDrag;
    try {
      if (this.cfg.onMove) this.cfg.onMove(from, to, promo);
    } finally {
      this._skip = false;
    }
    this.paint();
  }

  _showMenu(from, to, viaDrag) {
    this._closeMenu();
    const color = this.pos[from][0];
    const { c, r } = this._cell(to);
    const wrap = document.createElement('div');
    wrap.className = 'promo-scrim';
    const menu = document.createElement('div');
    menu.className = 'promo';
    menu.style.left = (c * 12.5) + '%';
    menu.style.top = r === 0 ? '0' : '50%';
    const order = ['q', 'r', 'b', 'n'];
    if (r !== 0) order.reverse();   // 后永遠最靠近升變格
    for (const p of order) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'promo-btn';
      b.dataset.p = p;
      b.setAttribute('aria-label', { q: '升變為后', r: '升變為車', b: '升變為象', n: '升變為馬' }[p]);
      b.appendChild(pieceImg(color + p.toUpperCase()));
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        this._closeMenu();
        this._commit(from, to, p, viaDrag);
      });
      menu.appendChild(b);
    }
    wrap.appendChild(menu);
    this.el.appendChild(wrap);
    this.menu = wrap;
    this.selected = from;
    this.paint();
  }

  _closeMenu() {
    if (this.menu) { this.menu.remove(); this.menu = null; }
  }
}

// 靜態小棋盤（開局頁用）
export function renderBoard(container, opts) {
  const b = new Board(container, { mini: !!opts.mini });
  b.set({ fen: opts.fen, orientation: opts.orientation, last: opts.last || null, interactive: false });
  return b;
}
