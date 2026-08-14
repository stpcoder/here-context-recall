const header = document.querySelector("[data-header]");
const menu = document.querySelector("[data-menu]");
const syncHeader = () => header?.classList.toggle("is-scrolled", window.scrollY > 24);
syncHeader();
window.addEventListener("scroll", syncHeader, { passive: true });

menu?.addEventListener("click", () => {
  const open = header?.classList.toggle("is-open") ?? false;
  menu.setAttribute("aria-expanded", String(open));
  menu.setAttribute("aria-label", open ? "메뉴 닫기" : "메뉴 열기");
});

document.querySelectorAll(".site-header nav a").forEach((link) => {
  link.addEventListener("click", () => {
    header?.classList.remove("is-open");
    menu?.setAttribute("aria-expanded", "false");
  });
});

const demoVideo = document.querySelector("[data-demo-video]");
const videoToggle = document.querySelector("[data-video-toggle]");
const videoLabel = document.querySelector("[data-video-label]");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let pausedByUser = reducedMotion.matches;

const syncVideoControl = () => {
  if (!(demoVideo instanceof HTMLVideoElement) || !(videoToggle instanceof HTMLButtonElement)) return;
  const paused = demoVideo.paused;
  videoToggle.classList.toggle("is-paused", paused);
  videoToggle.setAttribute("aria-label", paused ? "데모 영상 재생" : "데모 영상 일시 정지");
  if (videoLabel) videoLabel.textContent = paused ? "재생" : "일시 정지";
};

const playDemo = async () => {
  if (!(demoVideo instanceof HTMLVideoElement) || pausedByUser || document.hidden) return;
  try {
    await demoVideo.play();
  } catch {
    syncVideoControl();
  }
};

if (demoVideo instanceof HTMLVideoElement && videoToggle instanceof HTMLButtonElement) {
  demoVideo.addEventListener("play", syncVideoControl);
  demoVideo.addEventListener("pause", syncVideoControl);
  videoToggle.addEventListener("click", () => {
    if (demoVideo.paused) {
      pausedByUser = false;
      void playDemo();
    } else {
      pausedByUser = true;
      demoVideo.pause();
    }
  });

  const observer = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) void playDemo();
      else demoVideo.pause();
    },
    { threshold: 0.35 },
  );
  observer.observe(demoVideo);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) demoVideo.pause();
    else void playDemo();
  });

  if (reducedMotion.matches) demoVideo.pause();
  else void playDemo();
  syncVideoControl();
}
