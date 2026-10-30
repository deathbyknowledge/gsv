//! `gsv files`: list, read, move and search files on the Ship or a place.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use gateway_client::BinaryBody;
use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde_json::{json, Value};

use crate::cli::FilesAction;
use crate::remote::{
    self, call, fs_args, items, number, resolve_place_path, text, DynError, Output,
};
use crate::render::{self, Cell, Table, Tone};

const TRANSFER_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    action: FilesAction,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    match action {
        FilesAction::Ls { path } => ls(&client, path.as_deref().unwrap_or("."), out).await,
        FilesAction::Cat { path } => cat(&client, &path, out).await,
        FilesAction::Put { local, path } => put(&client, &local, &path, out).await,
        FilesAction::Get { path, local } => get(&client, &path, local, out).await,
        FilesAction::Cp { from, to } => {
            let (source_target, source) = resolve_place_path(&client, &from).await?;
            let (destination_target, destination) = resolve_place_path(&client, &to).await?;
            let result = call(
                &client,
                "fs.copy",
                json!({
                    "source": fs_args(&source_target, &source),
                    "destination": fs_args(&destination_target, &destination),
                }),
            )
            .await?;
            if out.json {
                return render::print_json(&result);
            }
            let size = result
                .get("size")
                .map(|_| render::human_size(remote::amount(&result, "size")));
            println!(
                "Copied {from} to {to}{}.",
                size.map(|size| format!(" ({size})")).unwrap_or_default()
            );
            Ok(())
        }
        FilesAction::Rm { path } => {
            let (target, resolved) = resolve_place_path(&client, &path).await?;
            let result = call(&client, "fs.delete", fs_args(&target, &resolved)).await?;
            if out.json {
                return render::print_json(&result);
            }
            println!("Deleted {path}.");
            Ok(())
        }
        FilesAction::Search {
            query,
            path,
            include,
        } => search(&client, &query, path.as_deref(), include, out).await,
    }
}

async fn ls(client: &KernelClient, input: &str, out: Output) -> Result<(), DynError> {
    let (target, path) = resolve_place_path(client, input).await?;
    // A reference answers any file with what it is and its size, without reading its contents.
    let mut args = fs_args(&target, &path);
    args["representation"] = json!("reference");
    let (result, _) = remote::read_path(client, args).await?;
    if out.json {
        return render::print_json(&result);
    }
    let style = out.style;
    let shown = text(&result, "path");
    let shown = if shown.is_empty() { input } else { shown };
    if result.get("files").is_none() {
        let size = result
            .get("size")
            .map(|_| render::human_size(remote::amount(&result, "size")));
        print!(
            "{}",
            render::detail(
                &style,
                &[
                    ("File", Cell::new(shown, Tone::Strong)),
                    ("Size", size.unwrap_or_default().into()),
                    ("Type", text(&result, "contentType").into()),
                ]
            )
        );
        return Ok(());
    }
    let mut directories: Vec<&str> = items(&result, "directories")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let mut files: Vec<&str> = items(&result, "files")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    directories.sort_unstable_by_key(|name| name.to_lowercase());
    files.sort_unstable_by_key(|name| name.to_lowercase());
    let place = target
        .as_deref()
        .map(|target| format!("{target}:"))
        .unwrap_or_default();
    let note = format!(
        "{} · {}",
        render::count(directories.len(), "folder", "folders"),
        render::count(files.len(), "file", "files")
    );
    print!(
        "{}",
        render::heading(&style, &format!("{place}{shown}"), Some(&note))
    );
    if directories.is_empty() && files.is_empty() {
        print!("{}", render::empty(&style, "This folder is empty.", None));
        return Ok(());
    }
    let mut table = Table::bare();
    for directory in directories {
        table.row(vec![Cell::new(
            format!("{}/", directory.trim_end_matches('/')),
            Tone::Accent,
        )]);
    }
    for file in files {
        table.row(vec![file.into()]);
    }
    print!("{}", table.render(&style));
    Ok(())
}

async fn cat(client: &KernelClient, input: &str, out: Output) -> Result<(), DynError> {
    let (target, path) = resolve_place_path(client, input).await?;
    let (result, body) = remote::read_path(client, fs_args(&target, &path)).await?;
    if result.get("files").is_some() {
        return Err(format!("{input} is a folder. List it with: gsv files ls {input}").into());
    }
    if text(&result, "kind") != "text" {
        return Err(format!(
            "{input} isn't text ({}). Download it with: gsv files get {input}",
            text(&result, "contentType")
        )
        .into());
    }
    let body = body.unwrap_or_default();
    if out.json {
        let mut result = result;
        result["content"] = json!(String::from_utf8_lossy(&body));
        return render::print_json(&result);
    }
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&body)?;
    if !body.ends_with(b"\n") && !body.is_empty() {
        stdout.write_all(b"\n")?;
    }
    if remote::flag(&result, "truncated") {
        eprintln!(
            "{}",
            render::Style::stderr()
                .dim("The file is longer than shown. Download all of it with gsv files get.")
        );
    }
    Ok(())
}

