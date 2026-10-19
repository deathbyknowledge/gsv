use serde::Deserialize;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::speech::{SpeechEvent, SpeechRuntime};

type EditorReply = tokio::sync::oneshot::Sender<Result<(), String>>;

struct PortalTask {
    stop: tokio::sync::oneshot::Sender<()>,
    task: tauri::async_runtime::JoinHandle<()>,
    editor: tokio::sync::mpsc::Sender<EditorReply>,
}

fn wayland() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some()
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShortcutSettings {
    pub enabled: bool,
    pub talk: String,
    pub stop: String,
}

#[derive(Default)]
pub struct Shortcuts {
    settings: Option<ShortcutSettings>,
    native: Vec<Shortcut>,
    portal: Option<PortalTask>,
}

impl Shortcuts {
    pub async fn stop(&mut self, app: &tauri::AppHandle) {
        self.settings = None;
        for shortcut in self.native.drain(..) {
            let _ = app.global_shortcut().unregister(shortcut);
        }
        if let Some(PortalTask { stop, mut task, .. }) = self.portal.take() {
            let _ = stop.send(());
            if tokio::time::timeout(std::time::Duration::from_secs(2), &mut task)
                .await
                .is_err()
            {
                task.abort();
            }
        }
    }

    pub async fn edit(&self) -> Result<(), String> {
        let portal = self
            .portal
            .as_ref()
            .ok_or("Enable voice shortcuts first.")?;
        let (reply, received) = tokio::sync::oneshot::channel();
        portal
            .editor
            .try_send(reply)
            .map_err(|_| "The shortcut editor is unavailable or busy.")?;
        tokio::time::timeout(std::time::Duration::from_secs(10), received)
            .await
            .map_err(|_| "The desktop shortcut editor did not respond.")?
            .map_err(|_| "The shortcut session closed.")?
    }

    pub async fn configure(
        &mut self,
        app: &tauri::AppHandle,
        speech: SpeechRuntime,
        settings: ShortcutSettings,
    ) -> Result<(), String> {
        let result = self.apply(app, speech.clone(), settings).await;
        if let Err(error) = &result {
            speech.event(SpeechEvent::Shortcuts {
                description: self.settings.as_ref().map_or_else(
                    || "Shortcuts unavailable".into(),
                    |settings| format!("{} · stop {}", settings.talk, settings.stop),
                ),
                managed: wayland(),
                can_configure: false,
                error: Some(error.clone()),
            });
        }
        result
    }

    async fn apply(
        &mut self,
        app: &tauri::AppHandle,
        speech: SpeechRuntime,
        settings: ShortcutSettings,
    ) -> Result<(), String> {
        if self.settings.as_ref() == Some(&settings)
            && self
                .portal
                .as_ref()
                .is_none_or(|portal| !portal.stop.is_closed())
        {
            return Ok(());
        }
        if !settings.enabled {
            self.stop(app).await;
            speech.event(SpeechEvent::Shortcuts {
                description: "Global shortcuts off".into(),
                managed: wayland(),
                can_configure: false,
                error: None,
            });
            return Ok(());
        }
        if settings.talk.len() > 80 || settings.stop.len() > 80 {
            return Err("Shortcut is too long.".into());
        }
        let talk: Shortcut = settings
            .talk
            .parse()
            .map_err(|error| format!("Invalid talk shortcut: {error}"))?;
        let stop: Shortcut = settings
            .stop
            .parse()
            .map_err(|error| format!("Invalid stop shortcut: {error}"))?;
        if talk == stop {
            return Err("Talk and stop need different shortcuts.".into());
        }
        #[cfg(target_os = "linux")]
        if wayland() {
            self.stop(app).await;
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let (editor, requests) = tokio::sync::mpsc::channel(1);
            let configured = settings.clone();
            let app_id = app.config().identifier.clone();
            self.portal = Some(PortalTask {
                stop,
                editor,
                task: tauri::async_runtime::spawn(async move {
                    if let Err(error) =
                        portal(speech.clone(), app_id, configured, stopped, requests).await
                    {
                        speech.event(SpeechEvent::Shortcuts {
                            description: "Shortcuts unavailable".into(),
                            managed: true,
                            can_configure: false,
                            error: Some(error),
                        });
                    }
                }),
            });
            self.settings = Some(settings);
            return Ok(());
        }
        let previous_settings = self.settings.clone();
        let previous_keys = self.native.clone();
        self.stop(app).await;
        let keys = vec![talk, stop];
        if let Err(error) = register_native(app, &speech, &keys) {
            if let Err(restore) = register_native(app, &speech, &previous_keys) {
                return Err(format!(
                    "{error} Previous shortcuts could not be restored: {restore}"
                ));
            }
            self.native = previous_keys;
            self.settings = previous_settings;
            return Err(format!("{error} Your previous shortcuts are unchanged."));
        }
        self.native = keys;
        speech.event(SpeechEvent::Shortcuts {
            description: format!("{} · stop {}", settings.talk, settings.stop),
            managed: false,
            can_configure: false,
            error: None,
        });
        self.settings = Some(settings);
        Ok(())
    }
}

