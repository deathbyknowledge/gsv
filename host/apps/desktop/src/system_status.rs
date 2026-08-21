use std::path::Path;

use gpui::{actions, App, KeyBinding, Menu, MenuItem as AppMenuItem, SystemMenuType, Window};
use resvg::tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, Transform};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tray_icon::menu::{Menu as TrayMenu, MenuEvent, MenuItem, PredefinedMenuItem};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

#[cfg(any(target_os = "macos", target_os = "windows"))]
const OPEN_ID: &str = "gsv.open";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const VOICE_ID: &str = "gsv.voice";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const GESTURES_ID: &str = "gsv.gestures";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const QUIT_ID: &str = "gsv.quit";
const SHIP_SVG: &str = include_str!("../../../../web/public/brand/gsv-mark-white.svg");

actions!(desktop_lifecycle, [QuitDesktop]);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SystemStatusAction {
    Open,
    ToggleVoice,
    OpenGestureGuide,
    Quit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GatewayStatus {
    SignedOut,
    Connecting,
    Connected,
}

impl GatewayStatus {
    fn label(self) -> &'static str {
        match self {
            Self::SignedOut => "Gateway: Sign in required",
            Self::Connecting => "Gateway: Connecting",
            Self::Connected => "Gateway: Connected",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GestureStatus {
    Disabled,
    Starting,
    Disarmed,
    Armed,
    Unavailable,
}

impl GestureStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Disabled => "Gestures: Disabled",
            Self::Starting => "Gestures: Starting",
            Self::Disarmed => "Gestures: Ready, disarmed",
            Self::Armed => "Gestures: Armed",
            Self::Unavailable => "Gestures: Unavailable",
        }
    }

    fn guide_available(self) -> bool {
        matches!(self, Self::Starting | Self::Disarmed | Self::Armed)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SystemStatusSnapshot {
    pub(crate) gateway: GatewayStatus,
    pub(crate) machine_ready: bool,
    pub(crate) voice_active: bool,
    pub(crate) voice_available: bool,
    pub(crate) gestures: GestureStatus,
}

pub(crate) struct SystemStatusItem {
    backend: StatusItemBackend,
    last_snapshot: Option<SystemStatusSnapshot>,
}

impl SystemStatusItem {
    pub(crate) fn start() -> Result<(Self, UnboundedReceiver<SystemStatusAction>), String> {
        let (actions, receiver) = mpsc::unbounded_channel();
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let actions = actions.clone();
            MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
                let action = match event.id().as_ref() {
                    OPEN_ID => Some(SystemStatusAction::Open),
                    VOICE_ID => Some(SystemStatusAction::ToggleVoice),
                    GESTURES_ID => Some(SystemStatusAction::OpenGestureGuide),
                    QUIT_ID => Some(SystemStatusAction::Quit),
                    _ => None,
                };
                if let Some(action) = action {
                    let _ = actions.send(action);
                }
            }));
        }

        Ok((
            Self {
                backend: StatusItemBackend::start(actions)?,
                last_snapshot: None,
            },
            receiver,
        ))
    }

    pub(crate) fn update(&mut self, snapshot: SystemStatusSnapshot) {
        if self.last_snapshot == Some(snapshot) {
            return;
        }
        self.backend.update(snapshot);
        self.last_snapshot = Some(snapshot);
    }
}

pub(crate) fn configure_application(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("secondary-q", QuitDesktop, None)]);
    cx.on_action(|_: &QuitDesktop, cx| cx.quit());
    cx.set_menus(vec![Menu {
        name: "GSV".into(),
        items: vec![
            AppMenuItem::os_submenu("Services", SystemMenuType::Services),
            AppMenuItem::separator(),
            AppMenuItem::action("Quit GSV", QuitDesktop),
        ],
    }]);
}

pub(crate) fn keep_running_on_close(window: &mut Window, cx: &App) {
    window.on_window_should_close(cx, |_window, _cx| {
        #[cfg(target_os = "macos")]
        _cx.hide();
        #[cfg(not(target_os = "macos"))]
        _window.minimize_window();
        false
    });
}

