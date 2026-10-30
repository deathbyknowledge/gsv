import { useCallback, useEffect, useState } from "preact/hooks";

const STARS_KEY = "gsv.instrument.stars";
const STARS_CHANGE = "gsv-stars-change";
let pagePreference: boolean | null = null;

function storedStars(): boolean {
  if (pagePreference !== null) return pagePreference;
  try {
    return window.localStorage.getItem(STARS_KEY) === "true";
  } catch {
    return false;
  }
}

/** One device preference for the chat's background, off until the person turns it on; sign-in and the first run keep their stars. */
export function useStarsPreference() {
  const [showStars, setShowStars] = useState(storedStars);
  useEffect(() => {
    const refresh = () => setShowStars(storedStars());
    const storage = (event: StorageEvent) => {
      if (event.key === STARS_KEY || event.key === null) {
        pagePreference = null;
        refresh();
      }
    };
    window.addEventListener(STARS_CHANGE, refresh);
    window.addEventListener("storage", storage);
    refresh();
    return () => {
      window.removeEventListener(STARS_CHANGE, refresh);
      window.removeEventListener("storage", storage);
    };
  }, []);
  const setStars = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(STARS_KEY, String(next));
      pagePreference = null;
    } catch {
      // Storage blocked: keep the choice across views for this page.
      pagePreference = next;
    }
    window.dispatchEvent(new Event(STARS_CHANGE));
  }, []);
  return { showStars, setStars };
}
