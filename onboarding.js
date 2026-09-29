// onboarding.js — ScrollMap animated onboarding

/* ── PARTICLES ─────────────────────────────────────────────────── */
const canvas = document.getElementById('particles');
const ctx    = canvas.getContext('2d');
let W, H, particles = [];

function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
}
resize();
window.addEventListener('resize', resize);

for (let i = 0; i < 55; i++) {
    particles.push({
        x:  Math.random() * 1200,
        y:  Math.random() * 900,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        r:  Math.random() * 1.8 + 0.3,
        a:  Math.random() * 0.4 + 0.1,
    });
}

function drawParticles() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle    = `rgba(74,222,128,${p.a})`;
        ctx.shadowColor  = 'rgba(74,222,128,0.6)';
        ctx.shadowBlur   = 6;
        ctx.fill();
    });
    requestAnimationFrame(drawParticles);
}
drawParticles();

/* ── SLIDE ENGINE ───────────────────────────────────────────────── */
const TOTAL    = 5;
let   current  = 0;

const slideEls   = Array.from(document.querySelectorAll('.slide'));
const progressBar = document.getElementById('progressBar');
const stepLabel   = document.getElementById('stepLabel');

// Build dot indicators for every slide
[0, 1, 2, 3, 4].forEach(si => {
    const containerId = si === 0 ? 'dots' : `dots${si}`;
    const dEl = document.getElementById(containerId);
    if (!dEl) return;
    for (let i = 0; i < TOTAL; i++) {
        const d = document.createElement('div');
        d.className = 'dot' + (i === si ? ' active' : '');
        d.addEventListener('click', () => goTo(i));
        dEl.appendChild(d);
    }
});

function goTo(idx) {
    slideEls[current].classList.remove('active');
    current = Math.max(0, Math.min(TOTAL - 1, idx));
    slideEls[current].classList.add('active');

    // Update progress bar
    progressBar.style.width = ((current / (TOTAL - 1)) * 100) + '%';
    stepLabel.textContent   = `${current + 1} / ${TOTAL}`;

    // Sync all dot groups
    document.querySelectorAll('.dots').forEach(dg => {
        dg.querySelectorAll('.dot').forEach((d, i) => d.classList.toggle('active', i === current));
    });
}

// Wire all prev / next buttons via event delegation
document.addEventListener('click', e => {
    const btn = e.target.closest('.nav-btn');
    if (!btn || btn.hasAttribute('disabled')) return;
    if (btn.classList.contains('next')) goTo(current + 1);
    else                                 goTo(current - 1);
});

document.getElementById('skipAll').addEventListener('click', () => goTo(TOTAL - 1));

document.getElementById('getStartedBtn').addEventListener('click', () => window.close());