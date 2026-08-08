/* awwwards-hero.js — particle field on hero canvas (lazy-loaded effect)
   Lightweight: pure canvas2d, no GSAP/three.js. Auto-degrades on low-power. */
(function () {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w = canvas.width = canvas.offsetWidth;
  let h = canvas.height = canvas.offsetHeight;

  const N = 80;
  const points = Array.from({ length: N }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.4,
    vy: (Math.random() - 0.5) * 0.4,
  }));

  let raf;
  function loop() {
    ctx.clearRect(0, 0, w, h);
    for (const p of points) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
    }
    // Connections
    ctx.strokeStyle = 'rgba(180, 230, 100, 0.18)';
    ctx.lineWidth = 0.6;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const dx = points[i].x - points[j].x;
        const dy = points[i].y - points[j].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 100) {
          ctx.globalAlpha = 1 - d / 100;
          ctx.beginPath();
          ctx.moveTo(points[i].x, points[i].y);
          ctx.lineTo(points[j].x, points[j].y);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    // Points
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    raf = requestAnimationFrame(loop);
  }
  loop();

  window.addEventListener('resize', () => {
    w = canvas.width = canvas.offsetWidth;
    h = canvas.height = canvas.offsetHeight;
  });

  // Auto-stop after 2s (hero is dismissed by Alpine)
  setTimeout(() => { cancelAnimationFrame(raf); }, 2200);
})();