pub(crate) fn write_macos_app_icon(path: &Path) -> Result<(), String> {
    let mut pixmap = Pixmap::new(1_024, 1_024)
        .ok_or_else(|| "could not allocate the macOS icon canvas".to_string())?;
    let inset = 92.0;
    let side = 840.0;
    let radius = 188.0;
    let background = rounded_rectangle(inset, inset, side, side, radius)?;
    let mut paint = Paint::default();
    paint.set_color_rgba8(0x07, 0x06, 0x1a, 0xff);
    pixmap.fill_path(
        &background,
        &paint,
        FillRule::Winding,
        Transform::identity(),
        None,
    );
    render_ship(&mut pixmap, 532.0, false)?;
    pixmap
        .save_png(path)
        .map_err(|error| format!("could not write the macOS icon: {error}"))
}

fn rounded_rectangle(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    radius: f32,
) -> Result<resvg::tiny_skia::Path, String> {
    const KAPPA: f32 = 0.552_284_8;
    let right = x + width;
    let bottom = y + height;
    let handle = radius * KAPPA;
    let mut path = PathBuilder::new();
    path.move_to(x + radius, y);
    path.line_to(right - radius, y);
    path.cubic_to(
        right - radius + handle,
        y,
        right,
        y + radius - handle,
        right,
        y + radius,
    );
    path.line_to(right, bottom - radius);
    path.cubic_to(
        right,
        bottom - radius + handle,
        right - radius + handle,
        bottom,
        right - radius,
        bottom,
    );
    path.line_to(x + radius, bottom);
    path.cubic_to(
        x + radius - handle,
        bottom,
        x,
        bottom - radius + handle,
        x,
        bottom - radius,
    );
    path.line_to(x, y + radius);
    path.cubic_to(
        x,
        y + radius - handle,
        x + radius - handle,
        y,
        x + radius,
        y,
    );
    path.close();
    path.finish()
        .ok_or_else(|| "could not construct the macOS icon mask".to_string())
}

fn ship_tree(monochrome: bool) -> Result<usvg::Tree, String> {
    let source = monochrome.then(|| {
        SHIP_SVG
            .replace("#cfd3f2", "#ffffff")
            .replace("#eef1f8", "#ffffff")
            .replace("#a9a4ff", "#ffffff")
            .replace("#d6d3ff", "#ffffff")
    });
    usvg::Tree::from_data(
        source.as_deref().unwrap_or(SHIP_SVG).as_bytes(),
        &usvg::Options::default(),
    )
    .map_err(|error| format!("could not parse the ship mark: {error}"))
}

