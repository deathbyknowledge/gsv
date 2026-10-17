use serde::Deserialize;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::speech::{SpeechEvent, SpeechRuntime};

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
    portal: Option<(
        tokio::sync::oneshot::Sender<()>,
        tauri::async_runtime::JoinHandle<()>,
    )>,
}

impl Shortcuts {
    pub async fn stop(&mut self, app: &tauri::AppHandle) {
        self.settings = None;
        for shortcut in self.native.drain(..) {
            let _ = app.global_shortcut().unregister(shortcut);
        }
        if let Some((stop, mut task)) = self.portal.take() {
            let _ = stop.send(());
            if tokio::time::timeout(std::time::Duration::from_secs(2), &mut task)
                .await
                .is_err()
            {
                task.abort();
            }
        }
    }

    pub async fn configure(
        &mut self,
        app: &tauri::AppHandle,
        speech: SpeechRuntime,
        settings: ShortcutSettings,
    ) -> Result<(), String> {
        if self.settings.as_ref() == Some(&settings)
            && self
                .portal
                .as_ref()
                .is_none_or(|(stop, _)| !stop.is_closed())
        {
            return Ok(());
        }
        if !settings.enabled {
            self.stop(app).await;
            speech.event(SpeechEvent::Shortcuts {
                description: "Global shortcuts off".into(),
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
        self.stop(app).await;
        #[cfg(target_os = "linux")]
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let configured = settings.clone();
            let app_id = app.config().identifier.clone();
            self.portal = Some((
                stop,
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = portal(speech.clone(), app_id, configured, stopped).await {
                        speech.event(SpeechEvent::Shortcuts {
                            description: "Shortcuts unavailable".into(),
                            error: Some(error),
                        });
                    }
                }),
            ));
            self.settings = Some(settings);
            return Ok(());
        }
        for (key, press, release) in [(talk, "press", Some("release")), (stop, "cancel", None)] {
            let speech = speech.clone();
            let held = std::sync::atomic::AtomicBool::new(false);
            if let Err(error) = app
                .global_shortcut()
                .on_shortcut(key, move |_app, _key, event| {
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
                self.stop(app).await;
                return Err(format!("Could not register shortcut: {error}"));
            }
            self.native.push(key);
        }
        speech.event(SpeechEvent::Shortcuts {
            description: format!("{} · stop {}", settings.talk, settings.stop),
            error: None,
        });
        self.settings = Some(settings);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
async fn portal(
    speech: SpeechRuntime,
    app_id: String,
    settings: ShortcutSettings,
    mut stopped: tokio::sync::oneshot::Receiver<()>,
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
        let shortcuts = [
            NewShortcut::new("talk", "Talk to Ship").preferred_trigger(settings.talk.as_str()),
            NewShortcut::new("stop", "Stop Ship speaking or cancel recording")
                .preferred_trigger(settings.stop.as_str()),
        ];
        let mut activated = portal.receive_activated().await?;
        let mut deactivated = portal.receive_deactivated().await?;
        let bound = portal
            .bind_shortcuts(&session, &shortcuts, None)
            .await?
            .response()?;
        let description = bound
            .shortcuts()
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
            error: None,
        });
        loop {
            tokio::select! {
                Some(event) = activated.next() => if Some(event.session_handle().as_str()) == session_path.as_str() {
                    match event.shortcut_id() { "talk" => speech.shortcut("press"), "stop" => speech.shortcut("cancel"), _ => {} }
                },
                Some(event) = deactivated.next() => if Some(event.session_handle().as_str()) == session_path.as_str() && event.shortcut_id() == "talk" {
                    speech.shortcut("release");
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
