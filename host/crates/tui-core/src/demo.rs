//! Canned replies for the no-account demo.

#[allow(unused_imports)]
use crate::prelude::*;

pub(crate) fn demo_reply(request: &str) -> String {
    let normalized = request.to_ascii_lowercase();
    if normalized.contains("markdown") || normalized.contains("media") {
        "# A terminal document\n\nThis is **structured**, restrained, and still feels native to the shell.\n\n- Markdown becomes typography\n- Links remain inspectable\n- Media remains an addressable artifact\n\n```sh\nship@macbook $ du -sh ~/Downloads/*\n```\n\n> GSV owns the grammar. Your terminal owns the atmosphere."
            .to_string()
    } else if normalized.contains("download") && normalized.contains("open") {
        "I’d open ~/Downloads on this computer.\n\nThis preview is intentionally disconnected, so no local action was taken. The connected TUI sends the same request through GSV’s capability boundary."
            .to_string()
    } else if normalized.starts_with("ls") || normalized.contains("list the files") {
        "Desktop\nDocuments\nDownloads\nPictures\nProjects\n\nIn connected mode this comes from the selected machine target; this preview uses example output."
            .to_string()
    } else {
        format!(
            "Understood. I’d turn “{}” into an inspectable GSV run, ask only for capabilities it needs, and keep you in control while it works.\n\nThis browser/native preview is exercising the shared TUI interface; connect it to run the request for real.",
            request.trim()
        )
    }
}
