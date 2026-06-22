/* MenuVoice v3 — scroll-driven demo, canvas waveform, voice-pulse + typewriter */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ═══ Canvas oscilloscope waveform ═══════════════════════════════════ */
  function initWave(canvas, opts) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var t = 0, raf;
    opts = opts || {};
    var layers = opts.layers || [
      { freq: 0.008, amp: 0.16, speed: 0.014, alpha: 0.52, w: 1.8 },
      { freq: 0.013, amp: 0.09, speed: 0.022, alpha: 0.28, w: 1.2 },
      { freq: 0.005, amp: 0.11, speed: 0.009, alpha: 0.16, w: 2.6 },
    ];

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width  = canvas.offsetWidth  * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      var W = canvas.offsetWidth, H = canvas.offsetHeight;
      ctx.clearRect(0, 0, W, H);

      if (reduce) {
        // Static single wave
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,180,84,0.3)';
        ctx.lineWidth = 1.8;
        for (var x = 0; x <= W; x += 2) {
          var y = H / 2 + Math.sin(x * 0.009) * (H * 0.2);
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        return;
      }

      layers.forEach(function (l) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,180,84,' + l.alpha + ')';
        ctx.lineWidth = l.w;
        ctx.lineCap = 'round';
        for (var x = 0; x <= W; x += 1.5) {
          var phase = x * l.freq + t * l.speed;
          var raw = Math.sin(phase) * (H * l.amp) + Math.sin(phase * 1.618) * (H * l.amp * 0.36);
          var fade = Math.min(1, Math.min(x / 60, (W - x) / 60));
          var y = H / 2 + raw * fade;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      });

      t++;
      raf = requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener('resize', resize);
    draw();
    return function () { cancelAnimationFrame(raf); };
  }

  /* ═══ Right-side bar-chart visualiser ════════════════════════════════ */
  function initVizCanvas() {
    var canvas = document.getElementById('viz-canvas');
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var t = 0;
    var activePhase = 'scan'; // updated by scroll demo

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width  = canvas.offsetWidth  * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      var W = canvas.offsetWidth, H = canvas.offsetHeight;
      ctx.clearRect(0, 0, W, H);

      var n = 18;
      var bw = (W - n * 4) / n;
      var speedMult = activePhase === 'convo' ? 1.8 : activePhase === 'reading' ? 1.2 : 0.5;

      for (var i = 0; i < n; i++) {
        var h;
        if (reduce) {
          h = H * (0.15 + (i / n) * 0.55 * Math.sin(i * 0.9));
          h = Math.max(H * 0.06, h);
        } else {
          h = H * (0.10 +
            Math.abs(Math.sin(i * 0.38 + t * 0.03 * speedMult)) * 0.44 +
            Math.abs(Math.sin(i * 0.71 + t * 0.05 * speedMult)) * 0.24 +
            Math.abs(Math.sin(i * 1.15 + t * 0.02 * speedMult)) * 0.10);
          h = Math.min(H * 0.94, Math.max(H * 0.05, h));
        }
        var alpha = 0.22 + 0.78 * (h / H);
        ctx.fillStyle = 'rgba(255,180,84,' + alpha + ')';
        var x = i * (bw + 4);
        var y = (H - h) / 2;
        var r = Math.min(bw / 2, 4);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + bw - r, y);
        ctx.arcTo(x + bw, y, x + bw, y + r, r);
        ctx.lineTo(x + bw, y + h - r);
        ctx.arcTo(x + bw, y + h, x + bw - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
        ctx.fill();
      }

      t++;
      requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener('resize', resize);
    draw();
    window.__setVizPhase = function (p) { activePhase = p; };
  }

  /* ═══ Scroll-driven demo ════════════════════════════════════════════ */
  var MSGS = [
    { r: 'a', plain: 'Good evening. The Greenhouse has eighteen dishes tonight, in four sections. Want the highlights?', html: null },
    { r: 'u', plain: 'Something vegetarian, nothing pricey.', html: null },
    { r: 'a', plain: 'Three under twelve pounds: squash risotto, halloumi flatbread, or the lentil dahl.', html: null },
    { r: 'u', plain: 'Which would you order?', html: null },
    { r: 'a', plain: 'The dahl \u2014 it\u2019s the kitchen\u2019s best-rated dish tonight.', html: 'The <b>dahl</b> \u2014 it\u2019s the kitchen\u2019s best-rated dish tonight.' },
    { r: 'u', plain: 'Perfect. The dahl, please.', html: null },
  ];

  var PHASE_ORDER = ['scan', 'capture', 'reading', 'convo'];

  function initScrollDemo() {
    var section  = document.getElementById('demo-section');
    if (!section) return;

    var psCam    = document.getElementById('ps-cam');
    var psRead   = document.getElementById('ps-read');
    var psConvo  = document.getElementById('ps-convo');
    var demoCam  = document.getElementById('demo-cam');
    var demoCoach = document.getElementById('demo-coach');
    var cvConv   = document.getElementById('cv-conv');
    var cvPhase  = document.getElementById('cv-phase');
    var cvPhaseTxt = document.getElementById('cv-phase-txt');
    var cvBarFill  = document.getElementById('cv-bar-fill');
    var progFill  = document.getElementById('demo-prog-fill');
    var scrollCue = document.getElementById('scroll-cue');
    var trail     = document.getElementById('phase-trail');
    var labels    = trail ? Array.prototype.slice.call(trail.querySelectorAll('.ptlabel')) : [];

    var currentPhase = null;
    var convoStarted = false;
    var camTimer = null;
    var autoTimer = null;
    var autoIdx = 0;
    var camIdx = 0;
    var CAM_PHASES = ['Finding the menu\u2026', 'Hold still\u2026', 'Got it!', 'Reading\u2026'];
    var CAM_DELAYS = [1600, 1400, 850, 1800];
    var AUTO_DELAYS = [1900, 1100, 1900, 4200];

    /* ── Label trail: active → stays on screen as 'seen' ── */
    function setPhase(pid) {
      if (pid === currentPhase) return;
      currentPhase = pid;
      if (window.__setVizPhase) window.__setVizPhase(pid);

      var idx = PHASE_ORDER.indexOf(pid);
      labels.forEach(function (el) {
        var li = PHASE_ORDER.indexOf(el.dataset.pid);
        el.classList.remove('active', 'seen');
        if (li < idx)       el.classList.add('seen');   // past — stays, dimmed
        else if (li === idx) el.classList.add('active'); // current — full
        // future labels stay invisible
      });

      // Switch phone screen
      if (pid === 'scan' || pid === 'capture') {
        show(psCam); hide(psRead); hide(psConvo);
      } else if (pid === 'reading') {
        hide(psCam); show(psRead); hide(psConvo);
        stopCam();
        psRead.classList.remove('me-playing');
        void psRead.offsetWidth;
        psRead.classList.add('me-playing');
      } else if (pid === 'convo') {
        hide(psCam); hide(psRead); show(psConvo);
        stopCam();
        startConvo();
      }
      if (pid !== 'convo') convoStarted = false;

      // Cam phases
      if (pid === 'scan') startCam();
      if (pid === 'capture' && demoCam) {
        stopCam();
        demoCam.dataset.phase = '2';
        if (demoCoach) demoCoach.textContent = 'Got it!';
      }
    }

    function show(el) { if (el) el.style.display = 'flex'; }
    function hide(el) { if (el) el.style.display = 'none'; }

    function startCam() {
      if (camTimer) return;
      camIdx = 0; tickCam();
    }
    function stopCam() { clearTimeout(camTimer); camTimer = null; }
    function tickCam() {
      if (!demoCam) return;
      demoCam.dataset.phase = String(camIdx);
      if (demoCoach) demoCoach.textContent = CAM_PHASES[camIdx];
      var d = CAM_DELAYS[camIdx];
      camIdx = (camIdx + 1) % 4;
      camTimer = setTimeout(tickCam, d);
    }

    /* ── Conversation ── */
    function startConvo() {
      if (convoStarted) return;
      convoStarted = true;
      cvConv.innerHTML = '';
      if (reduce) {
        MSGS.forEach(function (m) { addMsg(m, null, true); });
        addDone(); return;
      }
      scheduleMsg(0);
    }

    function scheduleMsg(i) {
      if (i >= MSGS.length) { setTimeout(addDone, 180); return; }
      var gap = i === 0 ? 80 : 160;
      setTimeout(function () { addMsg(MSGS[i], function () { scheduleMsg(i + 1); }, false); }, gap);
    }

    function addMsg(msg, cb, instant) {
      var turn = document.createElement('div');
      turn.className = 'cv-turn ' + msg.r;
      cvConv.appendChild(turn);

      turn.innerHTML =
        '<div class="who">' + (msg.r === 'a' ? 'MenuVoice' : 'You') + '</div>' +
        '<div class="txt">' + (msg.html || msg.plain) + '</div>';

      // Update phase indicator
      if (!instant) {
        if (msg.r === 'a') {
          if (cvPhase) cvPhase.classList.remove('idle');
          if (cvPhaseTxt) cvPhaseTxt.textContent = 'MenuVoice is speaking\u2026';
          if (cvBarFill) cvBarFill.style.width = (30 + Math.random() * 55) + '%';
        } else {
          if (cvPhase) cvPhase.classList.add('idle');
          if (cvPhaseTxt) cvPhaseTxt.textContent = 'Your turn. Tap to talk';
          if (cvBarFill) cvBarFill.style.width = '0%';
        }
      }

      scrollBot();
      if (cb) setTimeout(cb, instant ? 0 : 160);
    }

    function addDone() {
      var d = document.createElement('div');
      d.className = 'cv-done';
      d.textContent = '\u2713 Done speaking';
      cvConv.appendChild(d);
      scrollBot();
    }

    function scrollBot() { if (cvConv) cvConv.scrollTop = cvConv.scrollHeight; }

    function runAutoStep() {
      var pid = PHASE_ORDER[autoIdx % PHASE_ORDER.length];
      autoIdx++;
      setPhase(pid);
      autoTimer = setTimeout(runAutoStep, AUTO_DELAYS[PHASE_ORDER.indexOf(pid)] || 2200);
    }

    function startAutoDemo() {
      if (autoTimer) return;
      autoIdx = Math.max(0, PHASE_ORDER.indexOf(currentPhase));
      runAutoStep();
    }

    function stopAutoDemo() {
      clearTimeout(autoTimer);
      autoTimer = null;
    }

    /* ── Mobile fallback: auto-play on intersection ── */
    if (window.innerWidth < 900) {
      setPhase('scan');
      if ('IntersectionObserver' in window) {
        var mio = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) {
              startAutoDemo();
            } else {
              stopAutoDemo();
            }
          });
        }, { threshold: 0.18 });
        mio.observe(section);
      } else {
        startAutoDemo();
      }
      return; // Don't attach scroll listener on mobile
    }

    /* ── Desktop: scroll-driven ── */
    function getProgress() {
      var rect = section.getBoundingClientRect();
      var sH = section.offsetHeight;
      var vH = window.innerHeight;
      var scrolled = Math.max(0, -rect.top);
      var range = Math.max(1, sH - vH);
      return Math.min(1, scrolled / range);
    }

    function update() {
      var p = getProgress();
      if (progFill) progFill.style.width = (p * 100) + '%';
      if (scrollCue) scrollCue.style.opacity = p > 0.05 ? '0' : '1';

      // Thresholds: scan 0-22%, capture 22-40%, reading 40-56%, convo 56%+
      if      (p < 0.22) setPhase('scan');
      else if (p < 0.40) setPhase('capture');
      else if (p < 0.48) setPhase('reading');
      else               setPhase('convo');
    }

    setPhase('scan');
    if ('IntersectionObserver' in window) {
      var dio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) startAutoDemo();
          else stopAutoDemo();
        });
      }, { threshold: 0.22 });
      dio.observe(section);
    } else {
      startAutoDemo();
    }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  /* ═══ Reveal on scroll ══════════════════════════════════════════════ */
  function initReveal() {
    var els = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); }); return;
    }
    var ioFired = false;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { ioFired = true; e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.04, rootMargin: '60px 0px 0px 0px' });
    els.forEach(function (el) { io.observe(el); });
    // Fallback: if IO never fires (iframe quirks), reveal everything after 500ms
    setTimeout(function () {
      if (ioFired) return;
      els.forEach(function (el) { el.classList.add('in'); });
    }, 500);
  }

  /* ═══ Sticky header ═════════════════════════════════════════════════ */
  function initHeader() {
    var head = document.getElementById('head');
    if (!head) return;
    var fn = function () { head.dataset.stuck = window.scrollY > 12 ? '1' : '0'; };
    fn(); window.addEventListener('scroll', fn, { passive: true });
  }

  /* ═══ Form ══════════════════════════════════════════════════════════ */
  function initForm() {
    var form = document.getElementById('waitlist-form');
    var msg  = document.getElementById('cta-msg');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = document.getElementById('email');
      var val = (input.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        msg.style.color = 'var(--danger)';
        msg.textContent = 'Please enter a valid email address.';
        input.focus(); return;
      }
      msg.style.color = 'var(--success)';
      msg.textContent = 'Thanks \u2014 you\u2019re on the list. We\u2019ll be in touch personally.';
      form.reset();
    });
  }

  /* ═══ Boot ══════════════════════════════════════════════════════════ */
  function init() {
    initReveal();
    initHeader();
    initForm();

    initWave(document.getElementById('hero-canvas'), {
      layers: [
        { freq: 0.007, amp: 0.14, speed: 0.012, alpha: 0.48, w: 1.8 },
        { freq: 0.012, amp: 0.08, speed: 0.020, alpha: 0.24, w: 1.2 },
        { freq: 0.004, amp: 0.10, speed: 0.008, alpha: 0.14, w: 2.8 },
      ]
    });

    initWave(document.getElementById('cta-canvas'), {
      layers: [
        { freq: 0.011, amp: 0.30, speed: 0.018, alpha: 0.65, w: 2.2 },
        { freq: 0.016, amp: 0.18, speed: 0.026, alpha: 0.38, w: 1.4 },
      ]
    });

    initVizCanvas();
    initScrollDemo();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
