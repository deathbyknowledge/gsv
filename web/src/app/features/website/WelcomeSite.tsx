import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { BEATS, RAIL_FROM_BEAT, SKIP_FROM_BEAT } from "./beats";
import { LandingSection } from "./LandingSection";
import { NarrativeBeat } from "./NarrativeBeat";
import { TimelineRail } from "./TimelineRail";
import "./website.css";

/** WelcomeSite — the public front door. A scroll-driven monologue that resolves
 *  into a conventional landing page.
 *
 *  It owns its own scroll container rather than letting the document scroll:
 *  the app root is `overflow: hidden; height: 100dvh` (styles.css), so a nested
 *  scroller is the way to scroll here without mutating global page styles that
 *  the real app depends on. */
export function WelcomeSite() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  // `reached` is monotonic and drives one-shot animations — scrolling back up
  // must not replay a beat. `current` tracks where the reader actually is, and
  // drives the timeline rail.
  const [reached, setReached] = useState(0);
  const [current, setCurrent] = useState(0);
  const [atLanding, setAtLanding] = useState(false);

  // Scrolls to an element, suspending snap for the trip. Mandatory snap would
  // otherwise capture a programmatic smooth scroll partway and strand it.
  const scrollTo = useCallback((target: HTMLElement) => {
    const root = scrollerRef.current;
    if (!root) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const top = target.offsetTop;

    root.classList.add("is-skipping");
    root.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });

    if (reduced) {
      root.classList.remove("is-skipping");
      return;
    }

    // Poll until the scroll settles. `scrollend` is not usable here — it fires
    // for the already-settled position before the smooth scroll begins, which
    // would re-arm snapping mid-flight.
    const deadline = performance.now() + 2500;
    const settle = () => {
      if (Math.abs(root.scrollTop - top) < 2 || performance.now() > deadline) {
        root.classList.remove("is-skipping");
        return;
      }
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }, []);

  // Which beat is on screen. Mirrors the catalog's scroll-spy: bias the
  // observation band toward the upper middle so a beat counts as current once
  // it has genuinely arrived, not when its first pixel appears.
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;

    const sections = Array.from(root.querySelectorAll<HTMLElement>("[data-beat-index]"));
    if (sections.length === 0) return;

    if (!("IntersectionObserver" in window)) {
      // No observer: reveal everything rather than stranding the page on beat 0.
      setReached(BEATS.length - 1);
      setCurrent(BEATS.length - 1);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0];
        if (!first) return;
        const index = Number(first.target.getAttribute("data-beat-index"));
        if (Number.isNaN(index)) return;
        setCurrent(index);
        setReached((prev) => Math.max(prev, index));
      },
      { root, rootMargin: "-25% 0px -55% 0px", threshold: 0 },
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  // Once the landing is genuinely on screen, drop the skip affordance and the
  // rail (neither has anywhere left to go) and release scroll snapping, so the
  // page below reads as an ordinary document. The margin holds this off until
  // the landing has come up past the lower third — otherwise a single pixel of
  // it would unsnap the last beat.
  useEffect(() => {
    const root = scrollerRef.current;
    const landing = root?.querySelector("#gsv-site-landing");
    if (!root || !landing || !("IntersectionObserver" in window)) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setAtLanding(entry.isIntersecting);
      },
      { root, rootMargin: "0px 0px -66% 0px", threshold: 0 },
    );
    observer.observe(landing);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    scrollerRef.current?.classList.toggle("is-free", atLanding);
  }, [atLanding]);

  function skip() {
    const landing = scrollerRef.current?.querySelector<HTMLElement>("#gsv-site-landing");
    if (landing) scrollTo(landing);
  }

  function goToBeat(index: number) {
    const beat = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-beat-index="${index}"]`,
    );
    if (beat) scrollTo(beat);
  }

  const showSkip = reached >= SKIP_FROM_BEAT && !atLanding;
  const showRail = reached >= RAIL_FROM_BEAT && !atLanding;

  return (
    <div class="gsv-site" ref={scrollerRef}>
      {/* Texture layers sit above the field and below the copy. Fixed to the
          scroller so the screen effect stays put while content moves through
          it — the page reads as one continuous display, not as scrolling
          wallpaper. */}
      <div class="gsv-site-texture gsv-site-scanlines" aria-hidden="true" />
      <div class="gsv-site-texture gsv-site-vignette" aria-hidden="true" />

      <main class="gsv-site-flow">
        {BEATS.map((beat, index) => (
          <NarrativeBeat key={beat.id} beat={beat} index={index} active={reached >= index} />
        ))}
        <LandingSection />
      </main>

      <TimelineRail current={current} visible={showRail} onSelect={goToBeat} />

      <button
        type="button"
        class={`gsv-site-skip${showSkip ? " is-shown" : ""}`}
        onClick={skip}
        tabIndex={showSkip ? 0 : -1}
        aria-hidden={showSkip ? undefined : "true"}
      >
        skip <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}
