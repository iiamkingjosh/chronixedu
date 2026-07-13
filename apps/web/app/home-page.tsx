'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import './home.css';

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export default function HomePage() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isAnnual, setIsAnnual] = useState(false);

  const prices = {
    monthly: { starter: '₦15k', growth: '₦35k', pro: '₦65k' },
    annual:  { starter: '₦162k', growth: '₦378k', pro: '₦702k' },
  };
  const p = isAnnual ? prices.annual : prices.monthly;
  const period = isAnnual ? '/year' : '/month';

  useEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ── Particles ──
    if (!prefersReduced) {
      const container = document.getElementById('lp-particles');
      if (container) {
        for (let i = 0; i < 18; i++) {
          const el = document.createElement('div');
          el.className = 'hero-particle';
          const size = Math.random() * 120 + 20;
          el.style.cssText = `width:${size}px;height:${size}px;left:${Math.random()*100}%;animation-duration:${Math.random()*20+15}s;animation-delay:${Math.random()*-20}s;`;
          container.appendChild(el);
        }
      }
    }

    // ── Nav scroll ──
    const nav = document.getElementById('lp-nav');
    const scrollTop = document.getElementById('lp-scroll-top');
    const onScroll = () => {
      if (nav) nav.classList.toggle('scrolled', window.scrollY > 20);
      if (scrollTop) scrollTop.classList.toggle('visible', window.scrollY > 400);
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    // ── Smooth nav anchors ──
    const anchorHandler = (e: Event) => {
      const a = (e.target as HTMLElement).closest('a[href^="#"]') as HTMLAnchorElement | null;
      if (!a) return;
      const target = document.querySelector(a.getAttribute('href') ?? '');
      if (target) { e.preventDefault(); window.scrollTo({ top: (target as HTMLElement).getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' }); }
    };
    document.addEventListener('click', anchorHandler);

    // ── Reveal observer ──
    const revealEls = document.querySelectorAll('.homepage .reveal, .homepage .reveal-left, .homepage .reveal-right');
    const revealObs = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); revealObs.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });
    revealEls.forEach(el => revealObs.observe(el));

    // ── Counter animation ──
    function animateCounter(el: Element, target: number, duration = 1500, prefix = '', suffix = '') {
      if (prefersReduced) { el.textContent = prefix + target + suffix; return; }
      const start = performance.now();
      const isFloat = String(target).includes('.');
      function step(ts: number) {
        const progress = Math.min((ts - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 4);
        const val = isFloat ? (eased * target).toFixed(1) : Math.round(eased * target);
        el.textContent = prefix + val + suffix;
        if (progress < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    // Hero stats
    const heroStats = document.querySelectorAll('[data-counter]');
    let heroAnimated = false;
    const heroObs = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting && !heroAnimated) {
          heroAnimated = true;
          heroStats.forEach(el => {
            animateCounter(el, parseFloat((el as HTMLElement).dataset.counter ?? '0'), 1800,
              (el as HTMLElement).dataset.prefix ?? '', (el as HTMLElement).dataset.suffix ?? '');
          });
          document.querySelectorAll('.pc-bar-fill').forEach(bar => {
            setTimeout(() => { (bar as HTMLElement).style.width = (bar as HTMLElement).dataset.width + '%'; }, 400);
          });
        }
      });
    }, { threshold: 0.3 });
    heroStats.forEach(el => heroObs.observe(el));

    // Stats bar counters
    const statCounters = document.querySelectorAll('.homepage .counter');
    const statObs = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          animateCounter(e.target, parseInt((e.target as HTMLElement).dataset.target ?? '0'), 1500);
          statObs.unobserve(e.target);
        }
      });
    }, { threshold: 0.5 });
    statCounters.forEach(el => statObs.observe(el));

    // Fee bar
    const feeFill = document.querySelector('.homepage .fee-fill');
    if (feeFill) {
      const feeObs = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            (feeFill as HTMLElement).style.width = (feeFill as HTMLElement).dataset.width + '%';
            feeObs.unobserve(e.target);
          }
        });
      }, { threshold: 0.4 });
      feeObs.observe(feeFill);
    }

    // Notification stagger
    const notifItems = document.querySelectorAll('.homepage .notif-item');
    if (notifItems.length) {
      const notifObs = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            notifItems.forEach((item, i) => { setTimeout(() => item.classList.add('in'), i * 200); });
            notifObs.unobserve(e.target);
          }
        });
      }, { threshold: 0.3 });
      notifObs.observe(notifItems[0]);
    }

    // Steps connector line
    const stepsWrap = document.getElementById('lp-steps-wrap');
    if (stepsWrap) {
      const stepsObs = new IntersectionObserver(entries => {
        entries.forEach(e => { if (e.isIntersecting) { stepsWrap.classList.add('animated'); stepsObs.unobserve(e.target); } });
      }, { threshold: 0.4 });
      stepsObs.observe(stepsWrap);
    }

    // ── Custom cursor ──
    const isTouch = window.matchMedia('(pointer:coarse)').matches;
    let cancelCursor: (() => void) | null = null;
    if (!isTouch && !prefersReduced) {
      const dot = document.getElementById('lp-cursor-dot');
      const ring = document.getElementById('lp-cursor-ring');
      if (dot && ring) {
        const hp = document.querySelector('.homepage') as HTMLElement;
        if (hp) hp.classList.add('cursor-ready');
        let mouseX = 0, mouseY = 0, ringX = 0, ringY = 0;
        let rafId: number;
        const onMouseMove = (e: MouseEvent) => {
          mouseX = e.clientX; mouseY = e.clientY;
          dot.style.transform = `translate(calc(${mouseX}px - 50%), calc(${mouseY}px - 50%))`;
          dot.classList.remove('hidden'); ring.classList.remove('hidden');
        };
        const lerpRing = () => {
          ringX += (mouseX - ringX) * 0.12; ringY += (mouseY - ringY) * 0.12;
          ring.style.transform = `translate(calc(${ringX}px - 50%), calc(${ringY}px - 50%))`;
          rafId = requestAnimationFrame(lerpRing);
        };
        lerpRing();
        document.addEventListener('mousemove', onMouseMove, { passive: true });
        document.addEventListener('mouseleave', () => { dot.classList.add('hidden'); ring.classList.add('hidden'); });
        document.addEventListener('mouseenter', () => { dot.classList.remove('hidden'); ring.classList.remove('hidden'); });
        const ringClasses = ['expanded','on-primary','on-nav','on-card'];
        const dotClasses  = ['on-light','on-primary'];
        const clear = () => { ring.classList.remove(...ringClasses); dot.classList.remove(...dotClasses); };
        const hoverMap: [string, string, string][] = [
          ['.homepage .lp-btn-primary', 'on-primary', 'on-primary'],
          ['.homepage .lp-btn-ghost',   'expanded',   ''],
          ['.homepage .lp-btn-ghost-white', 'on-nav', 'on-light'],
          ['.homepage .lp-btn-white',   'on-primary', 'on-primary'],
          ['.homepage .lp-nav-links a', 'on-nav',     'on-light'],
          ['.homepage .lp-nav-logo',    'on-nav',     'on-light'],
          ['.homepage .stake-card',     'on-card',    ''],
          ['.homepage .price-card',     'on-card',    ''],
          ['.homepage .trust-card',     'on-card',    ''],
          ['.homepage .step-card',      'on-card',    ''],
          ['.homepage .footer-col a',   'expanded',   ''],
          ['.homepage .footer-socials a','expanded',  ''],
          ['#lp-scroll-top',            'on-primary', 'on-primary'],
          ['#lp-hamburger',             'on-nav',     'on-light'],
        ];
        hoverMap.forEach(([sel, rc, dc]) => {
          document.querySelectorAll(sel).forEach(el => {
            el.addEventListener('mouseenter', () => { clear(); if (rc) ring.classList.add(rc); if (dc) dot.classList.add(dc); });
            el.addEventListener('mouseleave', clear);
          });
        });
        const onDown = () => { ring.style.transform = `translate(calc(${ringX}px - 50%), calc(${ringY}px - 50%)) scale(0.8)`; };
        const onUp   = () => { ring.style.transform = `translate(calc(${ringX}px - 50%), calc(${ringY}px - 50%)) scale(1)`; };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('mouseup', onUp);
        cancelCursor = () => {
          cancelAnimationFrame(rafId);
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('mouseup', onUp);
        };
      }
    }

    return () => {
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('click', anchorHandler);
      revealObs.disconnect();
      heroObs.disconnect();
      statObs.disconnect();
      cancelCursor?.();
    };
  }, []);

  return (
    <div className="homepage">
      {/* Custom cursor */}
      <div id="lp-cursor-dot" aria-hidden="true" />
      <div id="lp-cursor-ring" aria-hidden="true" />

      {/* ── NAV ── */}
      <nav id="lp-nav">
        <div className="nav-inner">
          <Link href="/" className="lp-nav-logo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/Chronix_Logo.png" alt="Chronix Edu" />
          </Link>
          <div className="lp-nav-links">
            <a href="#features">Features</a>
            <a href="#solutions">Solutions</a>
            <a href="#pricing">Pricing</a>
            <a href="#security">Security</a>
          </div>
          <div className="lp-nav-cta">
            <Link href="/login" className="lp-btn lp-btn-ghost-white lp-btn-sm">Sign In</Link>
            <a href="mailto:support@chronixtechnology.com" className="lp-btn lp-btn-primary lp-btn-sm">Book a Demo</a>
          </div>
          <button className="hamburger" id="lp-hamburger" aria-label="Menu" onClick={() => setMobileOpen(v => !v)}>
            <span /><span /><span />
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      <div className={`mobile-menu${mobileOpen ? ' open' : ''}`}>
        <a href="#features" onClick={() => setMobileOpen(false)}>Features</a>
        <a href="#solutions" onClick={() => setMobileOpen(false)}>Solutions</a>
        <a href="#pricing" onClick={() => setMobileOpen(false)}>Pricing</a>
        <a href="#security" onClick={() => setMobileOpen(false)}>Security</a>
        <Link href="/login" className="lp-btn lp-btn-ghost" onClick={() => setMobileOpen(false)}>Sign In</Link>
        <a href="mailto:support@chronixtechnology.com" className="lp-btn lp-btn-primary" onClick={() => setMobileOpen(false)}>Book a Demo</a>
      </div>

      {/* ── HERO ── */}
      <header className="hero" id="home">
        <div className="hero-mesh" />
        <div className="hero-particles" id="lp-particles" />
        <div className="container">
          <div className="hero-grid">
            <div className="hero-copy">
              <span className="eyebrow" style={{ background: 'rgba(255,118,27,.15)', color: 'var(--orange)' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} width={14} height={14}><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" /></svg>
                Built for Nigerian Schools
              </span>
              <h1>Run your school smarter,<span className="accent">not harder.</span></h1>
              <p className="hero-sub">Results, attendance, fees, parent communication — one place, one login. Your staff stop chasing paper and start teaching.</p>
              <div className="hero-cta">
                <a href="mailto:support@chronixtechnology.com" className="lp-btn lp-btn-primary">
                  Book a Free Demo
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M5 12h14M13 5l7 7-7 7" /></svg>
                </a>
                <a href="#features" className="lp-btn lp-btn-ghost-white">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} width={16} height={16}><circle cx="12" cy="12" r="10" /><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" /></svg>
                  See How It Works
                </a>
              </div>
              <div className="hero-trust">
                <span className="trust-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}><path d="M20 6L9 17l-5-5" /></svg> No card required</span>
                <span className="trust-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}><path d="M20 6L9 17l-5-5" /></svg> Set up in under a day</span>
                <span className="trust-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}><path d="M20 6L9 17l-5-5" /></svg> NDPA compliant</span>
              </div>
            </div>

            <div className="hero-visual">
              <div className="product-card">
                <div className="pc-bar">
                  <span className="pc-dot" style={{ background: '#ff5f57' }} />
                  <span className="pc-dot" style={{ background: '#febc2e' }} />
                  <span className="pc-dot" style={{ background: '#28c840' }} />
                  <span className="pc-url">edu.chronixtechnology.com/dashboard</span>
                </div>
                <div className="pc-body">
                  <div className="pc-hello">Good morning, Mrs. Adeyemi 👋</div>
                  <div className="pc-meta">Chronix Secondary School · First Term 2025/2026</div>
                  <div className="pc-stats">
                    <div className="pc-stat"><div className="pc-stat-label">Students</div><div className="pc-stat-val" data-counter="412">0</div></div>
                    <div className="pc-stat"><div className="pc-stat-label">Avg Score</div><div className="pc-stat-val orange" data-counter="82" data-suffix="%">0%</div></div>
                    <div className="pc-stat"><div className="pc-stat-label">Attendance</div><div className="pc-stat-val" data-counter="96" data-suffix="%">0%</div></div>
                    <div className="pc-stat"><div className="pc-stat-label">Fees Paid</div><div className="pc-stat-val orange" data-prefix="₦" data-counter="4.2" data-suffix="M">₦0</div></div>
                  </div>
                  <div className="pc-chart">
                    <div className="pc-chart-row"><span className="pc-chart-lbl">Mathematics</span><div className="pc-bar-track"><div className="pc-bar-fill" data-width="88" /></div><span className="pc-chart-pct">88%</span></div>
                    <div className="pc-chart-row"><span className="pc-chart-lbl">English</span><div className="pc-bar-track"><div className="pc-bar-fill" data-width="79" /></div><span className="pc-chart-pct">79%</span></div>
                    <div className="pc-chart-row"><span className="pc-chart-lbl">Basic Science</span><div className="pc-bar-track"><div className="pc-bar-fill" data-width="84" /></div><span className="pc-chart-pct">84%</span></div>
                  </div>
                </div>
              </div>
              <div className="float-card float-1">
                <div className="fc-icon green"><svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth={2.5}><path d="M20 6L9 17l-5-5" /></svg></div>
                <div><div className="fc-t1">Report Card Ready</div><div className="fc-t2">Fatima O. — JSS 2A</div></div>
              </div>
              <div className="float-card float-2">
                <div className="fc-icon blue"><svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#2472B4" strokeWidth={2.2}><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" /></svg></div>
                <div><div className="fc-t1">₦25,000 Received</div><div className="fc-t2">via Paystack · Amina O.</div></div>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* ── STATS BAR ── */}
      <section className="statbar">
        <div className="container">
          <div className="stats-row">
            <div className="reveal"><div className="stat-num"><span className="counter accent" data-target="60">0</span><span className="accent">%</span></div><div className="stat-lbl">Less admin workload</div></div>
            <div className="reveal stagger-1"><div className="stat-num"><span className="counter accent" data-target="80">0</span><span className="accent">%</span></div><div className="stat-lbl">Faster result computation</div></div>
            <div className="reveal stagger-2"><div className="stat-num"><span className="counter accent" data-target="35">0</span><span className="accent">%</span></div><div className="stat-lbl">More parent engagement</div></div>
            <div className="reveal stagger-3"><div className="stat-num">&lt;<span className="accent">1</span></div><div className="stat-lbl">Day to get fully set up</div></div>
          </div>
        </div>
      </section>

      {/* ── STAKEHOLDERS ── */}
      <section className="section" id="solutions">
        <div className="container">
          <div className="s-head reveal">
            <span className="eyebrow">For Everyone in Your School</span>
            <h2>One platform. Every stakeholder.</h2>
            <p>Principal, teacher, parent, student. Each person gets a dashboard that shows exactly what they need — nothing more, nothing less.</p>
          </div>
          <div className="stake-grid">
            <div className="stake-card reveal">
              <div className="stake-icon"><svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#2472B4" strokeWidth={2}><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5M2 12l10 5 10-5" /></svg></div>
              <h4>Principals &amp; Admins</h4>
              <p>See results, attendance, fees, and staff activity in real time. No more waiting for end-of-term reports to know what&apos;s happening.</p>
            </div>
            <div className="stake-card reveal stagger-1">
              <div className="stake-icon"><svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#FF761B" strokeWidth={2}><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2zM22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" /></svg></div>
              <h4>Teachers</h4>
              <p>Enter scores, mark attendance, message parents. No spreadsheets, no paper registers, no emailing files back and forth.</p>
            </div>
            <div className="stake-card reveal stagger-2">
              <div className="stake-icon"><svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth={2}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg></div>
              <h4>Parents</h4>
              <p>Check your child&apos;s results, attendance, and fee balance from your phone. Pay school fees through Paystack without going to the bank.</p>
            </div>
            <div className="stake-card reveal stagger-3">
              <div className="stake-icon"><svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth={2}><path d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" /></svg></div>
              <h4>Students</h4>
              <p>See results, assignments, and school notices whenever you need them. No more waiting until the principal calls an assembly.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section className="section section-dark" id="features">
        <div className="container">
          <div className="s-head reveal">
            <span className="eyebrow">Everything You Need</span>
            <h2>The stuff your school actually does every day</h2>
            <p>Admission, attendance, results, fees, report cards. We built for the tasks your staff repeat every term, not for a feature list that looks good on a slide.</p>
          </div>

          {/* Row 1 — Academics */}
          <div className="feature-row">
            <div className="feat-text reveal-left">
              <span className="eyebrow" style={{ background: 'var(--blue-l)', color: 'var(--blue)' }}>Academics</span>
              <h3>Results in minutes, not the two weeks your staff used to spend on them.</h3>
              <p>Teachers enter scores. The system does the rest: weighted totals, class positions, grades, PDF report cards with your school&apos;s logo and branding. The principal reviews and publishes. Done.</p>
              <ul className="feat-list">
                <li><CheckIcon /> Set your own grading scale and assessment weights</li>
                <li><CheckIcon /> Class positions calculated automatically, no manual sorting</li>
                <li><CheckIcon /> Principal approves before anything goes to parents</li>
                <li><CheckIcon /> PDF report cards in two templates, ready to download</li>
              </ul>
            </div>
            <div className="feat-visual reveal-right">
              <div className="mock">
                <div className="mock-head"><span className="mock-head-t">Mathematics — JSS 2A</span><span className="mock-badge">Published ✓</span></div>
                <div className="mock-body">
                  <div className="mock-row"><div className="mock-student"><div className="mock-av">FO</div><div><div className="mock-name">Fatima Okonkwo</div><div className="mock-sub">SCH2026-0001 · Position 1st</div></div></div><span className="grade grade-a">82% · A</span></div>
                  <div className="mock-row"><div className="mock-student"><div className="mock-av">EA</div><div><div className="mock-name">Emeka Adeyemi</div><div className="mock-sub">SCH2026-0002 · Position 2nd</div></div></div><span className="grade grade-b">76% · B</span></div>
                  <div className="mock-row"><div className="mock-student"><div className="mock-av">CN</div><div><div className="mock-name">Chiamaka Nwosu</div><div className="mock-sub">SCH2026-0003 · Position 3rd</div></div></div><span className="grade grade-b">71% · B</span></div>
                </div>
              </div>
            </div>
          </div>

          {/* Row 2 — Finance */}
          <div className="feature-row rev">
            <div className="feat-text reveal-right">
              <span className="eyebrow" style={{ background: 'var(--green-l)', color: 'var(--green)' }}>Finance</span>
              <h3>Stop chasing parents for fees. Let the system do it.</h3>
              <p>Generate invoices per term, collect through Paystack, and send automatic reminders to parents who haven&apos;t paid. Your bursar sees exactly what&apos;s come in and what&apos;s still outstanding.</p>
              <ul className="feat-list">
                <li><CheckIcon /> Parents pay online through Paystack, recorded instantly</li>
                <li><CheckIcon /> Send payment reminders to parents with one click</li>
                <li><CheckIcon /> Bursar dashboard shows outstanding balances in real time</li>
                <li><CheckIcon /> Collection trends by month, term, and student</li>
              </ul>
            </div>
            <div className="feat-visual reveal-left">
              <div className="mock">
                <div className="mock-head"><span className="mock-head-t">Fee Collection — First Term</span><span className="mock-badge">Live</span></div>
                <div className="mock-body">
                  <div className="fee-progress-wrap">
                    <div className="fee-label-row"><span className="fee-label">Total Collected</span><span className="fee-val">₦4,200,000 of ₦5,000,000</span></div>
                    <div className="fee-track"><div className="fee-fill" data-width="84" /></div>
                  </div>
                  <div className="fee-stats">
                    <div className="fee-stat"><div className="fee-stat-num">412</div><div className="fee-stat-lbl">Invoices</div></div>
                    <div className="fee-stat"><div className="fee-stat-num green">347</div><div className="fee-stat-lbl">Fully Paid</div></div>
                    <div className="fee-stat"><div className="fee-stat-num orange">65</div><div className="fee-stat-lbl">Outstanding</div></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Row 3 — Communication */}
          <div className="feature-row">
            <div className="feat-text reveal-left">
              <span className="eyebrow" style={{ background: 'var(--orange-l)', color: 'var(--orange)' }}>Communication</span>
              <h3>Parents find out the same day, not at the next PTA meeting.</h3>
              <p>When a student is absent three days running, a parent gets an SMS. When results are published, they get a notification. No one calls the office asking questions that are already answered in the app.</p>
              <ul className="feat-list">
                <li><CheckIcon /> Staff and parents message each other directly in the app</li>
                <li><CheckIcon /> School-wide announcements reach everyone at once</li>
                <li><CheckIcon /> Attendance alerts go by SMS and email automatically</li>
                <li><CheckIcon /> Works on slow connections, syncs when you&apos;re back online</li>
              </ul>
            </div>
            <div className="feat-visual reveal-right">
              <div className="mock">
                <div className="mock-head"><span className="mock-head-t">Notifications</span><span className="mock-badge">3 New</span></div>
                <div className="mock-body notif-feed">
                  <div className="notif-item"><div className="notif-ic amber">⚠️</div><div><div className="notif-t">Low Attendance Alert</div><div className="notif-s">Emeka A. — 3 absences this week</div></div></div>
                  <div className="notif-item"><div className="notif-ic green">✓</div><div><div className="notif-t">Result Published</div><div className="notif-s">JSS 2A — First Term Mathematics</div></div></div>
                  <div className="notif-item"><div className="notif-ic blue">₦</div><div><div className="notif-t">Payment Received</div><div className="notif-s">Fatima O. — ₦25,000 via Paystack</div></div></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="section">
        <div className="container">
          <div className="s-head reveal">
            <span className="eyebrow">Getting Started</span>
            <h2>Most schools are live the same day they sign up</h2>
            <p>No consultant, no IT team, no weeks of &ldquo;implementation.&rdquo; Three steps and you&apos;re running.</p>
          </div>
          <div className="steps-wrap" id="lp-steps-wrap">
            <div className="step-card reveal"><div className="step-num">1</div><h4>Set up your school</h4><p>Add your branding, term dates, grading scale, and assessment weights. About 30 minutes, done once.</p></div>
            <div className="step-card reveal stagger-1"><div className="step-num">2</div><h4>Add your people</h4><p>Create teacher accounts, register students, assign classes, and link parents to their children. Each person logs in and sees only what&apos;s relevant to them.</p></div>
            <div className="step-card reveal stagger-2"><div className="step-num">3</div><h4>Run the term normally</h4><p>Attendance, scores, fees, messages — everything goes through the same place. No more switching between apps and notebooks.</p></div>
          </div>
        </div>
      </section>

      {/* ── TESTIMONIAL ── */}
      <section className="testi-section">
        <div className="testi-glow" />
        <div className="container">
          <div className="testi-inner reveal">
            <span className="testi-quote-mark">&ldquo;</span>
            <p className="testi-text">Since switching to Chronix Edu, result computation that used to take our staff two weeks now takes two days. Parents finally have real visibility into their children&apos;s progress.</p>
            <div className="testi-author">
              <div className="testi-av">CP</div>
              <div>
                <div className="testi-name">Child Prime Onyx School</div>
                <div className="testi-role">Early Partner School, Lagos</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── PRICING ── */}
      <section className="section section-dark" id="pricing">
        <div className="container">
          <div className="s-head reveal">
            <span className="eyebrow" style={{ background: 'var(--green-l)', color: 'var(--green)' }}>Simple Pricing</span>
            <h2>Priced for Nigerian private schools, not Silicon Valley startups</h2>
            <p>Monthly pricing in Naira. No setup fees, no per-teacher charges, no surprise invoices at the end of term.</p>
          </div>
          <div className="toggle-wrap reveal">
            <span className="toggle-lbl" style={{ fontWeight: isAnnual ? 400 : 700 }}>Monthly</span>
            <div className={`toggle-switch${isAnnual ? ' annual' : ''}`} role="switch" aria-checked={isAnnual} onClick={() => setIsAnnual(v => !v)} />
            <span className="toggle-lbl" style={{ fontWeight: isAnnual ? 700 : 400 }}>Annual</span>
            <span className="toggle-badge">Save 10% annually</span>
          </div>
          <div className="pricing-grid">
            <div className="price-card reveal">
              <div className="price-name">Starter</div>
              <div className="price-desc">Small schools getting started</div>
              <div className="price-amount"><span className="price-num">{p.starter}</span><span className="price-per">{period}</span></div>
              <div className="price-students">Up to 150 students</div>
              <ul className="price-feats">
                <li><CheckIcon /> Results &amp; report cards</li>
                <li><CheckIcon /> Attendance tracking</li>
                <li><CheckIcon /> Parent &amp; student portals</li>
                <li><CheckIcon /> Email notifications</li>
              </ul>
              <a href="mailto:support@chronixtechnology.com" className="lp-btn lp-btn-ghost">Get Started</a>
            </div>
            <div className="price-card featured reveal stagger-1">
              <span className="price-featured-badge">Most Popular</span>
              <div className="price-name">Growth</div>
              <div className="price-desc">Established schools, full toolkit</div>
              <div className="price-amount"><span className="price-num">{p.growth}</span><span className="price-per">{period}</span></div>
              <div className="price-students">Up to 500 students</div>
              <ul className="price-feats">
                <li><CheckIcon /> Everything in Starter</li>
                <li><CheckIcon /> Fee management &amp; Paystack</li>
                <li><CheckIcon /> SMS reminders via Termii</li>
                <li><CheckIcon /> Messaging &amp; announcements</li>
                <li><CheckIcon /> Analytics dashboard</li>
              </ul>
              <a href="mailto:support@chronixtechnology.com" className="lp-btn lp-btn-primary">Get Started</a>
            </div>
            <div className="price-card reveal stagger-2">
              <div className="price-name">Pro</div>
              <div className="price-desc">Larger or multi-campus schools</div>
              <div className="price-amount"><span className="price-num">{p.pro}</span><span className="price-per">{period}</span></div>
              <div className="price-students">Up to 1,000+ students</div>
              <ul className="price-feats">
                <li><CheckIcon /> Everything in Growth</li>
                <li><CheckIcon /> Timetable management</li>
                <li><CheckIcon /> Advanced analytics &amp; exports</li>
                <li><CheckIcon /> Priority email support</li>
              </ul>
              <a href="mailto:support@chronixtechnology.com" className="lp-btn lp-btn-ghost">Get Started</a>
            </div>
            <div className="price-card reveal stagger-3">
              <div className="price-name">Enterprise</div>
              <div className="price-desc">School groups &amp; custom needs</div>
              <div className="price-amount"><span className="price-num" style={{ fontSize: 22 }}>Custom</span></div>
              <div className="price-students">Unlimited students</div>
              <ul className="price-feats">
                <li><CheckIcon /> Everything in Pro</li>
                <li><CheckIcon /> Dedicated onboarding session</li>
                <li><CheckIcon /> SLA &amp; uptime guarantee</li>
                <li><CheckIcon /> Custom feature requests</li>
              </ul>
              <a href="mailto:edu@chronixtechnology.com" className="lp-btn lp-btn-ghost">Talk to Sales</a>
            </div>
          </div>
        </div>
      </section>

      {/* ── TRUST / SECURITY ── */}
      <section className="section" id="security">
        <div className="container">
          <div className="s-head reveal">
            <span className="eyebrow" style={{ background: 'var(--blue-l)', color: 'var(--blue)' }}>Built on Trust</span>
            <h2>Your school&apos;s data belongs to your school</h2>
            <p>We store it, but we don&apos;t own it. If you ever leave, we give it back and delete our copy within 90 days. No negotiation needed.</p>
          </div>
          <div className="trust-grid">
            <div className="trust-card reveal">
              <div className="trust-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z" /></svg></div>
              <h4>Schools can&apos;t see each other&apos;s data</h4>
              <p>Every school is isolated at the database level. Not just a filter — a hard technical boundary. One school&apos;s data is invisible to every other school on the platform.</p>
            </div>
            <div className="trust-card reveal stagger-1">
              <div className="trust-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></svg></div>
              <h4>NDPA 2023 compliant</h4>
              <p>We follow the Nigeria Data Protection Act 2023. You keep data ownership, we keep processing obligations. The agreement is written into our contract with every school.</p>
            </div>
            <div className="trust-card reveal stagger-2">
              <div className="trust-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg></div>
              <h4>Monitored around the clock</h4>
              <p>Automated backups, real-time error monitoring, and uptime alerts. If something breaks at 2am, we know before your staff starts their morning.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="section" style={{ paddingBottom: 96 }}>
        <div className="cta-final reveal">
          <h2>See it working on a real school before you commit to anything</h2>
          <p>We&apos;ll walk you through a live demo using actual school data. No slides, no sales pitch. If it doesn&apos;t fit your school, we&apos;ll tell you.</p>
          <div className="cta-btns">
            <a href="mailto:support@chronixtechnology.com" className="lp-btn lp-btn-white">Book a Free Demo</a>
            <a href="mailto:edu@chronixtechnology.com" className="lp-btn lp-btn-ghost-white">Talk to Us</a>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer>
        <div className="container">
          <div className="footer-grid">
            <div className="footer-brand">
              <div className="footer-logo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icons/Chronix_Logo.png" alt="Chronix Edu" />
              </div>
              <p>Built by Chronix Technology Limited, Lagos. We make software for Nigerian schools because we know what Nigerian schools actually need.</p>
              <div className="footer-socials">
                <a href="https://facebook.com/chronixtech" target="_blank" rel="noopener noreferrer" aria-label="Facebook">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 12a10 10 0 10-11.5 9.9v-7H8v-3h2.5V9.5A3.5 3.5 0 0114 6h2v3h-2a1 1 0 00-1 1v2h3l-.5 3H13v7A10 10 0 0022 12z" /></svg>
                </a>
                <a href="https://x.com/chronixtech" target="_blank" rel="noopener noreferrer" aria-label="X / Twitter">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
                </a>
                <a href="https://instagram.com/chronixtech_" target="_blank" rel="noopener noreferrer" aria-label="Instagram">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" /></svg>
                </a>
                <a href="https://www.linkedin.com/in/chronixtech" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h14zM8.34 18V9.75H5.67V18h2.67zM7 8.62a1.55 1.55 0 100-3.1 1.55 1.55 0 000 3.1zM19 18v-4.66c0-2.5-1.34-3.67-3.13-3.67-1.45 0-2.1.8-2.46 1.36V9.75h-2.67V18h2.67v-4.55c0-1.17.86-1.73 1.44-.78.1.16.1.36.1.6V18H19z" /></svg>
                </a>
              </div>
            </div>
            <div className="footer-col">
              <h5>Product</h5>
              <ul>
                <li><a href="#features">Features</a></li>
                <li><a href="#pricing">Pricing</a></li>
                <li><a href="#solutions">Solutions</a></li>
                <li><a href="#security">Security</a></li>
              </ul>
            </div>
            <div className="footer-col">
              <h5>Company</h5>
              <ul>
                <li><a href="#">About Us</a></li>
                <li><a href="#">Careers</a></li>
                <li><a href="#">Blog</a></li>
                <li><a href="mailto:support@chronixtechnology.com">Contact</a></li>
              </ul>
            </div>
            <div className="footer-col">
              <h5>Legal</h5>
              <ul>
                <li><Link href="/legal/privacy-policy">Privacy Policy</Link></li>
                <li><Link href="/legal/terms">Terms of Service</Link></li>
                <li><Link href="/legal/data-processing-agreement">Data Processing Agreement</Link></li>
                <li><Link href="/legal/acceptable-use">Acceptable Use Policy</Link></li>
              </ul>
            </div>
          </div>
          <div className="footer-bottom">
            <p>© 2026 Chronix Technology Limited. All rights reserved.</p>
            <p>Lagos, Nigeria · support@chronixtechnology.com</p>
          </div>
        </div>
      </footer>

      {/* Scroll to top */}
      <button className="scroll-top" id="lp-scroll-top" aria-label="Back to top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M18 15l-6-6-6 6" /></svg>
      </button>
    </div>
  );
}
