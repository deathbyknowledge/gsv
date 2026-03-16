import { useCallback, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { WALLPAPER_OPTIONS, type Wallpaper } from "../../ui/storage";

type WallpaperBgProps = {
  wallpaper: Wallpaper;
  onChangeWallpaper: (wallpaper: Wallpaper) => void;
};

export function WallpaperBg({ wallpaper, onChangeWallpaper }: WallpaperBgProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = useCallback(() => {
    if (menuRef.current) {
      menuRef.current.style.display = "none";
    }
  }, []);

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