fn register_native(
    app: &tauri::AppHandle,
    speech: &SpeechRuntime,
    keys: &[Shortcut],
) -> Result<(), String> {
    let mut registered = Vec::new();
    for (key, (press, release)) in keys
        .iter()
        .zip([("press", Some("release")), ("cancel", None)])
    {
        let speech = speech.clone();
        let held = std::sync::atomic::AtomicBool::new(false);
        if let Err(error) = app
            .global_shortcut()
            .on_shortcut(*key, move |_app, _key, event| {
                use std::sync::atomic::Ordering;
                match event.state() {
                    ShortcutState::Pressed if !held.swap(true, Ordering::Relaxed) => {
                        speech.shortcut(press)
                    }
                    ShortcutState::Released if held.swap(false, Ordering::Relaxed) => {
                        if let Some(action) = release {
                            speech.shortcut(action);
                        }
                    }
                    _ => {}
                }
            })
        {
            for key in registered {
                let _ = app.global_shortcut().unregister(key);
            }
            return Err(format!("Could not register shortcut: {error}"));
        }
        registered.push(*key);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn portal_trigger(value: &str) -> Option<String> {
    let key: Shortcut = value.parse().ok()?;
    key.into_string()
        .split('+')
        .map(|part| {
            Some(match part {
                "control" => "CTRL".into(),
                "alt" => "ALT".into(),
                "shift" => "SHIFT".into(),
                "super" => "LOGO".into(),
                "Space" => "space".into(),
                "Enter" => "Return".into(),
                "Backspace" => "BackSpace".into(),
                "PageUp" => "Page_Up".into(),
                "PageDown" => "Page_Down".into(),
                "Backquote" => "grave".into(),
                "Backslash" => "backslash".into(),
                "BracketLeft" => "bracketleft".into(),
                "BracketRight" => "bracketright".into(),
                "Comma" => "comma".into(),
                "Equal" => "equal".into(),
                "Minus" => "minus".into(),
                "Period" => "period".into(),
                "Quote" => "apostrophe".into(),
                "Semicolon" => "semicolon".into(),
                "Slash" => "slash".into(),
                "Escape" | "Tab" | "Delete" | "Insert" | "Home" | "End" => part.into(),
                _ if part.starts_with("Key") => part[3..].to_lowercase(),
                _ if part.starts_with("Digit") => part[5..].into(),
                _ if part.starts_with("Arrow") => part[5..].into(),
                _ if part.starts_with('F') && part[1..].parse::<u8>().is_ok() => part.into(),
                _ => return None,
            })
        })
        .collect::<Option<Vec<String>>>()
        .map(|parts| parts.join("+"))
}

#[cfg(target_os = "linux")]
async fn portal(
    speech: SpeechRuntime,
    app_id: String,
    settings: ShortcutSettings,
    mut stopped: tokio::sync::oneshot::Receiver<()>,
    mut editor: tokio::sync::mpsc::Receiver<EditorReply>,
) -> Result<(), String> {
    use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
    use futures_util::StreamExt;
    // ashpd shares one D-Bus connection. Host identity must be registered exactly
    // once on that connection, before its first portal request (including retries).
    static REGISTERED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    REGISTERED
        .get_or_try_init(|| async {
            let app_id = app_id
                .parse()
                .map_err(|error| format!("Invalid desktop application ID: {error}"))?;
            ashpd::register_host_app(app_id)
                .await
                .map_err(|error| format!("Register desktop with shortcut portal: {error}"))
        })
        .await?;
    let portal = GlobalShortcuts::new()
        .await
        .map_err(|error| format!("Open shortcut portal: {error}"))?;
    let session = portal
        .create_session()
        .await
        .map_err(|error| format!("Create shortcut session: {error}"))?;
    let session_path = serde_json::to_value(&session)
        .map_err(|error| format!("Read shortcut session: {error}"))?;
    let result = async {
        let can_configure = portal.get_property::<u32>("version").await? >= 2;
        let talk_trigger = portal_trigger(&settings.talk);
        let stop_trigger = portal_trigger(&settings.stop);
        let shortcuts = [
            NewShortcut::new("talk", "Talk to Ship").preferred_trigger(talk_trigger.as_deref()),
            NewShortcut::new("stop", "Stop Ship speaking or cancel recording")
                .preferred_trigger(stop_trigger.as_deref()),
        ];
        let mut activated = portal.receive_activated().await?;
        let mut deactivated = portal.receive_deactivated().await?;
        let mut changed = portal.receive_shortcuts_changed().await?;
        let bound = portal
            .bind_shortcuts(&session, &shortcuts, None)
            .await?
            .response()?;
        let publish = |keys: &[ashpd::desktop::global_shortcuts::Shortcut]| {
            let description = keys
                .iter()
                .filter(|key| !key.trigger_description().is_empty())
                .map(|key| format!("{}: {}", key.id(), key.trigger_description()))
                .collect::<Vec<_>>()
                .join(" · ");
            speech.event(SpeechEvent::Shortcuts {
                description: if description.is_empty() {
                    "Shortcuts registered. Your desktop controls their key assignments.".into()
                } else {
                    description
                },
                managed: true,
                can_configure,
                error: None,
            });
        };
        publish(bound.shortcuts());
        loop {
            tokio::select! {
                Some(event) = activated.next() => if Some(event.session_handle().as_str()) == session_path.as_str() {
                    match event.shortcut_id() { "talk" => speech.shortcut("press"), "stop" => speech.shortcut("cancel"), _ => {} }
                },
                Some(event) = deactivated.next() => if Some(event.session_handle().as_str()) == session_path.as_str() && event.shortcut_id() == "talk" {
                    speech.shortcut("release");
                },
                Some(event) = changed.next() => if Some(event.session_handle().as_str()) == session_path.as_str() {
                    publish(portal.list_shortcuts(&session).await?.response()?.shortcuts());
                },
                Some(reply) = editor.recv() => {
                    let result = portal.configure_shortcuts(&session, None, None).await
                        .map_err(|error| format!("Open desktop shortcut settings: {error}"));
                    let _ = reply.send(result);
                },
                else => break,
            }
        }
        Ok::<(), ashpd::Error>(())
    };
    let result = tokio::select! { result = result => result, _ = &mut stopped => Ok(()) };
    let _ = session.close().await;
    result.map_err(|error| format!("Global shortcut portal: {error}"))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn portal_preferences_use_xdg_modifiers_and_keysyms() {
        assert_eq!(
            portal_trigger("Ctrl+Shift+Space").as_deref(),
            Some("SHIFT+CTRL+space")
        );
        assert_eq!(
            portal_trigger("Ctrl+Alt+Escape").as_deref(),
            Some("CTRL+ALT+Escape")
        );
        assert_eq!(portal_trigger("Super+KeyV").as_deref(), Some("LOGO+v"));
        assert_eq!(portal_trigger("Alt+Enter").as_deref(), Some("ALT+Return"));
        assert_eq!(portal_trigger("invalid"), None);
    }
}