fn render_ship(pixmap: &mut Pixmap, target_height: f32, monochrome: bool) -> Result<(), String> {
    let tree = ship_tree(monochrome)?;
    let source = tree.size();
    let scale = target_height / source.height();
    let width = source.width() * scale;
    let x = (pixmap.width() as f32 - width) / 2.0;
    let y = (pixmap.height() as f32 - target_height) / 2.0;
    let transform = Transform::from_row(scale, 0.0, 0.0, scale, x, y);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn tray_icon() -> Result<Icon, String> {
    Icon::from_rgba(tray_icon_rgba()?, 32, 32)
        .map_err(|error| format!("could not construct the status icon: {error}"))
}

fn tray_icon_rgba() -> Result<Vec<u8>, String> {
    let mut pixmap = Pixmap::new(32, 32)
        .ok_or_else(|| "could not allocate the status icon canvas".to_string())?;
    render_ship(&mut pixmap, 26.0, true)?;
    let mut rgba = pixmap.data().to_vec();
    for pixel in rgba.chunks_exact_mut(4) {
        if pixel[3] != 0 {
            pixel[0] = 0xff;
            pixel[1] = 0xff;
            pixel[2] = 0xff;
        }
    }
    Ok(rgba)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
struct NativeStatusItem {
    _tray: TrayIcon,
    _menu: TrayMenu,
    gateway: MenuItem,
    machine: MenuItem,
    voice: MenuItem,
    gestures: MenuItem,
    gesture_guide: MenuItem,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl NativeStatusItem {
    fn new() -> Result<Self, String> {
        let menu = TrayMenu::new();
        let open = MenuItem::with_id(OPEN_ID, "Open GSV", true, None);
        let gateway = MenuItem::new("Gateway: Connecting", false, None);
        let machine = MenuItem::new("Machine: Not set up", false, None);
        let first_separator = PredefinedMenuItem::separator();
        let voice = MenuItem::with_id(VOICE_ID, "Start Voice", false, None);
        let gestures = MenuItem::new("Gestures: Disabled", false, None);
        let gesture_guide = MenuItem::with_id(GESTURES_ID, "Open Gesture Guide…", false, None);
        let second_separator = PredefinedMenuItem::separator();
        let quit = MenuItem::with_id(QUIT_ID, "Quit GSV", true, None);
        menu.append_items(&[
            &open,
            &gateway,
            &machine,
            &first_separator,
            &voice,
            &gestures,
            &gesture_guide,
            &second_separator,
            &quit,
        ])
        .map_err(|error| format!("could not construct the status menu: {error}"))?;
        let tray = TrayIconBuilder::new()
            .with_id("gsv.status")
            .with_menu(Box::new(menu.clone()))
            .with_icon(tray_icon()?)
            .with_icon_as_template(true)
            .with_tooltip("GSV")
            .build()
            .map_err(|error| format!("could not create the status item: {error}"))?;
        Ok(Self {
            _tray: tray,
            _menu: menu,
            gateway,
            machine,
            voice,
            gestures,
            gesture_guide,
        })
    }

    fn update(&mut self, snapshot: SystemStatusSnapshot) {
        self.gateway.set_text(snapshot.gateway.label());
        self.machine.set_text(if snapshot.machine_ready {
            "Machine: Set up"
        } else {
            "Machine: Not set up"
        });
        self.voice.set_text(if snapshot.voice_active {
            "Finish Voice"
        } else {
            "Start Voice"
        });
        self.voice
            .set_enabled(snapshot.voice_active || snapshot.voice_available);
        self.gestures.set_text(snapshot.gestures.label());
        self.gesture_guide
            .set_enabled(snapshot.gestures.guide_available());
        let _ = self._tray.set_tooltip(Some(
            snapshot.gateway.label().replace("Gateway: ", "GSV · "),
        ));
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
struct StatusItemBackend {
    item: NativeStatusItem,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl StatusItemBackend {
    fn start(_: UnboundedSender<SystemStatusAction>) -> Result<Self, String> {
        Ok(Self {
            item: NativeStatusItem::new()?,
        })
    }

    fn update(&mut self, snapshot: SystemStatusSnapshot) {
        self.item.update(snapshot);
    }
}

#[cfg(target_os = "linux")]
struct StatusItemBackend {
    handle: ksni::blocking::Handle<LinuxStatusItem>,
}

#[cfg(target_os = "linux")]
impl StatusItemBackend {
    fn start(actions: UnboundedSender<SystemStatusAction>) -> Result<Self, String> {
        use ksni::blocking::TrayMethods as _;

        let handle = LinuxStatusItem {
            snapshot: SystemStatusSnapshot {
                gateway: GatewayStatus::Connecting,
                machine_ready: false,
                voice_active: false,
                voice_available: false,
                gestures: GestureStatus::Disabled,
            },
            actions,
            icon: linux_tray_icon()?,
        }
        .assume_sni_available(true)
        .spawn()
        .map_err(|error| format!("could not create the Linux status item: {error:?}"))?;
        Ok(Self { handle })
    }

    fn update(&mut self, snapshot: SystemStatusSnapshot) {
        let _ = self.handle.update(|item| item.snapshot = snapshot);
    }
}

#[cfg(target_os = "linux")]
impl Drop for StatusItemBackend {
    fn drop(&mut self) {
        self.handle.shutdown().wait();
    }
}

#[cfg(target_os = "linux")]
struct LinuxStatusItem {
    snapshot: SystemStatusSnapshot,
    actions: UnboundedSender<SystemStatusAction>,
    icon: ksni::Icon,
}

#[cfg(target_os = "linux")]
impl LinuxStatusItem {
    fn send(&self, action: SystemStatusAction) {
        let _ = self.actions.send(action);
    }
}

#[cfg(target_os = "linux")]
impl ksni::Tray for LinuxStatusItem {
    const MENU_ON_ACTIVATE: bool = true;

    fn id(&self) -> String {
        "gsv-desktop".to_string()
    }

    fn title(&self) -> String {
        "GSV".to_string()
    }

    fn activate(&mut self, _: i32, _: i32) {
        self.send(SystemStatusAction::Open);
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        vec![self.icon.clone()]
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip {
            title: "GSV".to_string(),
            description: self.snapshot.gateway.label().replace("Gateway: ", "GSV · "),
            icon_pixmap: vec![self.icon.clone()],
            ..Default::default()
        }
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::StandardItem;

        vec![
            StandardItem {
                label: "Open GSV".to_string(),
                activate: Box::new(|item: &mut LinuxStatusItem| {
                    item.send(SystemStatusAction::Open);
                }),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: self.snapshot.gateway.label().to_string(),
                enabled: false,
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: if self.snapshot.machine_ready {
                    "Machine: Set up"
                } else {
                    "Machine: Not set up"
                }
                .to_string(),
                enabled: false,
                ..Default::default()
            }
            .into(),
            ksni::MenuItem::Separator,
            StandardItem {
                label: if self.snapshot.voice_active {
                    "Finish Voice"
                } else {
                    "Start Voice"
                }
                .to_string(),
                enabled: self.snapshot.voice_active || self.snapshot.voice_available,
                activate: Box::new(|item: &mut LinuxStatusItem| {
                    item.send(SystemStatusAction::ToggleVoice);
                }),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: self.snapshot.gestures.label().to_string(),
                enabled: false,
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "Open Gesture Guide…".to_string(),
                enabled: self.snapshot.gestures.guide_available(),
                activate: Box::new(|item: &mut LinuxStatusItem| {
                    item.send(SystemStatusAction::OpenGestureGuide);
                }),
                ..Default::default()
            }
            .into(),
            ksni::MenuItem::Separator,
            StandardItem {
                label: "Quit GSV".to_string(),
                activate: Box::new(|item: &mut LinuxStatusItem| {
                    item.send(SystemStatusAction::Quit);
                }),
                ..Default::default()
            }
            .into(),
        ]
    }
}

#[cfg(target_os = "linux")]
fn linux_tray_icon() -> Result<ksni::Icon, String> {
    let mut data = tray_icon_rgba()?;
    for pixel in data.chunks_exact_mut(4) {
        pixel.rotate_right(1);
    }
    Ok(ksni::Icon {
        width: 32,
        height: 32,
        data,
    })
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn tray_mark_is_a_white_transparent_ship() {
        let rgba = tray_icon_rgba().expect("the embedded ship should render");
        let visible = rgba.chunks_exact(4).filter(|pixel| pixel[3] != 0);
        let visible = visible.collect::<Vec<_>>();
        assert!(!visible.is_empty());
        assert!(visible
            .iter()
            .all(|pixel| pixel[0..3] == [0xff, 0xff, 0xff]));
        assert!(rgba.chunks_exact(4).any(|pixel| pixel[3] == 0));
    }

    #[test]
    fn macos_icon_uses_the_canonical_ship_palette_on_a_rounded_square() {
        let directory = tempdir().expect("temporary icon directory");
        let path = directory.path().join("GSV.png");
        write_macos_app_icon(&path).expect("the embedded app icon should render");
        let image = image::open(path)
            .expect("rendered icon should decode")
            .into_rgba8();
        assert_eq!(image.dimensions(), (1_024, 1_024));
        assert_eq!(image.get_pixel(0, 0).0[3], 0);
        assert_eq!(image.get_pixel(512, 512).0[3], 0xff);
        assert!(image
            .pixels()
            .any(|pixel| pixel.0 == [0xff, 0xff, 0xff, 0xff]));
        assert!(image
            .pixels()
            .any(|pixel| pixel.0 == [0xa9, 0xa4, 0xff, 0xff]));
        assert!(image
            .pixels()
            .any(|pixel| pixel.0 == [0xd6, 0xd3, 0xff, 0xff]));
    }

    #[test]
    fn status_labels_distinguish_ready_controls() {
        assert_eq!(GatewayStatus::Connected.label(), "Gateway: Connected");
        assert_eq!(GestureStatus::Armed.label(), "Gestures: Armed");
        assert!(GestureStatus::Disarmed.guide_available());
        assert!(!GestureStatus::Unavailable.guide_available());
    }
}
