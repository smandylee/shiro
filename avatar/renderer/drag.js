// Picking Shiro up and moving her. The window is see-through and lets clicks
// pass to whatever is behind it, so it only takes the mouse while the pointer
// is over one of her own pixels; everywhere else the desktop still gets the click.

const ALPHA_MIN = 24; // 0-255: fainter than this counts as empty air (hair tips, antialiasing)
const MOVE_INTERVAL_MS = 33; // how often the pointer is looked at while it is not over her

export function setupDrag({ canvas, ctx, onWheel }) {
  let over = false;
  let dragging = false;
  let lastCheck = 0;

  /** Whether the pointer is over a visible pixel of Shiro. */
  function isOverShiro(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return false;
    const x = Math.floor((clientX - rect.left) * (canvas.width / rect.width));
    const y = Math.floor((clientY - rect.top) * (canvas.height / rect.height));
    try {
      return ctx.getImageData(x, y, 1, 1).data[3] >= ALPHA_MIN;
    } catch {
      return false;
    }
  }

  function setOver(next) {
    if (next === over) return;
    over = next;
    document.body.style.cursor = dragging ? "grabbing" : over ? "grab" : "default";
    // Over her: take the mouse. Off her: give it back so clicks go through again.
    window.shiro.setMouseCapture(over);
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    window.shiro.dragEnd();
    document.body.style.cursor = over ? "grab" : "default";
  }

  document.addEventListener("mousemove", (e) => {
    if (dragging) {
      // The button was let go somewhere we didn't hear about: stop following the pointer.
      if ((e.buttons & 1) === 0) endDrag();
      return;
    }
    const now = performance.now();
    if (now - lastCheck < MOVE_INTERVAL_MS) return;
    lastCheck = now;
    setOver(isOverShiro(e.clientX, e.clientY));
  });

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || dragging) return;
    // A press counts if the pointer is on her right now, whatever the last check said.
    if (!isOverShiro(e.clientX, e.clientY)) return;
    over = true;
    dragging = true;
    document.body.style.cursor = "grabbing";
    window.shiro.setMouseCapture(true);
    window.shiro.dragStart();
  });

  // The wheel only reaches the page while the pointer is on her (the rest of the
  // window lets it through), so it never steals scrolling from what is behind.
  document.addEventListener(
    "wheel",
    (e) => {
      if (!over && !dragging) return;
      e.preventDefault();
      onWheel?.(e.deltaY);
    },
    { passive: false }
  );

  window.addEventListener("mouseup", endDrag);
  window.addEventListener("blur", endDrag);
  document.addEventListener("mouseleave", () => {
    if (!dragging) setOver(false);
  });
}
