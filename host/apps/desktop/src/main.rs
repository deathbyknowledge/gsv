mod app;
mod attachments;
mod audio;
mod client;
mod content;
mod desktop_control;
mod history;
mod interaction;
mod machine_setup;
mod media_files;
mod model;
mod prepared;
mod startup;
mod system_status;
mod theme;
mod transcription;
mod typography;
mod vision_debug;
mod visual_showcase;

use std::borrow::Cow;
use std::env;
use std::path::Path;
use std::{cell::RefCell, rc::Rc};

use gpui::{
    px, size, App, AppContext, Application, Bounds, TitlebarOptions, WindowBounds, WindowOptions,
};
use gpui_component::{Root, Theme, ThemeMode};

use crate::app::{GsvApp, VisionStartup};

fn main() {
    let arguments = env::args().collect::<Vec<_>>();
    if arguments
        .get(1)
        .is_some_and(|argument| argument == "--render-macos-icon")
    {
        let Some(path) = arguments.get(2).filter(|_| arguments.len() == 3) else {
            eprintln!("Usage: gsv-desktop --render-macos-icon OUTPUT.png");
            std::process::exit(2);
        };
        if let Err(error) = system_status::write_macos_app_icon(Path::new(path)) {
            eprintln!("GSV Desktop could not render its application icon: {error}");
            std::process::exit(1);
        }
        return;
    }
    if !graphical_session_available() {
        eprintln!("GSV native needs a graphical session (DISPLAY or WAYLAND_DISPLAY).");
        return;
    }
    if arguments.iter().any(|argument| argument == "--visuals") {
        run_visual_showcase();
        return;
    }

    let demo = arguments.iter().any(|argument| argument == "--demo");
    let sound_enabled = !arguments.iter().any(|argument| argument == "--mute");
    let reduced_motion = arguments
        .iter()
        .any(|argument| argument == "--reduce-motion")
        || env::var("GSV_REDUCE_MOTION").is_ok_and(|value| value == "1");
    let client = match client::start_desktop(demo) {
        client::DesktopStartup::Started(client) => client,
        client::DesktopStartup::ActivatedExisting => return,
        client::DesktopStartup::Failed(message) => {
            eprintln!("GSV Desktop could not start: {message}");
            return;
        }
    };
    let vision_startup = match vision_debug::start_for_desktop() {
        Ok(Some(helper)) => VisionStartup::Started(helper),
        Ok(None) => VisionStartup::Disabled,
        Err(error) => {
            eprintln!("GSV gesture controls are unavailable: {error}");
            VisionStartup::Unavailable
        }
    };

    Application::new().run(move |cx: &mut App| {
        gpui_component::init(cx);
        system_status::configure_application(cx);
        app::bind_keys(cx);
        register_fonts(cx);
        configure_theme(cx);
        let (status_item, status_actions) = match system_status::SystemStatusItem::start() {
            Ok((item, actions)) => (Some(Rc::new(RefCell::new(item))), Some(actions)),
            Err(error) => {
                eprintln!("GSV Desktop status item is unavailable: {error}");
                (None, None)
            }
        };

        let bounds = Bounds::centered(None, size(px(1_280.0), px(820.0)), cx);
        let window = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("GSV".into()),
                    appears_transparent: true,
                    ..Default::default()
                }),
                app_id: Some("gsv-desktop".to_string()),
                window_min_size: Some(size(px(720.0), px(520.0))),
                ..Default::default()
            },
            move |window, cx| {
                system_status::keep_running_on_close(window, cx);
                let view = cx.new(|cx| {
                    let mut app = GsvApp::new_with_vision(
                        window,
                        cx,
                        client,
                        demo,
                        sound_enabled,
                        reduced_motion,
                        vision_startup,
                    );
                    if let Some(actions) = status_actions {
                        app.attach_system_status_actions(actions, window, cx);
                    }
                    app
                });
                if let Some(status_item) = status_item {
                    status_item
                        .borrow_mut()
                        .update(view.read(cx).system_status_snapshot());
                    cx.observe(&view, move |view, cx| {
                        let snapshot = view.read(cx).system_status_snapshot();
                        status_item.borrow_mut().update(snapshot);
                    })
                    .detach();
                }
                cx.new(|cx| Root::new(view, window, cx))
            },
        );

        if let Err(error) = window {
            eprintln!("GSV native window could not open: {error}");
            cx.quit();
        }
    });
}

