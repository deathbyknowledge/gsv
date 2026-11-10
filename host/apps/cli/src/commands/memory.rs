//! `gsv memory`: your wikis and the standing notes in `~/context.d`.
//!
//! A wiki is a repository with a `wiki.json` manifest, found the same way
//! the Ship's own `wiki` command finds them.

use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde_json::{json, Value};

use crate::cli::MemoryAction;
use crate::remote::{self, call, items, number, opt_text, text, DynError, Output};
use crate::render::{self, Cell, Table, Tone};

const WIKI_MANIFEST_KIND: &str = "gsv.wiki";

#[derive(Clone, Debug)]
struct Wiki {
    id: String,
    title: String,
    repo: String,
    updated_at: Option<i64>,
}

fn title_from(name: &str) -> String {
    let leaf = name.trim_end_matches(".md").replace(['-', '_'], " ");
    let mut words: Vec<String> = Vec::new();
    for word in leaf.split_whitespace() {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            words.push(first.to_uppercase().chain(chars).collect());
        }
    }
    if words.is_empty() {
        "Knowledge".to_string()
    } else {
        words.join(" ")
    }
}

fn manifest_wiki(repo: &Value, manifest: &Value) -> Option<Wiki> {
    if text(manifest, "kind") != WIKI_MANIFEST_KIND {
        return None;
    }
    let name = text(repo, "name");
    let id = opt_text(manifest, "id")
        .unwrap_or(name)
        .trim()
        .trim_matches('/')
        .to_string();
    if id.is_empty() || id.contains('/') {
        return None;
    }
    Some(Wiki {
        title: opt_text(manifest, "title")
            .map(|title| title.trim().to_string())
            .unwrap_or_else(|| title_from(&id)),
        id,
        repo: text(repo, "repo").to_string(),
        updated_at: number(repo, "updatedAt"),
    })
}

async fn wikis(client: &KernelClient) -> Result<Vec<Wiki>, DynError> {
    let repos = call(client, "repo.list", json!({})).await?;
    let mut found = Vec::new();
    for repo in items(&repos, "repos") {
        let read = call(
            client,
            "repo.read",
            json!({ "repo": text(repo, "repo"), "path": "wiki.json" }),
        )
        .await;
        let Ok(read) = read else { continue };
        if text(&read, "kind") != "file" {
            continue;
        }
        let Some(manifest) = opt_text(&read, "content")
            .and_then(|content| serde_json::from_str::<Value>(content).ok())
        else {
            continue;
        };
        if let Some(wiki) = manifest_wiki(repo, &manifest) {
            found.push(wiki);
        }
    }
    found.sort_by_key(|wiki| wiki.title.to_lowercase());
    Ok(found)
}

fn find_wiki<'a>(wikis: &'a [Wiki], id: &str) -> Option<&'a Wiki> {
    let id = id.trim().trim_matches('/');
    wikis
        .iter()
        .find(|wiki| wiki.id == id || wiki.repo == id || wiki.repo.ends_with(&format!("/{id}")))
}

/// `notes/ideas.md` means page `ideas.md` in wiki `notes`; a bare id means
/// its `index.md`.
fn split_page<'a>(wikis: &'a [Wiki], page: &str) -> Result<(&'a Wiki, String), DynError> {
    let page = page.trim().trim_matches('/');
    let mut parts = page.splitn(2, '/');
    let id = parts.next().unwrap_or_default();
    let rest = parts.next().unwrap_or_default();
    let wiki = find_wiki(wikis, id)
        .ok_or_else(|| format!("No wiki is called `{id}`. See them with: gsv memory"))?;
    let path = if rest.is_empty() {
        "index.md".to_string()
    } else {
        rest.to_string()
    };
    Ok((wiki, path))
}