async fn put(
    client: &KernelClient,
    local: &Path,
    input: &str,
    out: Output,
) -> Result<(), DynError> {
    let file = tokio::fs::File::open(local)
        .await
        .map_err(|error| format!("Can't read {}: {error}", local.display()))?;
    let length = file.metadata().await?.len();
    let (target, mut path) = resolve_place_path(client, input).await?;
    if path.ends_with('/') {
        let name = local
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("The local file has no usable name")?;
        path.push_str(name);
    }
    let response = client
        .connection()
        .request_with_body(
            "fs.transfer.receive",
            Some(fs_args(&target, &path)),
            BinaryBody::from_reader(file, Some(length)),
            TRANSFER_TIMEOUT,
        )
        .await?;
    let result = response.data;
    if result.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(text(&result, "error").to_string().into());
    }
    if out.json {
        return render::print_json(&result);
    }
    let written = if result.get("bytesWritten").is_some() {
        remote::amount(&result, "bytesWritten")
    } else {
        length
    };
    println!(
        "Uploaded {} ({}) to {}.",
        local.display(),
        render::human_size(written),
        place_label(&target, text(&result, "path"))
    );
    Ok(())
}

async fn get(
    client: &KernelClient,
    input: &str,
    local: Option<PathBuf>,
    out: Output,
) -> Result<(), DynError> {
    let (target, path) = resolve_place_path(client, input).await?;
    let response = client
        .connection()
        .request_response(
            "fs.transfer.send",
            Some(fs_args(&target, &path)),
            TRANSFER_TIMEOUT,
        )
        .await?;
    let result = response.data;
    if result.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(text(&result, "error").to_string().into());
    }
    let mut body = response.body.ok_or("Your Ship sent no file contents")?;
    let to_stdout = local.as_deref() == Some(Path::new("-"));
    let destination = match local {
        Some(local) if !to_stdout && local.is_dir() => local.join(file_name(&path)?),
        Some(local) => local,
        None => PathBuf::from(file_name(&path)?),
    };
    let mut written = 0u64;
    if to_stdout {
        let mut stdout = std::io::stdout().lock();
        while let Some(chunk) = body.recv().await? {
            stdout.write_all(&chunk)?;
        }
        return Ok(());
    }
    let partial = PathBuf::from(format!("{}.gsv-partial", destination.display()));
    let mut file = std::fs::File::create(&partial)
        .map_err(|error| format!("Can't write {}: {error}", partial.display()))?;
    let received = async {
        while let Some(chunk) = body.recv().await? {
            file.write_all(&chunk)?;
            written += chunk.len() as u64;
        }
        file.sync_all()?;
        Ok::<(), DynError>(())
    }
    .await;
    if let Err(error) = received {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    std::fs::rename(&partial, &destination)?;
    if out.json {
        let mut result = result;
        result["savedTo"] = json!(destination.display().to_string());
        return render::print_json(&result);
    }
    println!(
        "Saved {} ({}) to {}.",
        input,
        render::human_size(written),
        destination.display()
    );
    Ok(())
}

fn file_name(path: &str) -> Result<String, DynError> {
    path.trim_end_matches('/')
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty() && *name != "~" && *name != "." && *name != "..")
        .map(str::to_string)
        .ok_or_else(|| {
            format!("Say where to save {path}, for example: gsv files get {path} ./copy").into()
        })
}

fn place_label(target: &Option<String>, path: &str) -> String {
    match target {
        Some(target) => format!("{target}:{path}"),
        None => path.to_string(),
    }
}

async fn search(
    client: &KernelClient,
    query: &str,
    path: Option<&str>,
    include: Option<String>,
    out: Output,
) -> Result<(), DynError> {
    let (target, folder) = resolve_place_path(client, path.unwrap_or(".")).await?;
    let mut args = fs_args(&target, &folder);
    args["query"] = json!(query);
    if let Some(include) = include {
        args["include"] = json!(include);
    }
    let result = call(client, "fs.search", args).await?;
    if out.json {
        return render::print_json(&result);
    }
    let style = out.style;
    let matches = items(&result, "matches");
    if matches.is_empty() {
        print!(
            "{}",
            render::empty(
                &style,
                &format!("No files contain \"{query}\"."),
                Some("Search another folder: gsv files search TEXT PLACE:FOLDER")
            )
        );
        return Ok(());
    }
    let mut current = "";
    let mut table = Table::bare().flex(1);
    let mut blocks = String::new();
    for found in matches {
        let file = text(found, "path");
        if file != current {
            if !table.is_empty() {
                blocks.push_str(&table.render(&style));
                table = Table::bare().flex(1);
            }
            blocks.push_str(&format!("{}\n", style.strong(&place_label(&target, file))));
            current = file;
        }
        table.row(vec![
            Cell::new(
                format!("  {}", number(found, "line").unwrap_or_default()),
                Tone::Dim,
            ),
            text(found, "content").trim().into(),
        ]);
    }
    blocks.push_str(&table.render(&style));
    print!(
        "{}",
        render::heading(
            &style,
            &format!("\"{query}\""),
            Some(&render::count(matches.len(), "match", "matches"))
        )
    );
    print!("{blocks}");
    if remote::flag(&result, "truncated") {
        print!(
            "{}",
            render::hint(
                &style,
                "More matches exist; narrow the folder or add --include."
            )
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_default_to_the_remote_file_name() {
        assert_eq!(file_name("~/notes/todo.md").expect("name"), "todo.md");
        assert_eq!(file_name("C:\\Users\\me\\a.txt").expect("windows"), "a.txt");
        file_name("~").expect_err("rejected");
        file_name("/").expect_err("rejected");
    }
}
