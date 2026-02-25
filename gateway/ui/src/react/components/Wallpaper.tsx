import { useCallback, useEffect, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { WALLPAPER_OPTIONS, type Wallpaper } from "../../ui/storage";

type WallpaperBgProps = {
  wallpaper: Wallpaper;
  onChangeWallpaper: (wallpaper: Wallpaper) => void;
};

/** Render ~120 tiny stars as absolutely positioned dots. */
function StarCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let w = 0;
    let h = 0;

    type Star = { x: number; y: number; r: number; a: number; da: number; dx: number; dy: number };
    let stars: Star[] = [];

    function resize() {
      w = window.innerWidth * window.devicePixelRatio;
      h = window.innerHeight * window.devicePixelRatio;
      canvas!.width = w;
      canvas!.height = h;
      canvas!.style.width = `${window.innerWidth}px`;
      canvas!.style.height = `${window.innerHeight}px`;
    }

    function init() {
      resize();
      const count = Math.round((w * h) / 12000); // density
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.2 + 0.3,
        a: Math.random(),
        da: (Math.random() - 0.5) * 0.003,
        dx: (Math.random() - 0.5) * 0.08,
        dy: (Math.random() - 0.5) * 0.08,
      }));
    }

    function draw() {
      const isLight = document.documentElement.getAttribute("data-theme") === "light";
      ctx!.clearRect(0, 0, w, h);
      for (const star of stars) {
        star.x += star.dx;
        star.y += star.dy;
        star.a += star.da;
        if (star.a > 1 || star.a < 0.1) star.da = -star.da;
        if (star.x < 0) star.x = w;
        if (star.x > w) star.x = 0;
        if (star.y < 0) star.y = h;
        if (star.y > h) star.y = 0;

        ctx!.beginPath();
        ctx!.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        ctx!.fillStyle = isLight
          ? `rgba(0, 0, 0, ${star.a * 0.25})`
          : `rgba(255, 255, 255, ${star.a * 0.7})`;
        ctx!.fill();
      }
      animId = requestAnimationFrame(draw);
    }

    init();
    draw();
    window.addEventListener("resize", init);
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", init);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none" }}
    />
  );
}

export function WallpaperBg({ wallpaper, onChangeWallpaper }: WallpaperBgProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = useCallback(() => {
    if (menuRef.current) {
      menuRef.current.style.display = "none";
    }
  }, []);

  // Right-click context menu
  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const menu = menuRef.current;
      if (!menu) return;
      menu.style.display = "block";
      menu.style.left = `${event.clientX}px`;
      menu.style.top = `${event.clientY}px`;

      const onClickAway = () => {
        closeMenu();
        window.removeEventListener("click", onClickAway);
      };
      // Delay to not immediately close
      requestAnimationFrame(() => {
        window.addEventListener("click", onClickAway);
      });
    },
    [closeMenu],
  );

  const selectWallpaper = useCallback(
    (wp: Wallpaper) => {
      onChangeWallpaper(wp);
      closeMenu();
    },
    [onChangeWallpaper, closeMenu],
  );

  return (
    <div
      className={`os-wallpaper os-wp-${wallpaper}`}
      onContextMenu={onContextMenu}
    >
      {wallpaper === "starfield" ? <StarCanvas /> : null}

      {/* Right-click context menu */}
      <div ref={menuRef} className="os-ctx-menu" style={{ display: "none" } as CSSProperties}>
        <div className="os-ctx-menu-label">Wallpaper</div>
        {WALLPAPER_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`os-ctx-menu-item ${opt.id === wallpaper ? "active" : ""}`}
            onClick={() => selectWallpaper(opt.id)}
          >
            <span className={`os-ctx-menu-preview os-wp-${opt.id}`} />
            <span>{opt.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
