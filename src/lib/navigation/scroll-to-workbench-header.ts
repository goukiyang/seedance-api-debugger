// Follow the actual header while preceding modules/images finish laying out.
export function scrollToWorkbenchHeader(target: HTMLElement, layout: HTMLElement, behavior: ScrollBehavior, onSettled: () => void) {
  window.dispatchEvent(new Event('sd2:scroll-target'));
  let container: HTMLElement | null = target.parentElement;
  while (container && !(container.scrollHeight > container.clientHeight && /auto|scroll/.test(getComputedStyle(container).overflowY))) container = container.parentElement;
  if (container === document.body || container === document.documentElement) container = null;
  let stopped = false, frame = 0, quiet = 0, previous = NaN;
  const start = performance.now();
  const align = () => {
    if (stopped || !target.isConnected) return;
    const topbar = document.querySelector<HTMLElement>('.composer-topbar')?.getBoundingClientRect();
    const navigation = layout.querySelector<HTMLElement>('[aria-label="图片模块导航"]');
    const navRect = navigation && getComputedStyle(navigation).display !== 'none' ? navigation.getBoundingClientRect() : null;
    const occlusion = Math.max(topbar?.bottom || 0, navRect ? (topbar?.bottom || 0) + navRect.height : 0);
    const visibleTop = Math.max(occlusion, container?.getBoundingClientRect().top || 0);
    const destination = Math.max(0, (container?.scrollTop ?? window.scrollY) + target.getBoundingClientRect().top - visibleTop);
    if (Math.abs(destination - previous) > 0.5) {
      previous = destination; quiet = performance.now();
      if (container) container.scrollTo({ top: destination, behavior });
      else window.scrollTo({ top: destination, behavior });
      behavior = 'auto';
    }
    const pendingImagesAbove = Array.from(layout.querySelectorAll('img')).some(image => !image.complete && image.getBoundingClientRect().top < target.getBoundingClientRect().top);
    if (!pendingImagesAbove && performance.now() - quiet > 500 || performance.now() - start > 8000) { stop(); onSettled(); }
    else frame = requestAnimationFrame(align);
  };
  const observer = new ResizeObserver(() => { quiet = performance.now(); });
  observer.observe(layout);
  const stop = () => { stopped = true; cancelAnimationFrame(frame); observer.disconnect(); };
  quiet = start;
  frame = requestAnimationFrame(align);
  return stop;
}
