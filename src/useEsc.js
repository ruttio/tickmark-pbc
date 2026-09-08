// =====================================================================
//  useEscape — close an overlay (modal, drawer, dropdown) on the Esc key.
//
//  `active` gates registration (pass a dropdown's open-state, or `true` for a
//  component that only mounts while open, like a Modal). `onClose` is read
//  through a ref so re-registration happens once per open, not per render.
//
//  Esc closes ONLY the topmost overlay. Independent window listeners would
//  all fire at once — pressing Esc over a file preview opened from inside a
//  drawer would close both. So every active overlay pushes its closer onto
//  one shared LIFO stack and a single key handler invokes just the last one;
//  closing it pops the stack so the next Esc reaches the layer beneath. (The
//  firm and client apps are separate bundles, hence separate stacks — fine,
//  a page is one bundle.)
//
//  Closing here runs the same state change as the on-screen ✕/backdrop, so it
//  composes with useBackNav: the layer count drops and that hook pops its
//  matching history entry, keeping Esc and browser-Back in sync.
// =====================================================================
import { useEffect, useRef } from "react";

const stack = [];      // closers, last element = topmost overlay
let listening = false;

function onKey(e) {
  if (e.key !== "Escape" || stack.length === 0) return;
  e.stopPropagation();
  stack[stack.length - 1]();
}

export function useEscape(active, onClose) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!active) return undefined;
    const entry = () => onCloseRef.current?.();
    stack.push(entry);
    if (!listening) { window.addEventListener("keydown", onKey); listening = true; }
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0 && listening) { window.removeEventListener("keydown", onKey); listening = false; }
    };
  }, [active]);
}
