// =====================================================================
//  useBackNav — make the browser Back button close in-app "layers".
//
//  Both apps are single-component SPAs with no router: navigation is React
//  state (which view, which drawer, which modal). Browser Back therefore did
//  nothing — you could only go back via on-screen buttons. This hook mirrors
//  the number of open layers into the history stack so Back closes the
//  topmost one, matching the on-screen back/close buttons.
//
//  Usage: pass `depth` = how many closable layers are open right now (0..N),
//  and `onPop` = a function that closes the TOPMOST layer (one level per
//  call, in the same precedence the UI uses). The hook keeps the history
//  stack holding exactly `depth` sentinel entries above wherever the app was
//  entered, and:
//    • Back (a real popstate) consumes one sentinel → we call onPop().
//    • Closing a layer with an on-screen button lowers `depth` → we pop our
//      own sentinel with history.go(), and IGNORE the popstate it produces
//      (skip counter) so it doesn't close a second layer.
//  syncedRef always reconciles back to `depth`, so the two close paths can
//  interleave without drift, dangling entries, or a Back that mysteriously
//  does nothing.
// =====================================================================
import { useEffect, useRef } from "react";

export function useBackNav(depth, onPop) {
  const syncedRef = useRef(0);   // sentinels we currently have on the stack
  const skipRef = useRef(0);     // popstate events we caused ourselves (ignore)
  const onPopRef = useRef(onPop);
  onPopRef.current = onPop;      // always call the latest closure, no stale deps

  useEffect(() => {
    const handler = () => {
      if (skipRef.current > 0) {
        // A popstate we triggered via history.go() for an on-screen close.
        skipRef.current -= 1;
        syncedRef.current = Math.max(0, syncedRef.current - 1);
        return;
      }
      // A genuine Back press consumed one sentinel — close the topmost layer.
      if (syncedRef.current > 0) {
        syncedRef.current -= 1;
        onPopRef.current?.();
      }
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (depth > syncedRef.current) {
      for (let i = syncedRef.current; i < depth; i++) window.history.pushState({ tkNav: true }, "");
      syncedRef.current = depth;
    } else if (depth < syncedRef.current) {
      const n = syncedRef.current - depth;
      skipRef.current += n;          // absorb the popstate events history.go fires
      window.history.go(-n);         // syncedRef is decremented as those are handled
    }
  }, [depth]);
}