async fn standing(client: &KernelClient) -> Result<Vec<(String, String)>, DynError> {
    let home = remote::me(client)?.home.clone();
    let folder = format!("{}/context.d", home.trim_end_matches('/'));
    let (listing, _) = match remote::read_path(client, json!({ "path": folder })).await {
        Ok(listing) => listing,
        Err(_) => return Ok(Vec::new()),
    };
    let mut names: Vec<String> = items(&listing, "files")
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    names.sort();
    let mut notes = Vec::new();
    for name in names {
        let path = format!("{folder}/{name}");
        let (_, body) = remote::read_path(client, json!({ "path": path })).await?;
        notes.push((
            name,
            String::from_utf8_lossy(&body.unwrap_or_default()).into_owned(),
        ));
    }
    Ok(notes)
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    action: Option<MemoryAction>,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let style = out.style;
    match action {
        None => {
            let wikis = wikis(&client).await?;
            let notes = standing(&client).await?;
            if out.json {
                return render::print_json(&json!({
                    "wikis": wikis.iter().map(|wiki| json!({
                        "id": wiki.id, "title": wiki.title, "repo": wiki.repo, "updatedAt": wiki.updated_at,
                    })).collect::<Vec<_>>(),
                    "standing": notes.iter().map(|(name, _)| name).collect::<Vec<_>>(),
                }));
            }
            let now = render::now_ms();
            print!(
                "{}",
                render::heading(&style, "Wikis", Some(&wikis.len().to_string()))
            );
            if wikis.is_empty() {
                print!(
                    "{}",
                    render::empty(
                        &style,
                        "No wikis yet.",
                        Some(
                            "Ask your Ship to start one: gsv ship \"start a wiki for my recipes\""
                        )
                    )
                );
            } else {
                let mut table = Table::bare().flex(1);
                for wiki in &wikis {
                    table.row(vec![
                        Cell::new(&wiki.id, Tone::Accent),
                        Cell::new(&wiki.title, Tone::Strong),
                        Cell::new(
                            wiki.updated_at
                                .map(|at| format!("updated {}", render::relative_time(at, now)))
                                .unwrap_or_default(),
                            Tone::Dim,
                        ),
                    ]);
                }
                print!("{}", table.render(&style));
                print!(
                    "{}",
                    render::hint(
                        &style,
                        "Read one: gsv memory read ID/PAGE.md · Search: gsv memory search WORDS"
                    )
                );
            }
            println!();
            print!(
                "{}",
                render::heading(
                    &style,
                    "Standing notes",
                    Some(&render::count(
                        notes.len(),
                        "note your Ship always reads",
                        "notes your Ship always reads"
                    ))
                )
            );
            if notes.is_empty() {
                print!("{}", render::empty(&style, "None yet.", None));
            } else {
                print!("{}", render::hint(&style, "Show them: gsv memory standing"));
            }
            Ok(())
        }
        Some(MemoryAction::Read { page }) => {
            let wikis = wikis(&client).await?;
            let (wiki, path) = split_page(&wikis, &page)?;
            let read = call(
                &client,
                "repo.read",
                json!({ "repo": wiki.repo, "path": path }),
            )
            .await?;
            if out.json {
                return render::print_json(&read);
            }
            if text(&read, "kind") == "tree" {
                print!(
                    "{}",
                    render::heading(&style, &format!("{}/{}", wiki.id, path), None)
                );
                let mut table = Table::bare();
                for entry in items(&read, "entries") {
                    let name = text(entry, "name");
                    table.row(vec![if text(entry, "type") == "tree" {
                        Cell::new(format!("{name}/"), Tone::Accent)
                    } else {
                        name.into()
                    }]);
                }
                print!("{}", table.render(&style));
                return Ok(());
            }
            match opt_text(&read, "content") {
                Some(content) if !remote::flag(&read, "isBinary") => {
                    println!("{}", content.trim_end());
                    Ok(())
                }
                _ => Err(format!("{page} isn't a text page").into()),
            }
        }
        Some(MemoryAction::Search { query, wiki }) => {
            let wikis = wikis(&client).await?;
            let selected: Vec<&Wiki> = match &wiki {
                Some(id) => {
                    vec![find_wiki(&wikis, id).ok_or_else(|| format!("No wiki is called `{id}`"))?]
                }
                None => wikis.iter().collect(),
            };
            let mut results = Vec::new();
            for wiki in selected {
                let found = call(
                    &client,
                    "repo.search",
                    json!({ "repo": wiki.repo, "query": query }),
                )
                .await?;
                results.push((wiki, found));
            }
            if out.json {
                return render::print_json(&json!({
                    "query": query,
                    "results": results.iter().map(|(wiki, found)| json!({ "wiki": wiki.id, "result": found })).collect::<Vec<_>>(),
                }));
            }
            let total: usize = results
                .iter()
                .map(|(_, found)| items(found, "matches").len())
                .sum();
            if total == 0 {
                print!(
                    "{}",
                    render::empty(
                        &style,
                        &format!("Nothing in your wikis matches \"{query}\"."),
                        Some("Ask your Ship instead: gsv ship \"what do you know about …\"")
                    )
                );
                return Ok(());
            }
            print!(
                "{}",
                render::heading(
                    &style,
                    &format!("\"{query}\""),
                    Some(&render::count(total, "match", "matches"))
                )
            );
            let mut table = Table::bare().flex(1);
            for (wiki, found) in &results {
                for hit in items(found, "matches") {
                    table.row(vec![
                        Cell::new(
                            format!(
                                "{}/{}:{}",
                                wiki.id,
                                text(hit, "path"),
                                number(hit, "line").unwrap_or_default()
                            ),
                            Tone::Accent,
                        ),
                        text(hit, "content").trim().into(),
                    ]);
                }
            }
            print!("{}", table.render(&style));
            Ok(())
        }
        Some(MemoryAction::Standing) => {
            let notes = standing(&client).await?;
            if out.json {
                return render::print_json(&json!({
                    "notes": notes.iter().map(|(name, content)| json!({ "name": name, "content": content })).collect::<Vec<_>>(),
                }));
            }
            if notes.is_empty() {
                print!("{}", render::empty(&style, "No standing notes.", Some("Tell your Ship something to always remember: gsv ship \"remember that …\"")));
                return Ok(());
            }
            for (index, (name, content)) in notes.iter().enumerate() {
                if index > 0 {
                    println!();
                }
                println!("{}", style.strong(name));
                println!("{}", content.trim_end());
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wikis_come_from_manifests_and_pages_default_to_the_index() {
        let repo = json!({ "repo": "esteve/recipes", "name": "recipes", "updatedAt": 1 });
        assert!(manifest_wiki(&repo, &json!({ "kind": "other" })).is_none());
        let wiki = manifest_wiki(&repo, &json!({ "kind": "gsv.wiki" })).expect("wiki");
        assert_eq!(
            (wiki.id.as_str(), wiki.title.as_str()),
            ("recipes", "Recipes")
        );
        let named = manifest_wiki(
            &repo,
            &json!({ "kind": "gsv.wiki", "id": "food", "title": "Food & drink" }),
        )
        .expect("named");
        let wikis = vec![wiki, named];
        let (found, path) = split_page(&wikis, "food/pasta/carbonara.md").expect("page");
        assert_eq!(
            (found.id.as_str(), path.as_str()),
            ("food", "pasta/carbonara.md")
        );
        let (found, path) = split_page(&wikis, "recipes").expect("index");
        assert_eq!((found.id.as_str(), path.as_str()), ("recipes", "index.md"));
        split_page(&wikis, "nope/x.md").expect_err("rejected");
        assert_eq!(title_from("my-travel_notes"), "My Travel Notes");
    }
}