fn run_visual_showcase() {
    Application::new().run(|cx: &mut App| {
        gpui_component::init(cx);
        system_status::configure_application(cx);
        register_fonts(cx);
        configure_theme(cx);
        visual_showcase::bind_keys(cx);

        let bounds = Bounds::centered(None, size(px(1_280.0), px(820.0)), cx);
        let window = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("GSV Visual Core".into()),
                    appears_transparent: true,
                    ..Default::default()
                }),
                app_id: Some("gsv-visual-core".to_string()),
                window_min_size: Some(size(px(900.0), px(600.0))),
                ..Default::default()
            },
            |window, cx| {
                let view = cx.new(|cx| visual_showcase::VisualShowcase::new(window, cx));
                cx.new(|cx| Root::new(view, window, cx))
            },
        );
        if let Err(error) = window {
            eprintln!("GSV visual core could not open: {error}");
            cx.quit();
        } else {
            cx.activate(true);
        }
    });
}

fn graphical_session_available() -> bool {
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    {
        env::var_os("DISPLAY").is_some() || env::var_os("WAYLAND_DISPLAY").is_some()
    }
    #[cfg(not(any(target_os = "linux", target_os = "freebsd")))]
    {
        true
    }
}

fn register_fonts(cx: &mut App) {
    let fonts: Vec<Cow<'static, [u8]>> = vec![
        Cow::Borrowed(include_bytes!(
            "../../../../web/public/fonts/SpaceGrotesk-400.woff2"
        )),
        Cow::Borrowed(include_bytes!(
            "../../../../web/public/fonts/SpaceGrotesk-500.woff2"
        )),
        Cow::Borrowed(include_bytes!(
            "../../../../web/public/fonts/SpaceGrotesk-700.woff2"
        )),
        Cow::Borrowed(include_bytes!(
            "../../../../web/public/fonts/DepartureMono-Regular.woff2"
        )),
    ];
    if let Err(error) = cx.text_system().add_fonts(fonts) {
        eprintln!("GSV native fonts could not be registered: {error}");
    }
}

fn configure_theme(cx: &mut App) {
    let theme = Theme::global_mut(cx);
    theme.mode = ThemeMode::Dark;
    theme.font_family = theme::PROSE_FONT.into();
    theme.mono_font_family = theme::MONO_FONT.into();
    theme.font_size = px(16.0);
    theme.mono_font_size = px(13.0);
    theme.colors.background = theme::color(theme::VOID);
    theme.colors.foreground = theme::color(theme::TEXT);
    theme.colors.muted = theme::color(theme::TEXT_FAINT);
    theme.colors.muted_foreground = theme::color(theme::TEXT_QUIET);
    theme.colors.primary = theme::color(theme::ACCENT);
    theme.colors.primary_foreground = theme::color(theme::VOID);
    theme.colors.accent = theme::color(theme::SELECTION);
    theme.colors.accent_foreground = theme::color(theme::TEXT);
    theme.colors.caret = theme::color(theme::ACCENT);
    theme.colors.selection = theme::color(theme::SELECTION);
    theme.colors.border = theme::color(theme::TEXT_FAINT);
    theme.colors.input = theme::color(theme::TEXT_FAINT);
    theme.shadow = false;
    theme.radius = px(0.0);
    theme.radius_lg = px(0.0);
}

#[cfg(test)]
mod tests {
    use gpui::TestAppContext;

    use super::*;

    #[gpui::test]
    fn demo_surface_builds_in_gpui(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            app::bind_keys(cx);
            register_fonts(cx);
            configure_theme(cx);
        });

        let client = client::start(true);
        let _window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the headless GPUI surface should build")
        });
    }
}
